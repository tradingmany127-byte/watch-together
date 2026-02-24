/* public/client.js */

const socket = io();

const $ = (id) => document.getElementById(id);

const roomIdEl = $("roomId");
const usernameEl = $("username");
const joinBtn = $("joinBtn");
const hostBtn = $("hostBtn");
const voiceBtn = $("voiceBtn");
const leaveBtn = $("leaveBtn");

const ytLinkEl = $("ytLink");
const sendVideoBtn = $("sendVideoBtn");
const statusLine = $("statusLine");

const chatBox = $("chatBox");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

const settingsBtn = $("settingsBtn");
const settingsMenu = $("settingsMenu");
const copyInviteBtn = $("copyInviteBtn");
const autoSyncToggle = $("autoSyncToggle");

const videoOverlay = $("videoOverlay");

let currentRoomId = null;
let myRole = "viewer"; // viewer | host
let hostSocketId = null;

let player = null;
let currentVideoId = null;
let ignorePlayerEvents = false;
let autoSync = true;
let lastSeekSentAt = 0;

function setStatus(ok, text) {
  statusLine.textContent = (ok ? "✅ " : "❌ ") + text;
}

function getRoomId() {
  return String(roomIdEl.value || "").trim();
}
function getUsername() {
  return String(usernameEl.value || "").trim();
}

function parseYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  // if user pasted pure id
  if (/^[a-zA-Z0-9_-]{6,}$/.test(s) && !s.includes("http")) return s;

  try {
    const url = new URL(s);
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.replace("/", "") || null;
    }
    if (url.hostname.includes("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      // /embed/ID
      const m = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
  } catch (e) {}

  return null;
}

function isMeHost() {
  return myRole === "host" && hostSocketId && socket.id === hostSocketId;
}

function setJoinedUI(joined) {
  joinBtn.disabled = joined;
  hostBtn.disabled = joined; // роль выбираем до входа
  leaveBtn.disabled = !joined;
}

function addChatLine(username, text, ts) {
  const time = new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = "chatLine";
  div.textContent = `[${time}] ${username}: ${text}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function safePlayerTime() {
  try {
    if (!player) return 0;
    return Number(player.getCurrentTime ? player.getCurrentTime() : 0) || 0;
  } catch {
    return 0;
  }
}

// -------------------- Settings UI --------------------
settingsBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  settingsMenu.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!settingsMenu) return;
  if (e.target === settingsBtn) return;
  if (settingsMenu.contains(e.target)) return;
  settingsMenu.classList.remove("open");
});

copyInviteBtn?.addEventListener("click", async () => {
  const roomId = getRoomId();
  if (!roomId) return setStatus(false, "Введи Room ID, чтобы скопировать invite.");
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus(true, "Invite link скопирован!");
  } catch {
    setStatus(false, "Не удалось скопировать. Скопируй вручную: " + url.toString());
  }
});

autoSyncToggle?.addEventListener("change", () => {
  autoSync = !!autoSyncToggle.checked;
  setStatus(true, `Auto-sync: ${autoSync ? "ON" : "OFF"}`);
});

// -------------------- Role select --------------------
hostBtn?.addEventListener("click", () => {
  myRole = (myRole === "host") ? "viewer" : "host";
  const rolePill = $("rolePill");
  if (rolePill) rolePill.textContent = `Role: ${myRole}`;
});

// -------------------- Join / Leave --------------------
joinBtn?.addEventListener("click", () => {
  const roomId = getRoomId();
  const username = getUsername();

  if (!username) return setStatus(false, "Введи имя пользователя.");
  if (!roomId) return setStatus(false, "Введи Room ID.");

  currentRoomId = roomId;
  setJoinedUI(true);
  setStatus(true, "Подключаюсь к комнате...");

  socket.emit("join-room", { roomId, username, role: myRole });
});

leaveBtn?.addEventListener("click", () => {
  if (!currentRoomId) return;
  socket.emit("leave-room");
  currentRoomId = null;
  hostSocketId = null;
  setJoinedUI(false);
  setStatus(true, "Ты вышел из комнаты.");
});

// -------------------- Chat --------------------
function sendChat() {
  const text = String(chatInput.value || "").trim();
  if (!text) return;
  if (!currentRoomId) return setStatus(false, "Сначала зайди в комнату.");
  const username = getUsername() || "anon";
  socket.emit("chat-msg", { roomId: currentRoomId, username, text });
  chatInput.value = "";
}
chatSendBtn?.addEventListener("click", sendChat);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// -------------------- Voice (stub for now) --------------------
voiceBtn?.addEventListener("click", () => {
  setStatus(false, "Voice пока в разработке (нужен полноценный WebRTC).");
});

// -------------------- YouTube init --------------------
function createPlayer(videoId) {
  currentVideoId = videoId;

  if (videoOverlay) videoOverlay.style.display = videoId ? "none" : "block";

  // wait for YT API
  const tryInit = () => {
    if (!window.YT || !window.YT.Player) return setTimeout(tryInit, 150);

    if (player) {
      // replace video
      ignorePlayerEvents = true;
      player.loadVideoById(videoId);
      setTimeout(() => (ignorePlayerEvents = false), 400);
      return;
    }

    player = new YT.Player("player", {
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 1,
        rel: 0,
        modestbranding: 1
      },
      events: {
        onReady: () => {
          setStatus(true, "YouTube плеер готов.");
          // ask server state once joined
          if (currentRoomId) socket.emit("request-sync", { roomId: currentRoomId });
        },
        onStateChange: (ev) => {
          if (ignorePlayerEvents) return;
          if (!currentRoomId) return;
          if (!isMeHost()) return; // управляет только host

          // 1 = playing, 2 = paused
          if (ev.data === 1) {
            socket.emit("video-play", { roomId: currentRoomId, time: safePlayerTime() });
          } else if (ev.data === 2) {
            socket.emit("video-pause", { roomId: currentRoomId, time: safePlayerTime() });
          }
        }
      }
    });
  };

  tryInit();
}

function seekIfNeeded(targetTime) {
  if (!player || !autoSync) return;

  const now = safePlayerTime();
  const diff = Math.abs(now - targetTime);

  // если расхождение больше 0.6 сек — правим
  if (diff > 0.6) {
    ignorePlayerEvents = true;
    player.seekTo(targetTime, true);
    setTimeout(() => (ignorePlayerEvents = false), 300);
  }
}

// send manual seek from host (when user drags timeline)
setInterval(() => {
  if (!player || !currentRoomId) return;
  if (!isMeHost()) return;

  // раз в ~1.2 сек отправим текущее время (мягкая синхра)
  const now = Date.now();
  if (now - lastSeekSentAt < 1200) return;
  lastSeekSentAt = now;

  socket.emit("video-seek", { roomId: currentRoomId, time: safePlayerTime() });
}, 250);

// -------------------- Send Video --------------------
sendVideoBtn?.addEventListener("click", () => {
  if (!currentRoomId) return setStatus(false, "Сначала зайди в комнату.");
  if (!isMeHost()) return setStatus(false, "Только Host может отправлять видео.");

  const id = parseYouTubeId(ytLinkEl.value);
  if (!id) return setStatus(false, "Не смог найти YouTube ID. Вставь нормальную ссылку.");
  socket.emit("video-set", { roomId: currentRoomId, videoId: id, time: 0 });
});

// -------------------- Socket events --------------------
socket.on("error-msg", (msg) => setStatus(false, msg));

socket.on("room-state", (state) => {
  // state: { roomId, hostSocketId, videoId, playing, time, updatedAt }
  hostSocketId = state.hostSocketId || null;

  if (state.videoId && state.videoId !== currentVideoId) {
    createPlayer(state.videoId);
  }

  // sync playback
  if (player && state.videoId) {
    seekIfNeeded(Number(state.time || 0));

    if (autoSync) {
      ignorePlayerEvents = true;
      if (state.playing) player.playVideo();
      else player.pauseVideo();
      setTimeout(() => (ignorePlayerEvents = false), 250);
    }
  }

  setStatus(true, `В комнате: ${state.roomId} | Host: ${state.hostSocketId ? "есть" : "нет"}`);
});

socket.on("host-changed", ({ hostSocketId: hs }) => {
  hostSocketId = hs || null;
  setStatus(true, `Host обновлён.`);
});

socket.on("chat-msg", ({ username, text, ts }) => addChatLine(username, text, ts));

socket.on("video-set", ({ videoId, time }) => {
  if (videoId && videoId !== currentVideoId) createPlayer(videoId);
  if (player && videoId) seekIfNeeded(Number(time || 0));
});

socket.on("video-play", ({ time }) => {
  if (!player) return;
  seekIfNeeded(Number(time || 0));
  if (autoSync) {
    ignorePlayerEvents = true;
    player.playVideo();
    setTimeout(() => (ignorePlayerEvents = false), 250);
  }
});

socket.on("video-pause", ({ time }) => {
  if (!player) return;
  seekIfNeeded(Number(time || 0));
  if (autoSync) {
    ignorePlayerEvents = true;
    player.pauseVideo();
    setTimeout(() => (ignorePlayerEvents = false), 250);
  }
});

socket.on("video-seek", ({ time }) => {
  if (!player) return;
  seekIfNeeded(Number(time || 0));
});

// -------------------- Autoload room from link --------------------
(function preloadRoomFromUrl() {
  const url = new URL(window.location.href);
  const room = url.searchParams.get("room");
  if (room) roomIdEl.value = room;
})();