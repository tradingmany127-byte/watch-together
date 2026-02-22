// ======================
// 0) Firebase Auth config
// ======================
// ВСТАВЬ СЮДА СВОЙ CONFIG ИЗ FIREBASE (Project settings -> Web app)
const firebaseConfig = {
  apiKey: "PASTE_YOURS",
  authDomain: "PASTE_YOURS",
  projectId: "PASTE_YOURS",
  appId: "PASTE_YOURS"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// ======================
// UI
// ======================
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

const chatBox = $("chatBox");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

const usersList = $("usersList");

const settingsBtn = $("settingsBtn");
const settingsModal = $("settingsModal");
const settingsClose = $("settingsClose");
const openRegister = $("openRegister");
const openLogin = $("openLogin");

const authModal = $("authModal");
const authClose = $("authClose");
const authTitle = $("authTitle");
const authEmail = $("authEmail");
const authPass = $("authPass");
const authSubmit = $("authSubmit");
const googleBtn = $("googleBtn");
const logoutBtn = $("logoutBtn");
const authHint = $("authHint");
const authBadge = $("authBadge");

const toggleThemeBtn = $("toggleThemeBtn");
const muteAllBtn = $("muteAllBtn");

const voiceBtn = $("voiceBtn");
const syncNowBtn = $("syncNowBtn");
const copyInviteBtn = $("copyInviteBtn");

// ======================
// App state
// ======================
const socket = io();

let currentRoomId = null;
let myRole = "viewer"; // viewer|host
let hostSocketId = null;

let player = null;
let playerReady = false;
let lastApplied = 0;
let suppressPlayerEvents = false;

let voiceEnabled = false;
let localStream = null;
let peers = new Map(); // peerId -> RTCPeerConnection
let voiceMuted = false;

// ======================
// Helpers
// ======================
function setStatus(text) {
  statusLine.textContent = text;
}

function addChatLine(username, text, ts = Date.now()) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<b>${escapeHtml(username)}:</b> ${escapeHtml(text)} <span class="t">${time}</span>`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function parseYouTubeId(urlOrId) {
  const s = String(urlOrId || "").trim();
  if (!s) return null;

  // Если уже ID
  if (/^[a-zA-Z0-9_-]{6,}$/.test(s) && !s.includes("http")) return s;

  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "") || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const parts = u.pathname.split("/");
    const idx = parts.indexOf("embed");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  } catch (_) {}

  return null;
}

function isHost() {
  return socket.id && hostSocketId && socket.id === hostSocketId;
}

// ======================
// 1) YouTube Player
// ======================
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "360",
    width: "100%",
    videoId: "",
    playerVars: {
      modestbranding: 1,
      rel: 0,
      playsinline: 1
    },
    events: {
      onReady: () => {
        playerReady = true;
        setStatus("✅ Плеер готов. Войди в комнату.");
      },
      onStateChange: (e) => {
        if (!currentRoomId) return;
        if (suppressPlayerEvents) return;
        if (!isHost()) return; // только хост шлёт события

        // PLAY
        if (e.data === YT.PlayerState.PLAYING) {
          socket.emit("video-play", { roomId: currentRoomId, time: player.getCurrentTime() });
        }

        // PAUSE
        if (e.data === YT.PlayerState.PAUSED) {
          socket.emit("video-pause", { roomId: currentRoomId, time: player.getCurrentTime() });
        }
      }
    }
  });
};

// Применение синка от сервера
function applyRemoteState({ videoId, time, playing }) {
  if (!playerReady) return;
  const now = Date.now();
  if (now - lastApplied < 250) return;
  lastApplied = now;

  suppressPlayerEvents = true;

  try {
    const curVid = player.getVideoData()?.video_id || null;

    if (videoId && curVid !== videoId) {
      player.loadVideoById(videoId, time || 0);
      if (!playing) player.pauseVideo();
      suppressPlayerEvents = false;
      return;
    }

    // Синхронизация времени
    const curT = player.getCurrentTime();
    const diff = Math.abs((time || 0) - curT);

    if (diff > 1.0) {
      player.seekTo(time || 0, true);
    }

    if (playing) player.playVideo();
    else player.pauseVideo();
  } finally {
    setTimeout(() => { suppressPlayerEvents = false; }, 150);
  }
}

// ======================
// 2) Room join/leave
// ======================
function joinRoom() {
  const roomId = roomIdEl.value.trim();
  const username = usernameEl.value.trim();

  if (!roomId) return setStatus("❌ Room ID пустой.");
  if (!username) return setStatus("❌ Введи username.");

  socket.emit("join-room", { roomId, username, role: myRole });
  currentRoomId = roomId;

  setStatus("⏳ Подключаемся к комнате...");
}

function leaveRoom() {
  if (!currentRoomId) return;

  stopVoice().catch(() => {});
  socket.emit("leave-room");
  setStatus("✅ Вышел из комнаты.");
  currentRoomId = null;
  hostSocketId = null;
  usersList.innerHTML = "";
}

// ======================
// 3) Chat
// ======================
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.");

  const username = usernameEl.value.trim() || "anon";
  socket.emit("chat-msg", { roomId: currentRoomId, username, text });
  chatInput.value = "";
}

// ======================
// 4) Voice (WebRTC mesh)
// ======================
async function startVoice() {
  if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.");
  if (voiceEnabled) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceEnabled = true;
    voiceBtn.textContent = "🎙 Voice (выкл)";
    setStatus("🎙 Voice включён. Подключаем peers...");

    // Чтобы создать соединения — нам нужен список пользователей
    // Сервер присылает users-update, там и инициируем connect
    // Здесь просто ждём следующего users-update
  } catch (e) {
    setStatus("❌ Микрофон не дал доступ: " + e.message);
  }
}

async function stopVoice() {
  voiceEnabled = false;
  voiceBtn.textContent = "🎙 Voice (вкл)";

  for (const pc of peers.values()) {
    try { pc.close(); } catch {}
  }
  peers.clear();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  setStatus("🔇 Voice выключен.");
}

function ensurePeer(peerId, politeOfferer) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  // отправляем свой микрофон
  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  // принимаем чужой звук
  pc.ontrack = (ev) => {
    if (voiceMuted) return;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = ev.streams[0];
    audio.volume = 1.0;
    document.body.appendChild(audio);
    // чистим позже
    setTimeout(() => audio.remove(), 60_000);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit("webrtc-ice", {
        roomId: currentRoomId,
        to: peerId,
        candidate: ev.candidate
      });
    }
  };

  // оффер создаёт “меньший” id (чтобы не было двойных офферов)
  if (politeOfferer) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", {
          roomId: currentRoomId,
          to: peerId,
          offer
        });
      } catch (e) {
        console.warn("negotiation error", e);
      }
    };
  }

  peers.set(peerId, pc);
  return pc;
}

async function connectVoiceToUsers(users) {
  if (!voiceEnabled || !localStream || !currentRoomId) return;

  // Подключаемся ко всем, кроме себя
  for (const u of users) {
    if (u.id === socket.id) continue;

    // Чтобы не спамить офферами: создаёт оффер тот, у кого socket.id меньше (лексикографически)
    const iCreateOffer = String(socket.id) < String(u.id);

    const pc = ensurePeer(u.id, iCreateOffer);

    // Если я не создатель оффера — просто ждём оффер от другой стороны
    // Но всё равно pc должен существовать, чтобы принять ontrack
    void pc;
  }
}

// ======================
// 5) UI кнопки
// ======================
joinBtn.onclick = joinRoom;
leaveBtn.onclick = leaveRoom;

hostBtn.onclick = () => {
  myRole = "host";
  rolePill.textContent = "Role: host";
  setStatus("✅ Ты выбрал роль Host. Теперь Join в комнату.");
};

sendVideoBtn.onclick = () => {
  if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.");
  if (!isHost()) return setStatus("❌ Только Host может отправлять видео.");

  const id = parseYouTubeId(ytLinkEl.value);
  if (!id) return setStatus("❌ Не смог распознать YouTube ссылку.");

  socket.emit("video-set", { roomId: currentRoomId, videoId: id, time: 0 });
  setStatus("✅ Видео отправлено в комнату.");
};

chatSendBtn.onclick = sendChat;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

voiceBtn.onclick = async () => {
  if (!voiceEnabled) await startVoice();
  else await stopVoice();
};

syncNowBtn.onclick = () => {
  if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.");
  if (!playerReady) return;
  if (!isHost()) return setStatus("❌ Sync now делает Host.");

  socket.emit("video-seek", { roomId: currentRoomId, time: player.getCurrentTime() });
  setStatus("⚡ Sync отправлен.");
};

copyInviteBtn.onclick = async () => {
  const rid = roomIdEl.value.trim();
  if (!rid) return setStatus("❌ Впиши Room ID.");
  const url = new URL(window.location.href);
  url.searchParams.set("room", rid);

  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("🔗 Инвайт скопирован в буфер.");
  } catch {
    setStatus("❌ Не смог скопировать (браузер запретил).");
  }
};

// ======================
// 6) Socket events
// ======================
socket.on("error-msg", (m) => setStatus("❌ " + m));

socket.on("room-state", (st) => {
  hostSocketId = st.hostSocketId || null;

  setStatus(hostSocketId === socket.id
    ? "✅ В комнате. Ты Host."
    : "✅ В комнате. Ты Viewer.");

  // Users
  renderUsers(st.users || []);

  // Video state
  if (st.videoId) {
    applyRemoteState({
      videoId: st.videoId,
      time: st.time,
      playing: st.playing
    });
  }

  // Если voice включён — подключаемся
  connectVoiceToUsers(st.users || []);
});

socket.on("host-changed", ({ hostSocketId: newHost }) => {
  hostSocketId = newHost || null;
  if (hostSocketId === socket.id) {
    setStatus("👑 Теперь ты Host.");
  } else {
    setStatus("ℹ️ Host сменился.");
  }
});

socket.on("users-update", (users) => {
  renderUsers(users || []);
  connectVoiceToUsers(users || []);
});

function renderUsers(users) {
  usersList.innerHTML = "";
  for (const u of users) {
    const div = document.createElement("div");
    div.className = "user-item";
    const crown = u.id === hostSocketId ? " 👑" : "";
    div.textContent = `${u.username} (${u.role})${crown}`;
    usersList.appendChild(div);
  }
}

// chat
socket.on("chat-msg", (msg) => addChatLine(msg.username, msg.text, msg.ts));

// video sync
socket.on("video-set", (p) => applyRemoteState({ videoId: p.videoId, time: p.time, playing: p.playing }));
socket.on("video-play", (p) => applyRemoteState({ videoId: null, time: p.time, playing: true }));
socket.on("video-pause", (p) => applyRemoteState({ videoId: null, time: p.time, playing: false }));
socket.on("video-seek", (p) => applyRemoteState({ videoId: null, time: p.time, playing: player?.getPlayerState?.() === YT.PlayerState.PLAYING }));

// WebRTC signaling
socket.on("webrtc-offer", async ({ from, offer }) => {
  if (!voiceEnabled) return;
  const pc = ensurePeer(from, false);
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { roomId: currentRoomId, to: from, answer });
});

socket.on("webrtc-answer", async ({ from, answer }) => {
  const pc = peers.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(answer);
});

socket.on("webrtc-ice", async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (!pc) return;
  try { await pc.addIceCandidate(candidate); } catch {}
});

// ======================
// 7) Settings + Auth UI
// ======================
settingsBtn.onclick = () => settingsModal.classList.remove("hidden");
settingsClose.onclick = () => settingsModal.classList.add("hidden");

openRegister.onclick = () => openAuth("register");
openLogin.onclick = () => openAuth("login");

function openAuth(mode) {
  authModal.classList.remove("hidden");
  authHint.textContent = "";
  if (mode === "register") {
    authTitle.textContent = "Регистрация";
    authSubmit.textContent = "Создать аккаунт";
    authSubmit.onclick = doRegister;
  } else {
    authTitle.textContent = "Войти";
    authSubmit.textContent = "Войти";
    authSubmit.onclick = doLogin;
  }
}

authClose.onclick = () => authModal.classList.add("hidden");

async function doRegister() {
  try {
    const email = authEmail.value.trim();
    const pass = authPass.value.trim();
    if (!email || !pass) return (authHint.textContent = "Заполни email и password.");
    await auth.createUserWithEmailAndPassword(email, pass);
    authHint.textContent = "✅ Готово. Аккаунт создан.";
  } catch (e) {
    authHint.textContent = "❌ " + (e.message || "Ошибка регистрации");
  }
}

async function doLogin() {
  try {
    const email = authEmail.value.trim();
    const pass = authPass.value.trim();
    if (!email || !pass) return (authHint.textContent = "Заполни email и password.");
    await auth.signInWithEmailAndPassword(email, pass);
    authHint.textContent = "✅ Вошёл.";
  } catch (e) {
    authHint.textContent = "❌ " + (e.message || "Ошибка входа");
  }
}

googleBtn.onclick = async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    authHint.textContent = "✅ Вошёл через Google.";
  } catch (e) {
    authHint.textContent = "❌ " + (e.message || "Ошибка Google login");
  }
};

logoutBtn.onclick = async () => {
  try {
    await auth.signOut();
    authHint.textContent = "✅ Вышел.";
  } catch (e) {
    authHint.textContent = "❌ " + (e.message || "Ошибка logout");
  }
};

auth.onAuthStateChanged((user) => {
  if (user) {
    authBadge.textContent = `✅ ${user.email || "Google user"}`;
    // автоподставим username если пусто
    if (!usernameEl.value.trim()) {
      const nm = (user.email || "user").split("@")[0];
      usernameEl.value = nm;
    }
  } else {
    authBadge.textContent = "Не вошёл";
  }
});

// 2 фичи
toggleThemeBtn.onclick = () => {
  document.body.classList.toggle("light");
  // супер простой тумблер
  if (document.body.classList.contains("light")) {
    document.documentElement.style.setProperty("--bg", "#dfefff");
    document.documentElement.style.setProperty("--bg2", "#eef6ff");
    document.documentElement.style.setProperty("--panel", "#ffffff");
    document.documentElement.style.setProperty("--panel2", "#ffffff");
    document.documentElement.style.setProperty("--border", "#aac7dd");
    document.documentElement.style.setProperty("--text", "#0a1b2a");
    document.documentElement.style.setProperty("--muted", "#284b63");
  } else {
    document.documentElement.style.setProperty("--bg", "#0e2235");
    document.documentElement.style.setProperty("--bg2", "#0b1a2a");
    document.documentElement.style.setProperty("--panel", "#17344d");
    document.documentElement.style.setProperty("--panel2", "#1d3f5b");
    document.documentElement.style.setProperty("--border", "#2b5877");
    document.documentElement.style.setProperty("--text", "#eaf3ff");
    document.documentElement.style.setProperty("--muted", "#a9c3db");
  }
};

muteAllBtn.onclick = () => {
  voiceMuted = !voiceMuted;
  muteAllBtn.textContent = voiceMuted ? "🔊 Unmute voice" : "🔇 Mute voice";
  setStatus(voiceMuted ? "🔇 Voice заглушён." : "🔊 Voice включён.");
};

// ======================
// 8) Auto-fill room from URL (?room=123)
// ======================
(() => {
  const url = new URL(window.location.href);
  const rid = url.searchParams.get("room");
  if (rid) roomIdEl.value = rid;
})();