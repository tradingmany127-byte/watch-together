const socket = io();

const roomId = location.pathname.split("/")[2] || "";
const qs = new URLSearchParams(location.search);
const name = (qs.get("name") || "").trim();
const asCreator = qs.get("asCreator") === "1";

const toastEl = document.getElementById("toast");
function toast(title, text) {
  toastEl.innerHTML = `<b>${title}</b><div>${text}</div>`;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2600);
}

const roomTitle = document.getElementById("roomTitle");
const roomSub = document.getElementById("roomSub");
const hostPill = document.getElementById("hostPill");
const mePill = document.getElementById("mePill");

const notFound = document.getElementById("notFound");
const nfText = document.getElementById("nfText");
const grid = document.getElementById("grid");

document.getElementById("backBtn").onclick = () => (location.href = "/");

document.getElementById("inviteBtn").onclick = async () => {
  const link = `${location.origin}/room/${roomId}?name=`;
  try {
    await navigator.clipboard.writeText(`${location.origin}/room/${roomId}`);
    toast("Ссылка скопирована", "Отправь другу — он введёт имя и зайдёт.");
  } catch {
    toast("Не удалось скопировать", `${location.origin}/room/${roomId}`);
  }
};

document.getElementById("leaveBtn").onclick = () => {
  socket.emit("room:leave", { roomId });
  socket.disconnect();
  location.href = "/";
};

function fmt(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Logs UI ---
const logsEl = document.getElementById("logs");
function addLog(item) {
  const div = document.createElement("div");
  div.className = "logItem";
  div.innerHTML = `<span class="logTime">[${fmt(item.ts)}]</span>${escapeHtml(item.text)}`;
  logsEl.appendChild(div);
  logsEl.scrollTop = logsEl.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

// --- Chat UI ---
const chatList = document.getElementById("chatList");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

sendBtn.onclick = sendChat;
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function addChat(msg, myName) {
  const wrap = document.createElement("div");
  wrap.className = "bubble" + (msg.name === myName ? " me" : "");
  wrap.innerHTML = `
    <div class="bTop">
      <div class="bName">${escapeHtml(msg.name)}</div>
      <div class="bTime">${fmt(msg.ts)}</div>
    </div>
    <div class="bText">${escapeHtml(msg.text)}</div>
  `;
  chatList.appendChild(wrap);
  chatList.scrollTop = chatList.scrollHeight;
}

function sendChat() {
  const t = (chatInput.value || "").trim();
  if (!t) return;
  socket.emit("chat:send", { roomId, text: t });
  chatInput.value = "";
}

// --- YouTube parsing ---
function extractYouTubeId(urlOrId) {
  const s = String(urlOrId || "").trim();
  if (!s) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "").slice(0, 11);
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    const m = u.pathname.match(/\/(shorts|embed)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[2];
  } catch {
    return null;
  }
  return null;
}

// --- YouTube sync ---
 
// server state cache
let currentVideoId = null;

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    videoId: "",
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1
    },
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: onPlayerStateChange
    }
  });
};

function onPlayerStateChange(e) {
  if (!playerReady || suppress) return;
  if (!player) return;

  const t = safeTime();

  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video:intent", { roomId, action: "play", atSec: t });
  }
  if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video:intent", { roomId, action: "pause", atSec: t });
  }
}

function safeTime() {
  try { return player.getCurrentTime(); } catch { return 0; }
}

async function ensureVideoLoaded(videoId) {
  if (!player || !playerReady) return;
  if (!videoId) return;

  const cur = player.getVideoData?.()?.video_id;
  if (cur !== videoId) {
    suppress = true;
    player.loadVideoById(videoId, 0);
    player.pauseVideo();
    setTimeout(() => { suppress = false; }, 350);
  }
}

async function applySync(state) {
  if (!player || !playerReady) return;
  if (!state.videoId) return;

  await ensureVideoLoaded(state.videoId);

  const target = Math.max(0, Number(state.positionSec) || 0);

  let cur = safeTime();
  const drift = Math.abs(cur - target);

  suppress = true;

  if (drift > 0.45) {
    player.seekTo(target, true);
  }

  if (state.isPlaying) {
    try { player.playVideo(); } catch {}
  } else {
    try { player.pauseVideo(); } catch {}
  }

  setTimeout(() => { suppress = false; }, 260);
}

// detect manual seek by polling
let lastTime = 0;
setInterval(() => {
  if (!player || !playerReady) return;
  const cur = safeTime();
  const jump = Math.abs(cur - lastTime);

  if (!suppress && jump > 1.2) {
    const nowMs = Date.now();
    if (nowMs - lastSeekEmit > 300) {
      lastSeekEmit = nowMs;
      socket.emit("video:intent", { roomId, action: "seek", atSec: cur });
    }
  }
  lastTime = cur;
}, 700);

// periodic resync
setInterval(() => {
  if (socket.connected) socket.emit("video:requestState", { roomId });
}, 7500);

// load button
const ytInput = document.getElementById("ytInput");
document.getElementById("loadBtn").onclick = () => {
  const id = extractYouTubeId(ytInput.value);
  if (!id) {
    toast("Ссылка не распознана", "Вставь YouTube ссылку (watch/youtu.be/shorts) или ID (11 символов).");
    return;
  }
  socket.emit("video:set", { roomId, videoId: id, atSec: 0 });
  ytInput.value = "";
};

// --- Join flow ---
async function checkRoomExists() {
  try {
    const r = await fetch(`/api/room-exists/${roomId}`);
    const j = await r.json();
    return !!j.exists;
  } catch {
    return false;
  }
}

function showNotFound(text) {
  grid.style.display = "none";
  notFound.style.display = "block";
  nfText.textContent = text;
}

(async () => {
  roomTitle.textContent = `Комната #${roomId}`;

  if (!/^\d+$/.test(roomId)) {
    showNotFound("Некорректный ID комнаты.");
    return;
  }

  const exists = await checkRoomExists();
  if (!exists) {
    showNotFound(`Комнаты #${roomId} не существует.`);
    return;
  }

  if (!name) {
    showNotFound("Нужно указать имя пользователя. Вернись в меню и зайди с именем.");
    return;
  }

  socket.emit("room:join", { roomId, name, asCreator });

  socket.on("room:notFound", () => showNotFound(`Комнаты #${roomId} не существует.`));
  socket.on("room:badName", () => showNotFound("Нужно имя пользователя. Вернись в меню и введи имя."));

  socket.on("room:state", async (payload) => {
    myName = payload.me.name;
    isHost = !!payload.me.isHost;

    mePill.textContent = `Вы: ${myName}`;
    hostPill.textContent = `HOST: ${payload.room.hostName || "—"}`;

    roomSub.textContent = isHost ? "Вы — HOST (создатель комнаты)" : "Вы — участник комнаты";

    logsEl.innerHTML = "";
    (payload.logs || []).forEach(addLog);

    currentVideoId = payload.room.videoId;

    if (payload.room.videoId) {
      await applySync({
        videoId: payload.room.videoId,
        isPlaying: payload.room.isPlaying,
        positionSec: payload.room.positionSec
      });
    }
  });

  socket.on("presence", (p) => {
    addLog({ text: p.text, ts: p.ts });
  });

  socket.on("logs:new", addLog);

  socket.on("chat:new", (msg) => addChat(msg, myName));

  socket.on("video:sync", async ({ state }) => {
    currentVideoId = state.videoId;
    await applySync(state);
  });
})();