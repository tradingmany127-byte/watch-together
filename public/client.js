/* public/client.js */

/* ========= Helpers / DOM ========= */
const $ = (id) => document.getElementById(id);

const roomIdEl = $("roomId");
const usernameEl = $("username");
const joinBtn = $("joinBtn");
const leaveBtn = $("leaveBtn");

const videoUrlEl = $("videoUrl");
const loadBtn = $("loadBtn");
const statusEl = $("status");

const playerContainer = $("player-container") || $("player") || $("playerContainer") || $("playerWrap");
const logsEl = $("logs");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");
const chatBox = $("chatBox");
const inviteBtn = $("inviteBtn");

/* ========= UI ========= */
function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.opacity = "1";
  statusEl.style.color = isError ? "#ff6b6b" : "";
}
function logLine(text) {
  if (!logsEl) return;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  const line = document.createElement("div");
  line.textContent = `[${hh}:${mm}:${ss}] ${text}`;
  logsEl.prepend(line);
}

/* ========= Socket ========= */
const socket = io();

let currentRoomId = null;
let myName = "Guest";
let isHost = false;

/* server truth */
let serverVideoId = null;
let serverPlaying = false;
let serverTime = 0;           // seconds (server-estimated)
let serverUpdatedAt = 0;      // Date.now ms

function serverNowTime() {
  if (!serverPlaying) return serverTime || 0;
  const dt = (Date.now() - (serverUpdatedAt || Date.now())) / 1000;
  return (serverTime || 0) + dt;
}

/* ========= YouTube Player ========= */
let player = null;
let playerReady = false;
let suppressLocal = false;

function loadYouTubeAPI() {
  return new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    const exists = document.querySelector('script[src*="youtube.com/iframe_api"]');
    if (!exists) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (window.YT && window.YT.Player) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > 15000) {
        clearInterval(timer);
        reject(new Error("YT API не загрузился за 15 сек"));
      }
    }, 50);
  });
}

async function ensurePlayer() {
  if (player) return;
  if (!playerContainer) throw new Error("Нет контейнера для плеера (#player-container)");
  await loadYouTubeAPI();

  playerReady = false;

  // чистим контейнер
  playerContainer.innerHTML = "";
  const div = document.createElement("div");
  div.id = "yt-player";
  playerContainer.appendChild(div);

  player = new YT.Player("yt-player", {
    width: "100%",
    height: "100%",
    videoId: serverVideoId || "",
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1, // важно для iOS (иначе может вести себя странно)
    },
    events: {
      onReady: () => {
        playerReady = true;
        try {
          // максимум разрешений для fullscreen на мобиле
          const iframe = player.getIframe();
          iframe.setAttribute("allowfullscreen", "1");
          iframe.setAttribute(
            "allow",
            "autoplay; encrypted-media; fullscreen; picture-in-picture"
          );
          iframe.style.width = "100%";
          iframe.style.height = "100%";
          iframe.style.border = "0";
        } catch (e) {}
        setStatus("Плеер готов ✅");
      },
      onStateChange: (e) => {
        // Если мы сейчас применяем команды от сервера — не шлем обратно
        if (suppressLocal) return;
        if (!isHost) return; // ВАЖНО: только хост управляет

        // 1 = playing, 2 = paused
        if (e.data === YT.PlayerState.PLAYING) {
          socket.emit("video-play", { roomId: currentRoomId, time: safeGetTime() });
          logLine(`HOST ▶ play @ ${safeGetTime().toFixed(1)}s`);
        } else if (e.data === YT.PlayerState.PAUSED) {
          socket.emit("video-pause", { roomId: currentRoomId, time: safeGetTime() });
          logLine(`HOST ⏸ pause @ ${safeGetTime().toFixed(1)}s`);
        }
      },
    },
  });
}

function safeGetTime() {
  try {
    if (!playerReady || !player || !player.getCurrentTime) return 0;
    const t = Number(player.getCurrentTime());
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function safeSeekTo(t) {
  try {
    if (!playerReady || !player || !player.seekTo) return;
    player.seekTo(Number(t) || 0, true);
  } catch (e) {}
}

function safePlay() {
  try {
    if (!playerReady || !player) return;
    player.playVideo();
  } catch (e) {}
}

function safePause() {
  try {
    if (!playerReady || !player) return;
    player.pauseVideo();
  } catch (e) {}
}

/* ========= Fullscreen helper ========= */
function ensureFullscreenButton() {
  // если уже есть — не дублируем
  if (document.getElementById("fsBtn")) return;

  const btn = document.createElement("button");
  btn.id = "fsBtn";
  btn.textContent = "⛶ Fullscreen";
  btn.style.cssText =
    "margin-top:10px;padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;";
  btn.onclick = () => {
    try {
      const iframe = player?.getIframe?.();
      const target = iframe || playerContainer;
      if (!target) return;

      // стандартный Fullscreen API
      const req =
        target.requestFullscreen ||
        target.webkitRequestFullscreen ||
        target.mozRequestFullScreen ||
        target.msRequestFullscreen;

      if (req) req.call(target);
      else {
        // fallback: открыть видео в новой вкладке (на iOS часто спасает)
        const url = player?.getVideoUrl?.();
        if (url) window.open(url, "_blank");
      }
    } catch (e) {}
  };

  playerContainer?.parentElement?.appendChild(btn);
}

/* ========= Parse YouTube ID ========= */
function parseYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s) return "";

  // Уже ID?
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  try {
    const url = new URL(s);
    const host = url.hostname.replace("www.", "");
    if (host === "youtu.be") {
      const id = url.pathname.replace("/", "");
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : "";
    }
    if (host.includes("youtube.com")) {
      // watch?v=
      const v = url.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      // shorts/
      const parts = url.pathname.split("/").filter(Boolean);
      const si = parts.indexOf("shorts");
      if (si >= 0 && parts[si + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[si + 1])) return parts[si + 1];

      // embed/
      const ei = parts.indexOf("embed");
      if (ei >= 0 && parts[ei + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[ei + 1])) return parts[ei + 1];
    }
  } catch (e) {}

  return "";
}

/* ========= Sync (anti-stop) ========= */
const SOFT_SYNC_THRESHOLD = 0.6;  // маленький дрейф → лечим скоростью
const SYNC_THRESHOLD = 1.2;       // средний дрейф → редкий seek
const HARD_SYNC_THRESHOLD = 4.0;  // большой дрейф → seek обязательно

const RATE_ADJUST_MS = 1200;
let rateResetTimer = null;

function setRateSafe(r) {
  try {
    if (!playerReady || !player || !player.setPlaybackRate) return;
    // YouTube иногда не принимает слишком часто
    player.setPlaybackRate(r);
    if (rateResetTimer) clearTimeout(rateResetTimer);
    rateResetTimer = setTimeout(() => {
      try { player.setPlaybackRate(1); } catch (e) {}
    }, RATE_ADJUST_MS);
  } catch (e) {}
}

let lastSyncApplyAt = 0;

function applyServerState() {
  if (!playerReady || !player || !serverVideoId) return;

  // 1) время/состояние с сервера
  const target = serverNowTime();
  const cur = safeGetTime();
  const diff = target - cur;
  const abs = Math.abs(diff);

  // 2) play/pause приводим к серверу (но без спама)
  suppressLocal = true;
  try {
    if (serverPlaying) safePlay();
    else safePause();
  } finally {
    setTimeout(() => (suppressLocal = false), 0);
  }

  const now = Date.now();

  // 3) Большой улёт — жёсткий seek (редко)
  if (abs > HARD_SYNC_THRESHOLD) {
    if (now - lastSyncApplyAt > 2500) {
      lastSyncApplyAt = now;
      suppressLocal = true;
      try { safeSeekTo(target); } finally { setTimeout(() => (suppressLocal = false), 0); }
    }
    return;
  }

  // 4) Средний улёт — seek (редко)
  if (abs > SYNC_THRESHOLD) {
    if (now - lastSyncApplyAt > 2500) {
      lastSyncApplyAt = now;
      suppressLocal = true;
      try { safeSeekTo(target); } finally { setTimeout(() => (suppressLocal = false), 0); }
    }
    return;
  }

  // 5) Малый дрейф — подгон скоростью
  if (abs > SOFT_SYNC_THRESHOLD) {
    setRateSafe(diff > 0 ? 1.05 : 0.95);
  } else {
    setRateSafe(1);
  }
}

/* ========= Host-only: detect manual seeks & send sync ========= */
let hostLastT = 0;
let hostTicker = null;

function startHostTicker() {
  stopHostTicker();
  hostLastT = safeGetTime();

  hostTicker = setInterval(() => {
    if (!isHost || !currentRoomId || !playerReady || !player) return;

    const t = safeGetTime();
    const dt = Math.abs(t - hostLastT);

    // если прыжок времени > 1 сек — это ручной seek
    if (dt > 1.0) {
      socket.emit("video-seek", { roomId: currentRoomId, time: t });
      logLine(`HOST ⏩ seek @ ${t.toFixed(1)}s`);
    }

    // периодический sync-time (как “маяк”)
    socket.emit("sync-time", {
      roomId: currentRoomId,
      time: t,
      playing: (player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING) || false,
    });

    hostLastT = t;
  }, 900);
}

function stopHostTicker() {
  if (hostTicker) clearInterval(hostTicker);
  hostTicker = null;
}

/* ========= Socket handlers ========= */
socket.on("connect", () => {
  setStatus("Socket подключён ✅");
});

socket.on("disconnect", () => {
  setStatus("Socket отключён ❌", true);
  isHost = false;
  stopHostTicker();
});

socket.on("not-host", (p) => {
  logLine(`⛔ Не HOST: действие "${p?.action || "unknown"}" запрещено`);
});

socket.on("host-changed", (p = {}) => {
  isHost = (p.hostSocketId === socket.id);
  setStatus(isHost ? "Ты HOST ✅" : "Ты viewer");
  logLine(isHost ? "Ты стал HOST" : "HOST сменился");
  if (isHost) startHostTicker();
  else stopHostTicker();
});

// Универсально: если сервер шлёт состояние комнаты
socket.on("room-state", async (state = {}) => {
  if (!state) return;

  currentRoomId = String(state.roomId || currentRoomId || "");
  serverVideoId = state.videoId || serverVideoId || null;
  serverPlaying = !!state.playing;
  serverTime = Number(state.time || 0) || 0;
  serverUpdatedAt = Date.now();

  // hostSocketId → isHost
  if (state.hostSocketId) {
    isHost = (state.hostSocketId === socket.id);
    if (isHost) startHostTicker();
    else stopHostTicker();
  }

  if (serverVideoId) {
    await ensurePlayer();
    ensureFullscreenButton();

    // если у плеера другой ролик — загрузим его (без autoplay)
    try {
      const curId = player.getVideoData?.()?.video_id;
      if (curId !== serverVideoId) {
        suppressLocal = true;
        try {
          player.cueVideoById(serverVideoId);
        } finally {
          setTimeout(() => (suppressLocal = false), 0);
        }
      }
    } catch (e) {}

    // применяем синхронизацию
    applyServerState();
  }
});

// Backward compatible: старые эвенты
socket.on("video-load", async (p = {}) => {
  serverVideoId = p.videoId || serverVideoId;
  serverPlaying = !!p.playing;
  serverTime = Number(p.time || 0) || 0;
  serverUpdatedAt = Date.now();

  await ensurePlayer();
  ensureFullscreenButton();

  suppressLocal = true;
  try {
    player.cueVideoById(serverVideoId);
    safeSeekTo(serverTime);
    serverPlaying ? safePlay() : safePause();
  } finally {
    setTimeout(() => (suppressLocal = false), 0);
  }
  logLine(`📺 Load: ${serverVideoId}`);
});

socket.on("video-play", (p = {}) => {
  serverPlaying = true;
  serverTime = Number(p.time || serverNowTime()) || 0;
  serverUpdatedAt = Date.now();
  suppressLocal = true;
  try { safePlay(); } finally { setTimeout(() => (suppressLocal = false), 0); }
});

socket.on("video-pause", (p = {}) => {
  serverPlaying = false;
  serverTime = Number(p.time || safeGetTime()) || 0;
  serverUpdatedAt = Date.now();
  suppressLocal = true;
  try { safePause(); } finally { setTimeout(() => (suppressLocal = false), 0); }
});

socket.on("video-seek", (p = {}) => {
  serverTime = Number(p.time || 0) || 0;
  serverUpdatedAt = Date.now();
  suppressLocal = true;
  try { safeSeekTo(serverTime); } finally { setTimeout(() => (suppressLocal = false), 0); }
});

socket.on("sync-time", (p = {}) => {
  // сервер/хост маяк — обновим истину
  if (typeof p.time === "number") serverTime = p.time;
  if (typeof p.playing === "boolean") serverPlaying = p.playing;
  serverUpdatedAt = Date.now();
});

/* ========= Periodic apply sync for viewers ========= */
setInterval(() => {
  if (!currentRoomId) return;
  if (!playerReady || !player) return;
  if (!serverVideoId) return;
  // host сам “истина” и сам шлёт маяк — но тоже можно слегка подправлять
  applyServerState();
}, 1000);

/* ========= UI actions ========= */
async function joinRoom() {
  const rid = String(roomIdEl?.value || "").trim();
  if (!/^[0-9]{1,12}$/.test(rid)) {
    setStatus("RoomID только цифры (1-12)", true);
    return;
  }
  myName = String(usernameEl?.value || "Guest").trim() || "Guest";
  currentRoomId = rid;

  socket.emit("join-room", { roomId: rid, username: myName });
  setStatus(`В комнате ${rid}...`);
  logLine(`➡️ join ${rid} as ${myName}`);

  // попросим состояние (если сервер поддерживает)
  socket.emit("get-state", { roomId: rid });
}

function leaveRoom() {
  if (!currentRoomId) return;
  socket.emit("leave-room", { roomId: currentRoomId });
  logLine(`⬅️ leave ${currentRoomId}`);
  currentRoomId = null;
  isHost = false;
  stopHostTicker();
  setStatus("Вышел из комнаты");
}

async function loadVideo() {
  if (!currentRoomId) return setStatus("Сначала join room", true);
  if (!isHost) return setStatus("Только HOST может загружать видео", true);

  const id = parseYouTubeId(videoUrlEl?.value);
  if (!id) return setStatus("Неверная ссылка/ID YouTube", true);

  serverVideoId = id;
  serverPlaying = false;
  serverTime = 0;
  serverUpdatedAt = Date.now();

  await ensurePlayer();
  ensureFullscreenButton();

  suppressLocal = true;
  try {
    player.cueVideoById(id);
    safeSeekTo(0);
    safePause();
  } finally {
    setTimeout(() => (suppressLocal = false), 0);
  }

  socket.emit("video-load", { roomId: currentRoomId, videoId: id, time: 0, playing: false });
  logLine(`HOST 📺 load ${id}`);
  setStatus("Видео загружено (HOST)");
}

function inviteLink() {
  try {
    if (!currentRoomId) return;
    const url = new URL(window.location.href);
    // если у тебя room в URL /room/123 — оставляем как есть
    // но добавим query для удобства
    url.searchParams.set("room", currentRoomId);
    navigator.clipboard?.writeText(url.toString());
    logLine("🔗 Ссылка приглашения скопирована");
  } catch (e) {
    logLine("Не удалось скопировать ссылку");
  }
}

/* ========= Chat ========= */
function sendChat() {
  const msg = String(chatInput?.value || "").trim();
  if (!msg || !currentRoomId) return;
  socket.emit("chat-msg", { roomId: currentRoomId, msg, username: myName });
  chatInput.value = "";
}
socket.on("chat-msg", (p = {}) => {
  const line = document.createElement("div");
  line.textContent = `${p.username || "?"}: ${p.msg || ""}`;
  chatBox?.appendChild(line);
  chatBox?.scrollTo?.(0, chatBox.scrollHeight);
});

/* ========= Bind ========= */
joinBtn?.addEventListener("click", joinRoom);
leaveBtn?.addEventListener("click", leaveRoom);
loadBtn?.addEventListener("click", loadVideo);
inviteBtn?.addEventListener("click", inviteLink);

chatSendBtn?.addEventListener("click", sendChat);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

/* ========= Auto-join from URL (?room=) ========= */
(function autoJoinFromURL() {
  try {
    const u = new URL(window.location.href);
    const r = u.searchParams.get("room");
    if (r && roomIdEl) roomIdEl.value = r;
  } catch {}
})();