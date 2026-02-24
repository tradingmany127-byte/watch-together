const $ = (id) => document.getElementById(id);

const roomIdEl = $("roomId");
const usernameEl = $("username");
const joinBtn = $("joinBtn");
const hostBtn = $("hostBtn");
const rolePill = $("rolePill");
const leaveBtn = $("leaveBtn");

const ytLinkEl = $("ytLink");
const sendVideoBtn = $("sendVideoBtn");
const statusLine = $("statusLine");
const videoOverlay = $("videoOverlay");

const chatBox = $("chatBox");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

const settingsBtn = $("settingsBtn");
const settingsMenu = $("settingsMenu");
const copyInviteBtn = $("copyInviteBtn");
const autoSyncToggle = $("autoSyncToggle");

const socket = io();

let currentRoomId = "";
let myUsername = "";
let myRole = "viewer";
let hostSocketId = null;
let isIHost = false;

// ============================
// Settings menu
// ============================
settingsBtn.addEventListener("click", () => {
  settingsMenu.classList.toggle("open");
});
document.addEventListener("click", (e) => {
  if (!settingsMenu.contains(e.target) && e.target !== settingsBtn) {
    settingsMenu.classList.remove("open");
  }
});
copyInviteBtn.addEventListener("click", async () => {
  settingsMenu.classList.remove("open");
  if (!currentRoomId) return setStatus("❌ Сначала войди в комнату.");
  const url = new URL(window.location.href);
  url.searchParams.set("room", currentRoomId);
  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("✅ Invite link скопирован.");
  } catch {
    setStatus("❌ Не удалось скопировать (разрешения браузера).");
  }
});

// Auto-fill room from URL
(() => {
  const url = new URL(window.location.href);
  const r = url.searchParams.get("room");
  if (r) roomIdEl.value = r;
})();

function setStatus(text) {
  statusLine.textContent = text;
}

// ============================
// Role / Join / Leave
// ============================
function setRole(role) {
  myRole = role;
  rolePill.textContent = `Role: ${role}`;
}

hostBtn.addEventListener("click", () => {
  setRole("host");
  setStatus("✅ Ты выбрал Host. Теперь Join.");
});

joinBtn.addEventListener("click", () => {
  const roomId = String(roomIdEl.value || "").trim();
  const username = String(usernameEl.value || "").trim();
  if (!roomId) return setStatus("❌ Room ID пустой.");
  if (!username) return setStatus("❌ Введи имя пользователя.");

  currentRoomId = roomId;
  myUsername = username;

  socket.emit("join-room", { roomId, username, role: myRole });
  setStatus("⏳ Подключение к комнате...");
});

leaveBtn.addEventListener("click", () => {
  socket.emit("leave-room");
  currentRoomId = "";
  hostSocketId = null;
  isIHost = false;

  leaveBtn.disabled = true;
  joinBtn.disabled = false;
  roomIdEl.disabled = false;
  usernameEl.disabled = false;

  setStatus("✅ Ты вышел из комнаты.");
});

// ============================
// YouTube Player
// ============================
let player = null;
let playerReady = false;
let currentVideoId = null;
let suppressLocalEvents = false;

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

function ensurePlayer() {
  if (player) return;

  const tryCreate = () => {
    if (!window.YT || !window.YT.Player) return false;

    player = new YT.Player("player", {
      height: "360",
      width: "100%",
      videoId: "",
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          setStatus("✅ Плеер готов. Войди в комнату.");
        },
        onStateChange: (e) => {
          if (!playerReady) return;
          if (!currentRoomId) return;
          if (!isIHost) return;
          if (suppressLocalEvents) return;

          const t = safeGetTime();
          if (e.data === YT.PlayerState.PLAYING) {
            socket.emit("video-play", { roomId: currentRoomId, time: t });
          } else if (e.data === YT.PlayerState.PAUSED) {
            socket.emit("video-pause", { roomId: currentRoomId, time: t });
          }
        }
      }
    });

    return true;
  };

  const iv = setInterval(() => {
    if (tryCreate()) clearInterval(iv);
  }, 100);
}

function safeGetTime() {
  try { return player ? Number(player.getCurrentTime() || 0) : 0; } catch { return 0; }
}

function loadVideo(videoId, time = 0, autoplay = false) {
  ensurePlayer();
  currentVideoId = videoId || null;

  if (!videoId) {
    videoOverlay.style.display = "flex";
    return;
  }

  videoOverlay.style.display = "none";

  const doLoad = () => {
    if (!playerReady) return setTimeout(doLoad, 120);

    suppressLocalEvents = true;
    try {
      if (autoplay) {
        player.loadVideoById({ videoId, startSeconds: time });
      } else {
        player.cueVideoById({ videoId, startSeconds: time });
      }
    } finally {
      setTimeout(() => (suppressLocalEvents = false), 300);
    }
  };
  doLoad();
}

function seekTo(time) {
  if (!playerReady || !player) return;
  suppressLocalEvents = true;
  try { player.seekTo(Math.max(0, time), true); }
  finally { setTimeout(() => (suppressLocalEvents = false), 250); }
}
function play() {
  if (!playerReady || !player) return;
  suppressLocalEvents = true;
  try { player.playVideo(); }
  finally { setTimeout(() => (suppressLocalEvents = false), 250); }
}
function pause() {
  if (!playerReady || !player) return;
  suppressLocalEvents = true;
  try { player.pauseVideo(); }
  finally { setTimeout(() => (suppressLocalEvents = false), 250); }
}

// Host sends video
sendVideoBtn.addEventListener("click", () => {
  if (!currentRoomId) return setStatus("❌ Сначала войди в комнату.");
  if (!isIHost) return setStatus("❌ Только Host может менять видео.");

  const vid = parseYouTubeId(ytLinkEl.value);
  if (!vid) return setStatus("❌ Не смог распознать YouTube ссылку/ID.");

  socket.emit("video-set", { roomId: currentRoomId, videoId: vid, time: 0 });
  setStatus("✅ Видео отправлено в комнату.");
});

// Auto sync drift correction for viewers
setInterval(() => {
  if (!currentRoomId) return;
  if (!autoSyncToggle.checked) return;
  if (!playerReady || !player) return;
  if (isIHost) return;
  socket.emit("request-sync", { roomId: currentRoomId });
}, 2500);

// ============================
// Chat
// ============================
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addChatMessage({ username, text, ts }) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.innerHTML = `
    <div class="meta">${hh}:${mm} • <b>${escapeHtml(username)}</b></div>
    <div class="text">${escapeHtml(text)}</div>
  `;
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function sendChat() {
  if (!currentRoomId) return setStatus("❌ Сначала войди в комнату.");
  const text = String(chatInput.value || "").trim();
  if (!text) return;
  socket.emit("chat-msg", { roomId: currentRoomId, username: myUsername || "anon", text });
  chatInput.value = "";
}

chatSendBtn.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// ============================
// Socket listeners
// ============================
socket.on("error-msg", (msg) => setStatus("❌ " + msg));

socket.on("room-state", (st) => {
  if (!st || !st.roomId) return;
  if (String(st.roomId) !== String(currentRoomId)) return;

  hostSocketId = st.hostSocketId || null;
  isIHost = hostSocketId && hostSocketId === socket.id;

  leaveBtn.disabled = false;
  joinBtn.disabled = true;
  roomIdEl.disabled = true;
  usernameEl.disabled = true;

  ensurePlayer();

  // load or sync video
  if (st.videoId && st.videoId !== currentVideoId) {
    loadVideo(st.videoId, Number(st.time || 0), Boolean(st.playing));
  } else if (st.videoId && currentVideoId) {
    const target = Number(st.time || 0);
    const cur = safeGetTime();
    if (!isIHost && Math.abs(cur - target) > 0.9) seekTo(target);
    if (!isIHost) (st.playing ? play() : pause());
  }

  setStatus(`✅ В комнате ${currentRoomId}. Ты: ${isIHost ? "Host" : "viewer"}.`);
});

socket.on("host-changed", ({ hostSocketId: newHost }) => {
  hostSocketId = newHost || null;
  isIHost = hostSocketId && hostSocketId === socket.id;
  setStatus(isIHost ? "✅ Ты теперь Host." : "ℹ️ Хост сменился.");
});

socket.on("video-set", ({ videoId, time, playing }) => {
  loadVideo(videoId, Number(time || 0), Boolean(playing));
  setStatus("✅ Видео синхронизировано.");
});

socket.on("video-play", ({ time }) => {
  if (isIHost) return;
  const target = Number(time || 0);
  const cur = safeGetTime();
  if (Math.abs(cur - target) > 0.9) seekTo(target);
  play();
});

socket.on("video-pause", ({ time }) => {
  if (isIHost) return;
  const target = Number(time || 0);
  const cur = safeGetTime();
  if (Math.abs(cur - target) > 0.9) seekTo(target);
  pause();
});

socket.on("video-seek", ({ time }) => {
  if (isIHost) return;
  seekTo(Number(time || 0));
});

socket.on("chat-msg", (m) => addChatMessage(m));

// voice button placeholder (не ломаем UI)
$("voiceBtn").addEventListener("click", () => {
  setStatus("ℹ️ пока не работает");
});

// init
ensurePlayer();
// =======================
// SETTINGS MENU (⚙️)
// =======================
(function initSettingsMenu() {
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsMenu = document.getElementById("settingsMenu");

  if (!settingsBtn || !settingsMenu) {
    console.warn("[settings] settingsBtn/settingsMenu not found");
    return;
  }

  // Старт: меню скрыто
  settingsMenu.classList.remove("open");
  settingsMenu.style.display = "none";

  function openMenu() {
    settingsMenu.style.display = "block";
    // маленькая задержка для анимации (если есть)
    requestAnimationFrame(() => settingsMenu.classList.add("open"));
  }

  function closeMenu() {
    settingsMenu.classList.remove("open");
    // если нет анимации — можно сразу display none
    setTimeout(() => (settingsMenu.style.display = "none"), 80);
  }

  function isOpen() {
    return settingsMenu.style.display !== "none";
  }

  settingsBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen()) closeMenu();
    else openMenu();
  });

  // клик по меню — не закрывать
  settingsMenu.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // клик вне меню — закрыть
  document.addEventListener("click", () => {
    if (isOpen()) closeMenu();
  });

  // Esc — закрыть
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) closeMenu();
  });
})();
// ===== Settings Drawer Logic =====
(function () {
  const btn = document.getElementById("settingsBtn");       // твоя кнопка ⚙️
  const overlay = document.getElementById("settingsOverlay");
  const drawer = document.getElementById("settingsDrawer");
  const closeBtn = document.getElementById("settingsClose");
  const toast = document.getElementById("drawerToast");

  if (!btn || !overlay || !drawer || !closeBtn) {
    console.warn("[SettingsDrawer] Not found: check ids (settingsBtn/settingsOverlay/settingsDrawer/settingsClose)");
    return;
  }

  const showToast = (text) => {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 1800);
  };

  const open = () => {
    overlay.classList.add("open");
    drawer.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    drawer.setAttribute("aria-hidden", "false");
  };

  const close = () => {
    overlay.classList.remove("open");
    drawer.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    drawer.setAttribute("aria-hidden", "true");
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    open();
  });

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Menu actions
  const byId = (id) => document.getElementById(id);

  byId("menuCopyInvite")?.addEventListener("click", async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      showToast("✅ Ссылка скопирована");
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast("✅ Ссылка скопирована");
    }
  });

  byId("menuAuth")?.addEventListener("click", () => {
    showToast("🔐 Тут будет модалка логина/регистрации");
    // TODO: открыть твоё окно регистрации
  });

  byId("menuProfile")?.addEventListener("click", () => {
    showToast("👤 Тут будет профиль пользователя");
    // TODO: открыть профиль
  });

  byId("menuReferral")?.addEventListener("click", () => {
    showToast("🎁 Тут будет реферальная система");
    // TODO: открыть рефералку
  });

  // Feature: theme toggle (простая заготовка)
  byId("menuTheme")?.addEventListener("click", () => {
    document.body.classList.toggle("theme-alt");
    showToast("🌓 Тема переключена");
  });

  // Feature: hotkeys hint
  byId("menuHotkeys")?.addEventListener("click", () => {
    alert("Горячие клавиши:\nEsc — закрыть настройки\nEnter — отправка сообщения (если у тебя есть)\n\nМожно добавить больше позже 🙂");
  });
})();