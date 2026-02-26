/* public/client.js */
"use strict";

/* =========================
   Small helpers
========================= */
const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
  console.log("[STATUS]", msg);
}

function appendChatLine(text) {
  const box = $("chatMessages");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "msg";
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function clamp(n, a, b) {
  n = Number(n) || 0;
  return Math.max(a, Math.min(b, n));
}

/* =========================
   Socket.io
========================= */
const socket = io();

socket.on("connect", () => {
  console.log("SOCKET CONNECTED", socket.id);
});

socket.on("connect_error", (e) => {
  console.error("SOCKET CONNECT ERROR:", e?.message || e);
  setStatus("❌ Ошибка соединения (socket).");
});

/* =========================
   DOM (IDs must exist in HTML)
   If your HTML uses other IDs — rename here.
========================= */
const joinBtn = $("joinBtn");
const leaveBtn = $("leaveBtn");
const roomIdEl = $("roomId");
const usernameEl = $("username");

const videoUrlEl = $("videoUrl");
const loadBtn = $("loadBtn");

const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

const inviteBtn = $("inviteBtn");

/* =========================
   State
========================= */
let currentRoomId = "";
let isHost = false;
let hostSocketId = null;

let player = null;
let playerReady = false;
let currentVideoId = null;

// protect from loops (stateChange -> emit -> receive -> stateChange)
let suppressLocalEvents = false;

// pending commands before player ready
let pendingLoad = null;  // { videoId, positionSec, isPlaying }
let pendingSeek = null;  // number
let pendingPlay = null;  // number
let pendingPause = null; // number

/* =========================
   Sync tuning (anti-stops)
========================= */
const SOFT_SYNC_THRESHOLD = 0.8; // small drift -> playback rate
const SYNC_THRESHOLD = 1.2;      // medium drift -> rare seek
const HARD_SYNC_THRESHOLD = 4.0; // big drift -> hard seek

const SEEK_COOLDOWN_MS = 2500;   // anti-spam for seek
let lastSyncApplyAt = 0;

const RATE_ADJUST_MS = 1500;     // how long to keep adjusted speed
let rateResetTimer = null;

// Host sends timecode regularly
const HOST_SYNC_INTERVAL_MS = 1200;
let hostSyncTimer = null;

/* =========================
   YouTube utils
========================= */
function safeGetTime() {
  try {
    if (!player || !player.getCurrentTime) return 0;
    const t = player.getCurrentTime();
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function seekTo(targetSec) {
  try {
    if (!player || !player.seekTo) return;
    player.seekTo(Math.max(0, Number(targetSec) || 0), true);
  } catch (e) {
    console.warn("seekTo error:", e);
  }
}

function play() {
  try {
    if (!player || !player.playVideo) return;
    player.playVideo();
  } catch (e) {
    console.warn("play error:", e);
  }
}

function pause() {
  try {
    if (!player || !player.pauseVideo) return;
    player.pauseVideo();
  } catch (e) {
    console.warn("pause error:", e);
  }
}

function setRateSafe(rate) {
  try {
    if (!player || !player.setPlaybackRate) return;
    if (!playerReady) return;

    player.setPlaybackRate(rate);

    if (rateResetTimer) clearTimeout(rateResetTimer);
    rateResetTimer = setTimeout(() => {
      try {
        if (player && player.setPlaybackRate) player.setPlaybackRate(1);
      } catch {}
    }, RATE_ADJUST_MS);
  } catch {}
}

// Soft-sync function: seeks rarely, uses speed for tiny drift
function maybeSyncToTarget(target) {
  const cur = safeGetTime();
  const diff = (Number(target) || 0) - cur; // signed
  const abs = Math.abs(diff);

  // Big drift -> rare hard seek
  if (abs > HARD_SYNC_THRESHOLD) {
    const now = Date.now();
    if (now - lastSyncApplyAt > SEEK_COOLDOWN_MS) {
      lastSyncApplyAt = now;
      setRateSafe(1);
      seekTo(target);
    }
    return;
  }

  // Medium drift -> rare seek
  if (abs > SYNC_THRESHOLD) {
    const now = Date.now();
    if (now - lastSyncApplyAt > SEEK_COOLDOWN_MS) {
      lastSyncApplyAt = now;
      setRateSafe(1);
      seekTo(target);
    }
    return;
  }

  // Small drift -> speed adjust, NO seek
  if (abs > SOFT_SYNC_THRESHOLD) {
    setRateSafe(diff > 0 ? 1.05 : 0.95);
  } else {
    setRateSafe(1);
  }
}

/* =========================
   Pending apply
========================= */
function applyIfReady() {
  if (!player || !playerReady) return;

  if (pendingLoad) {
    const { videoId, positionSec, isPlaying } = pendingLoad;
    try {
      suppressLocalEvents = true;
      player.loadVideoById(videoId, positionSec || 0);
      if (!isPlaying) player.pauseVideo();
      currentVideoId = videoId;
    } catch (e) {
      console.warn("pendingLoad error:", e);
    } finally {
      suppressLocalEvents = false;
      pendingLoad = null;
    }
  }

  if (pendingSeek !== null) {
    suppressLocalEvents = true;
    seekTo(pendingSeek);
    suppressLocalEvents = false;
    pendingSeek = null;
  }

  if (pendingPlay !== null) {
    suppressLocalEvents = true;
    maybeSyncToTarget(pendingPlay);
    play();
    suppressLocalEvents = false;
    pendingPlay = null;
  }

  if (pendingPause !== null) {
    suppressLocalEvents = true;
    maybeSyncToTarget(pendingPause);
    pause();
    suppressLocalEvents = false;
    pendingPause = null;
  }
}

/* =========================
   Parse YouTube ID
========================= */
function parseYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s) return "";

  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  try {
    const url = new URL(s);

    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace("/", "").slice(0, 11);
    }

    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v.slice(0, 11);

      const parts = url.pathname.split("/").filter(Boolean);
      const shortsIdx = parts.indexOf("shorts");
      if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1].slice(0, 11);

      const embedIdx = parts.indexOf("embed");
      if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1].slice(0, 11);
    }
  } catch {}

  return "";
}

/* =========================
   YouTube API + Player init
========================= */
function ensureYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();

    const existing = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }

    window.onYouTubeIframeAPIReady = () => resolve();
  });
}

async function ensurePlayer() {
  if (player) return;

  await ensureYouTubeAPI();

  player = new YT.Player("player", {
    height: "360",
    width: "100%",
    videoId: "",
    playerVars: {
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
    },
    events: {
      onReady: () => {
        playerReady = true;
        setStatus("✅ Плеер готов.");
        applyIfReady();

        // allow attributes (helps mobile)
        try {
          const iframe = player.getIframe();
          if (iframe) {
            iframe.setAttribute("allowfullscreen", "");
            iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
            iframe.style.width = "100%";
            iframe.style.height = "100%";
          }
        } catch {}
      },

      onStateChange: (e) => {
        // Only host emits, and never when suppressed
        if (!currentRoomId || !isHost || suppressLocalEvents) return;

        // 1=playing, 2=paused
        if (e.data === 1) {
          socket.emit("video-play", { time: safeGetTime() });
        } else if (e.data === 2) {
          socket.emit("video-pause", { time: safeGetTime() });
        }
      },
    },
  });
}

/* =========================
   Host sync loop
========================= */
function stopHostSyncLoop() {
  if (hostSyncTimer) clearInterval(hostSyncTimer);
  hostSyncTimer = null;
}

function startHostSyncLoop() {
  stopHostSyncLoop();
  if (!isHost) return;

  hostSyncTimer = setInterval(() => {
    if (!currentRoomId || !playerReady) return;
    // send a "soft sync" timecode to server/room
    socket.emit("sync-time", {
      time: safeGetTime(),
      isPlaying: isActuallyPlaying(),
      videoId: currentVideoId || null,
    });
  }, HOST_SYNC_INTERVAL_MS);
}

function isActuallyPlaying() {
  try {
    if (!player || !player.getPlayerState) return false;
    return player.getPlayerState() === 1;
  } catch {
    return false;
  }
}

/* =========================
   UI actions
========================= */
function getRoomIdFromUrl() {
  // supports /room/1234 in path
  const m = window.location.pathname.match(/\/room\/(\d+)/);
  if (m && m[1]) return m[1];
  return "";
}

function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name) || "";
}

function isCreatorFromUrl() {
  const u = new URL(window.location.href);
  return u.searchParams.get("asCreator") === "1";
}

function normalizeRoomId(s) {
  s = String(s || "").trim();
  // only digits
  s = s.replace(/\D/g, "");
  return s;
}

async function joinRoom() {
  const rid = normalizeRoomId(roomIdEl?.value || getRoomIdFromUrl());
  const uname = String(usernameEl?.value || getQueryParam("name") || "user").trim().slice(0, 20);

  if (!rid) return setStatus("❌ Введи ID комнаты (только цифры).");
  if (!uname) return setStatus("❌ Введи имя.");

  await ensurePlayer();

  currentRoomId = rid;
  isHost = isCreatorFromUrl(); // provisional, server may override
  stopHostSyncLoop();

  socket.emit("join-room", { roomId: rid, username: uname, asCreator: isCreatorFromUrl() ? 1 : 0 });

  if (leaveBtn) leaveBtn.disabled = false;
  if (joinBtn) joinBtn.disabled = true;
  if (roomIdEl) roomIdEl.disabled = true;
  if (usernameEl) usernameEl.disabled = true;

  setStatus("⏳ Подключение к комнате...");
}

function leaveRoom() {
  if (!currentRoomId) return;
  socket.emit("leave-room");

  currentRoomId = "";
  isHost = false;
  hostSocketId = null;
  stopHostSyncLoop();

  if (leaveBtn) leaveBtn.disabled = true;
  if (joinBtn) joinBtn.disabled = false;
  if (roomIdEl) roomIdEl.disabled = false;
  if (usernameEl) usernameEl.disabled = false;

  setStatus("✅ Ты вышел из комнаты.");
}

function loadVideoAsHost() {
  if (!currentRoomId) return setStatus("❌ Сначала войди в комнату.");
  if (!isHost) return setStatus("❌ Загружать видео может только HOST.");

  const id = parseYouTubeId(videoUrlEl?.value || "");
  if (!id) return setStatus("❌ Вставь нормальную ссылку YouTube или ID (11 символов).");

  currentVideoId = id;

  // tell server/room
  socket.emit("video-load", { videoId: id });

  // local load
  if (!playerReady) {
    pendingLoad = { videoId: id, positionSec: 0, isPlaying: false };
    setStatus("⏳ Ждём готовности плеера...");
    return;
  }

  suppressLocalEvents = true;
  try {
    player.loadVideoById(id, 0);
    player.pauseVideo(); // user will press play
  } finally {
    suppressLocalEvents = false;
  }

  setStatus("✅ Видео загружено (HOST). Нажми Play.");
}

function sendChat() {
  if (!currentRoomId) return;
  const text = String(chatInput?.value || "").trim();
  if (!text) return;
  socket.emit("chat-msg", { text });
  chatInput.value = "";
}

async function copyInviteLink() {
  if (!currentRoomId) return setStatus("❌ Сначала войди в комнату.");

  const uname = String(usernameEl?.value || "user").trim();
  const url = new URL(window.location.href);
  url.pathname = `/room/${currentRoomId}`;
  url.searchParams.set("name", uname || "user");
  url.searchParams.delete("asCreator"); // invite as viewer

  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("✅ Ссылка скопирована.");
  } catch {
    setStatus("❌ Не удалось скопировать (разреши доступ).");
  }
}

if (joinBtn) joinBtn.addEventListener("click", joinRoom);
if (leaveBtn) leaveBtn.addEventListener("click", leaveRoom);
if (loadBtn) loadBtn.addEventListener("click", loadVideoAsHost);
if (chatSendBtn) chatSendBtn.addEventListener("click", sendChat);
if (chatInput) chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
if (inviteBtn) inviteBtn.addEventListener("click", copyInviteLink);

/* =========================
   Socket handlers (room / roles / chat)
   I listen multiple possible names to fit your server.
========================= */

// Generic room state updater
function applyRoomState(state) {
  // expected: { hostSocketId, videoId, playing, time }
  if (!state) return;

  if (state.hostSocketId !== undefined) hostSocketId = state.hostSocketId;
  if (state.isHost !== undefined) isHost = !!state.isHost;

  // if server sends role by comparing socket id
  if (hostSocketId && socket.id) {
    isHost = (hostSocketId === socket.id) || isHost;
  }

  // Host starts loop
  if (isHost) startHostSyncLoop();
  else stopHostSyncLoop();

  // If video is set
  if (state.videoId && state.videoId !== currentVideoId) {
    currentVideoId = state.videoId;
    const t = Number(state.time || 0);
    const playing = !!state.playing;

    if (!playerReady) {
      pendingLoad = { videoId: state.videoId, positionSec: t, isPlaying: playing };
    } else {
      suppressLocalEvents = true;
      try {
        player.loadVideoById(state.videoId, t);
        if (!playing) player.pauseVideo();
      } finally {
        suppressLocalEvents = false;
      }
    }
  }
}

// Server confirms join
socket.on("room-joined", (payload) => {
  // payload can be { roomId, hostSocketId, isHost, state }
  console.log("room-joined", payload);
  setStatus("✅ В комнате.");
  if (payload?.hostSocketId) hostSocketId = payload.hostSocketId;
  if (payload?.isHost !== undefined) isHost = !!payload.isHost;

  if (payload?.state) applyRoomState(payload.state);
  else applyRoomState(payload);
});

socket.on("joined-room", (payload) => {
  console.log("joined-room", payload);
  setStatus("✅ В комнате.");
  if (payload?.hostSocketId) hostSocketId = payload.hostSocketId;
  if (payload?.isHost !== undefined) isHost = !!payload.isHost;
  if (payload?.state) applyRoomState(payload.state);
  else applyRoomState(payload);
});

socket.on("room-state", (state) => {
  console.log("room-state", state);
  applyRoomState(state);
});

socket.on("room-error", (msg) => {
  setStatus("❌ " + (msg || "Ошибка комнаты"));
});

// Chat
socket.on("chat-msg", (p) => {
  const from = p?.from ? `${p.from}: ` : "";
  appendChatLine(from + (p?.text || ""));
});

socket.on("system-msg", (p) => {
  appendChatLine("• " + (p?.text || p || ""));
});

/* =========================
   VIDEO EVENTS from server -> viewers apply
========================= */
socket.on("video-load", ({ videoId }) => {
  if (!currentRoomId) return;
  if (!videoId) return;

  currentVideoId = videoId;

  if (!playerReady) {
    pendingLoad = { videoId, positionSec: 0, isPlaying: false };
    setStatus("⏳ Ждём плеер...");
    return;
  }

  suppressLocalEvents = true;
  try {
    player.loadVideoById(videoId, 0);
    player.pauseVideo();
  } finally {
    suppressLocalEvents = false;
  }

  setStatus("✅ Видео загружено.");
});

socket.on("video-play", ({ time }) => {
  if (!currentRoomId) return;
  if (isHost) return; // host already controls

  const target = Number(time || 0);

  if (!playerReady) {
    pendingPlay = target;
    return;
  }

  suppressLocalEvents = true;
  try {
    maybeSyncToTarget(target);
    play();
  } finally {
    suppressLocalEvents = false;
  }
});

socket.on("video-pause", ({ time }) => {
  if (!currentRoomId) return;
  if (isHost) return;

  const target = Number(time || 0);

  if (!playerReady) {
    pendingPause = target;
    return;
  }

  suppressLocalEvents = true;
  try {
    maybeSyncToTarget(target);
    pause();
  } finally {
    suppressLocalEvents = false;
  }
});

socket.on("video-seek", ({ time }) => {
  if (!currentRoomId) return;
  if (isHost) return;

  const target = Number(time || 0);

  if (!playerReady) {
    pendingSeek = target;
    return;
  }

  suppressLocalEvents = true;
  try {
    // seek should be immediate, but still protected by anti-spam logic
    seekTo(target);
  } finally {
    suppressLocalEvents = false;
  }
});

/* =========================
   Soft sync timecodes (host -> server -> viewers)
   Event name variants: "sync-time" or "sync-state"
========================= */
function onSyncTime(payload) {
  if (!currentRoomId) return;
  if (isHost) return;

  if (!payload) return;

  // if server sends { time, isPlaying, videoId }
  const t = Number(payload.time || 0);
  const playing = !!payload.isPlaying;
  const vid = payload.videoId || null;

  // if video changed
  if (vid && vid !== currentVideoId) {
    currentVideoId = vid;
    if (!playerReady) {
      pendingLoad = { videoId: vid, positionSec: t, isPlaying: playing };
      return;
    }
    suppressLocalEvents = true;
    try {
      player.loadVideoById(vid, t);
      if (!playing) player.pauseVideo();
    } finally {
      suppressLocalEvents = false;
    }
    return;
  }

  if (!playerReady) return;

  // key: DO NOT pause/play here often, only sync time softly
  maybeSyncToTarget(t);

  // If server says paused and we are playing: pause once (rare)
  if (!playing && isActuallyPlaying()) {
    suppressLocalEvents = true;
    try { pause(); } finally { suppressLocalEvents = false; }
  }
}

socket.on("sync-time", onSyncTime);
socket.on("sync-state", onSyncTime);



/* =========================
   Auto-fill from URL on page load
========================= */
(function initFromUrl() {
  const rid = getRoomIdFromUrl();
  const name = getQueryParam("name");
  if (rid && roomIdEl && !roomIdEl.value) roomIdEl.value = rid;
  if (name && usernameEl && !usernameEl.value) usernameEl.value = name;

  // prepare player early
  ensurePlayer().catch(() => {});
})();