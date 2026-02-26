// client.js — HOST ONLY + ANTI STOP (no playbackRate, no spam)

const socket = io();

let player = null;
let playerReady = false;

let isHost = false;
let hostToken = null;

let suppress = false;
let lastApplyAt = 0;

// drift sync: only seek if big, no playbackRate
const HARD_SYNC = 2.0;        // seconds
const APPLY_COOLDOWN = 900;   // ms
const SYNC_INTERVAL = 1500;   // ms (host beacon)
const EMIT_COOLDOWN = 700;    // ms

let lastEmitAt = 0;

// ---------- UI ----------
const videoInput = document.getElementById("videoUrl");
const loadBtn = document.getElementById("loadBtn");
const playerWrap = document.getElementById("playerWrap") || document.getElementById("player")?.parentElement;

function setHostUI() {
  if (videoInput) videoInput.disabled = !isHost;
  if (loadBtn) loadBtn.disabled = !isHost;
}

function nowMs() { return Date.now(); }

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

function withSuppress(ms, fn) {
  suppress = true;
  lastApplyAt = nowMs();
  try { fn(); } catch {}
  setTimeout(() => { suppress = false; }, ms);
}

// ---------- LOCK OVERLAY for non-host ----------
function ensureOverlayLocked() {
  if (!playerWrap) return;

  let ov = document.getElementById("playerLockOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "playerLockOverlay";
    ov.style.position = "absolute";
    ov.style.inset = "0";
    ov.style.zIndex = "10";
    ov.style.cursor = "not-allowed";
    ov.style.background = "transparent";
    ov.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    // parent must be relative
    const st = getComputedStyle(playerWrap);
    if (st.position === "static") playerWrap.style.position = "relative";
    playerWrap.appendChild(ov);
  }

  ov.style.display = isHost ? "none" : "block";
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

async function buildPlayer(videoId, controlsEnabled) {
  await loadYT();

  // если плеер уже есть — пересоздаём, чтобы реально сменить controls (YouTube иначе не всегда применяет)
  if (player) {
    try { player.destroy(); } catch {}
    player = null;
    playerReady = false;
  }

  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId: videoId || "",
    playerVars: {
      controls: controlsEnabled ? 1 : 0, // <-- ВАЖНО: не-хосту скрываем controls
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      fs: 1,
      disablekb: 1,
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

        ensureOverlayLocked();
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

async function ensurePlayer(videoId) {
  const controlsEnabled = !!isHost;
  await buildPlayer(videoId, controlsEnabled);
}

// ---------- Host emits ONLY stable events ----------
function onPlayerStateChange(e) {
  if (!playerReady || !player) return;
  if (!isHost) return;
  if (suppress) return;
  if (!hostToken) return;

  const s = e.data;

  // игнорим мусорные состояния
  if (
    s === YT.PlayerState.BUFFERING ||
    s === YT.PlayerState.CUED ||
    s === YT.PlayerState.UNSTARTED
  ) return;

  const now = nowMs();
  if (now - lastEmitAt < EMIT_COOLDOWN) return;

  const time = getTime();

  if (s === YT.PlayerState.PLAYING) {
    lastEmitAt = now;
    socket.emit("video-play", { time, hostToken });
  } else if (s === YT.PlayerState.PAUSED) {
    lastEmitAt = now;
    socket.emit("video-pause", { time, hostToken });
  }
}

// ---------- Apply sync (NON-HOST only) ----------
function applySync(targetTime, shouldPlay) {
  if (!playerReady || !player) return;
  if (isHost) return; // host doesn't follow others

  const now = nowMs();
  if (now - lastApplyAt < APPLY_COOLDOWN) return;

  const local = getTime();
  const diff = targetTime - local;
  const abs = Math.abs(diff);

  withSuppress(350, () => {
    if (abs > HARD_SYNC) {
      try { player.seekTo(targetTime, true); } catch {}
    }

    // play/pause минимально
    try {
      if (shouldPlay) {
        if (!isPlaying()) player.playVideo();
      } else {
        if (isPlaying()) player.pauseVideo();
      }
    } catch {}
  });
}

// ---------- UI load ----------
if (loadBtn) {
  loadBtn.addEventListener("click", () => {
    if (!isHost) return;
    if (!hostToken) return;

    const val = videoInput?.value?.trim();
    if (!val) return;

    socket.emit("video-load", { url: val, hostToken });
  });
}

// ---------- Socket ----------
socket.on("host-token", (d) => {
  // выдаётся ТОЛЬКО создателю комнаты
  hostToken = d?.hostToken || null;
});

socket.on("room-state", async (state) => {
  isHost = !!state.me?.isHost;
  setHostUI();
  ensureOverlayLocked();

  const vid = state.video?.videoId;

  // пересоздаём плеер под роль (host/non-host) и видео
  if (vid) {
    await ensurePlayer(vid);
    setTimeout(() => {
      applySync(state.video.time || 0, !!state.video.playing);
    }, 400);
  } else {
    // даже если видео нет — обновим overlay
    ensureOverlayLocked();
  }
});

socket.on("video-load", async (data) => {
  const vid = data?.videoId;
  if (!vid) return;
  await ensurePlayer(vid);
});

socket.on("video-play", (data) => {
  applySync(Number(data?.time || 0), true);
});
socket.on("video-pause", (data) => {
  applySync(Number(data?.time || 0), false);
});
socket.on("video-seek", (data) => {
  applySync(Number(data?.time || 0), isPlaying());
});
socket.on("sync-time", (data) => {
  applySync(Number(data?.time || 0), !!data?.playing);
});

// host beacon
setInterval(() => {
  if (!isHost) return;
  if (!playerReady || !player) return;
  if (!hostToken) return;

  socket.emit("sync-time", {
    time: getTime(),
    playing: isPlaying(),
    hostToken,
  });
}, SYNC_INTERVAL);