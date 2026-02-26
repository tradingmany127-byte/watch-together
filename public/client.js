// client.js — STABLE HOST-ONLY SYNC (ANTI-STOPPING + hostKey)
// Host sends truth. Non-hosts auto-correct if they try to pause/seek locally.

const socket = io();

let player = null;
let playerReady = false;

let isHost = false;
let suppress = false;
let lastRemoteApplyAt = 0;

const HARD_SYNC = 2.2;        // >2.2s => seek
const SOFT_SYNC = 0.40;       // 0.40–2.2s => playbackRate nudge
const SYNC_INTERVAL = 1200;   // host beacon
const RATE_RESET_MS = 900;

let rateTimer = null;

// ---------- DOM ----------
const videoInput = document.getElementById("videoUrl");
const loadBtn = document.getElementById("loadBtn");
const statusEl = document.getElementById("status");

// ---------- roomId + hostKey ----------
function getRoomIdFromUrl() {
  // /room/12345 or /room/12345?x
  const parts = location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("room");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  // fallback: last segment
  return parts[parts.length - 1] || "";
}
const ROOM_ID = getRoomIdFromUrl();

function genKey() {
  // simple random key
  return (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random().toString(16).slice(2)));
}
const HOSTKEY_STORAGE = `synswatch_hostkey_${ROOM_ID}`;
let hostKey = localStorage.getItem(HOSTKEY_STORAGE);
if (!hostKey) {
  hostKey = genKey();
  localStorage.setItem(HOSTKEY_STORAGE, hostKey);
}

// ---------- helpers ----------
function setStatus(t) {
  if (statusEl) statusEl.textContent = t;
}

function setHostUI() {
  if (videoInput) videoInput.disabled = !isHost;
  if (loadBtn) loadBtn.disabled = !isHost;
}

function safeNow() {
  return Date.now();
}

function withSuppress(ms, fn) {
  suppress = true;
  lastRemoteApplyAt = safeNow();
  try { fn(); } catch (_) {}
  setTimeout(() => { suppress = false; }, ms);
}

function getTime() {
  if (!playerReady || !player) return 0;
  try { return player.getCurrentTime() || 0; } catch { return 0; }
}

function getState() {
  if (!playerReady || !player) return -1;
  try { return player.getPlayerState(); } catch { return -1; }
}

function isPlaying() {
  return getState() === YT.PlayerState.PLAYING;
}

function setRateSafe(r) {
  try {
    if (!player || !player.setPlaybackRate) return;
    player.setPlaybackRate(r);
    if (rateTimer) clearTimeout(rateTimer);
    rateTimer = setTimeout(() => {
      try { player.setPlaybackRate(1); } catch {}
    }, RATE_RESET_MS);
  } catch {}
}

// ---------- YouTube loader ----------
function loadYT() {
  return new Promise((res) => {
    if (window.YT && window.YT.Player) return res();
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => res();
  });
}

async function ensurePlayer(videoId) {
  await loadYT();

  if (player) {
    if (videoId) {
      withSuppress(900, () => player.loadVideoById(videoId));
    }
    return;
  }

  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId: videoId || "",
    playerVars: {
      controls: 1,          // оставляем, чтобы на телефоне был fullscreen
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      fs: 1,
      disablekb: 1
    },
    events: {
      onReady: () => {
        playerReady = true;
        try {
          const iframe = player.getIframe();
          iframe.setAttribute("allowfullscreen", "true");
          iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
          iframe.style.width = "100%";
          iframe.style.height = "100%";
        } catch {}
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

// ---------- HOST: emit only from host + anti-echo ----------
let hostSeekCheckTimer = null;
let lastHostT = 0;
let lastHostTickAt = 0;

function onPlayerStateChange(e) {
  if (!playerReady || !player) return;

  // анти-эхо: если мы только что применяли sync — игнорим
  if (suppress) return;
  if (safeNow() - lastRemoteApplyAt < 900) return;

  // НЕ ХОСТ => ничего не шлём на сервер
  if (!isHost) return;

  const t = getTime();

  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-play", { time: t, hostKey });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-pause", { time: t, hostKey });
  }
}

// host seek detection (scrub in player UI)
function startHostSeekDetector() {
  if (hostSeekCheckTimer) clearInterval(hostSeekCheckTimer);
  hostSeekCheckTimer = setInterval(() => {
    if (!isHost || !playerReady || !player) return;

    const t = getTime();
    const nowMs = safeNow();
    const dt = (nowMs - lastHostTickAt) / 1000;

    if (lastHostTickAt > 0) {
      // ожидаемое изменение времени если playing
      const expected = isPlaying() ? dt : 0;
      const jump = Math.abs((t - lastHostT) - expected);

      // если резкий скачок => emit seek (дебаунс)
      if (jump > 1.2) {
        socket.emit("video-seek", { time: t, hostKey });
      }
    }

    lastHostT = t;
    lastHostTickAt = nowMs;
  }, 500);
}

// ---------- APPLY SYNC (only non-host) ----------
function applySync(targetTime, shouldPlay) {
  if (!playerReady || !player) return;

  // ✅ хост не применяет sync к себе — источник истины
  if (isHost) return;

  const local = getTime();
  const diff = targetTime - local;
  const abs = Math.abs(diff);

  withSuppress(900, () => {
    if (abs > HARD_SYNC) {
      try { player.seekTo(targetTime, true); } catch {}
    } else if (abs > SOFT_SYNC) {
      setRateSafe(diff > 0 ? 1.04 : 0.96);
    } else {
      setRateSafe(1);
    }

    // play/pause применяем только если реально отличается
    try {
      if (shouldPlay) {
        if (!isPlaying()) player.playVideo();
      } else {
        if (isPlaying()) player.pauseVideo();
      }
    } catch {}
  });
}

// ---------- UI load button ----------
if (loadBtn) {
  loadBtn.addEventListener("click", (ev) => {
    ev.preventDefault(); // важно, чтобы форма не перезагружала страницу
    if (!isHost) return;

    const val = videoInput?.value?.trim();
    if (!val) return;

    socket.emit("video-load", { url: val, hostKey });
  });
}

// ---------- JOIN (у тебя это уже есть где-то, но на всякий) ----------
function joinIfNeeded() {
  // Если у тебя join делается в другом месте — ок.
  // Но payload обязательно должен содержать hostKey.
  // Здесь пример, если нужно:
  // socket.emit("join-room", { roomId: ROOM_ID, username: window.USERNAME, hostKey });
}

// ---------- SOCKET events ----------
socket.on("room-state", (state) => {
  isHost = !!state.me?.isHost;
  setHostUI();

  setStatus(isHost ? "✅ Ты HOST (только ты управляешь видео)" : "👀 Ты зритель (видео управляет HOST)");

  if (isHost) startHostSeekDetector();

  const vid = state.video?.videoId;
  if (vid) {
    ensurePlayer(vid);
    setTimeout(() => applySync(state.video.time || 0, !!state.video.playing), 350);
  }
});

socket.on("host-changed", () => {
  socket.emit("get-state");
});

socket.on("video-load", (data) => {
  // хост сам грузит, но пусть тоже гарантированно загрузится
  ensurePlayer(data.videoId);
  if (!isHost) setTimeout(() => applySync(0, false), 300);
});

socket.on("video-play", (data) => {
  applySync(Number(data?.time || 0), true);
});

socket.on("video-pause", (data) => {
  applySync(Number(data?.time || 0), false);
});

socket.on("video-seek", (data) => {
  // non-host: сохраняем текущий play-state хоста мы не знаем, поэтому лучше не трогать
  // но обычно seek идёт вместе с sync-time, поэтому просто сдвинем время
  applySync(Number(data?.time || 0), isPlaying());
});

socket.on("sync-time", (data) => {
  applySync(Number(data?.time || 0), !!data?.playing);
});

socket.on("video:denied", () => {
  // если кто-то пытался — покажем в статус
  if (statusEl && !isHost) setStatus("⛔ Только HOST может управлять видео");
});

// ---------- HOST beacon ----------
setInterval(() => {
  if (!isHost) return;
  if (!playerReady || !player) return;

  socket.emit("sync-time", {
    time: getTime(),
    playing: isPlaying(),
    hostKey
  });
}, SYNC_INTERVAL);