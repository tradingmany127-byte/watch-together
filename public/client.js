// client.js — HOST CLAIM + STABLE SYNC (NO STOPPING)
// Host is the only controller. Non-host gets overlay on player (no clicks).

const socket = io();

let player = null;
let playerReady = false;

let myIsHost = false;
let currentHostSocketId = null;

let suppress = false;

// sync tuning
const HARD_SYNC = 2.5;       // big drift => seek
const SOFT_SYNC = 0.45;      // small drift => slight rate
const SYNC_INTERVAL = 1100;  // host beacon
const RATE_RESET_MS = 1200;

let rateTimer = null;

// host seek detector
let hostWatchTimer = null;
let lastHostTime = 0;
let lastHostEmitAt = 0;
const SEEK_DETECT_JUMP = 1.6;     // seconds jump to consider manual seek
const SEEK_DETECT_COOLDOWN = 600; // ms

// ==========================
// UI nodes
// ==========================
const videoInput = document.getElementById("videoUrl");
const loadBtn = document.getElementById("loadBtn");

const claimHostBtn = document.getElementById("claimHostBtn");
const hostModalBackdrop = document.getElementById("hostModalBackdrop");
const hostModalCancel = document.getElementById("hostModalCancel");
const hostModalConfirm = document.getElementById("hostModalConfirm");

const playerBlocker = document.getElementById("playerBlocker"); // overlay div over player

function openHostModal() {
  if (!hostModalBackdrop) return;
  hostModalBackdrop.classList.remove("hidden");
}
function closeHostModal() {
  if (!hostModalBackdrop) return;
  hostModalBackdrop.classList.add("hidden");
}

function setHostUI() {
  // Only host can load
  if (videoInput) videoInput.disabled = !myIsHost;
  if (loadBtn) loadBtn.disabled = !myIsHost;

  // Block clicks on player for non-host
  if (playerBlocker) {
    playerBlocker.style.display = myIsHost ? "none" : "block";
  }
}

if (claimHostBtn) {
  claimHostBtn.addEventListener("click", () => {
    openHostModal();
  });
}
if (hostModalCancel) {
  hostModalCancel.addEventListener("click", () => closeHostModal());
}
if (hostModalConfirm) {
  hostModalConfirm.addEventListener("click", () => {
    closeHostModal();
    socket.emit("host-claim");
  });
}

// load button
if (loadBtn) {
  loadBtn.addEventListener("click", () => {
    if (!myIsHost) return;
    const val = videoInput?.value?.trim();
    if (!val) return;
    socket.emit("video-load", { url: val });
  });
}

// ==========================
// YouTube API
// ==========================
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
    if (videoId) player.loadVideoById(videoId);
    return;
  }

  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId: videoId || "",
    playerVars: {
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        playerReady = true;

        // allow fullscreen
        try {
          const iframe = player.getIframe();
          iframe.setAttribute("allowfullscreen", "true");
          iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
          iframe.style.width = "100%";
          iframe.style.height = "100%";
        } catch (_) {}

        // start/stop host watcher if role changed
        updateHostWatcher();
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

function getTime() {
  if (!playerReady || !player) return 0;
  try { return player.getCurrentTime() || 0; } catch { return 0; }
}
function isPlaying() {
  if (!playerReady || !player) return false;
  try { return player.getPlayerState() === YT.PlayerState.PLAYING; } catch { return false; }
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

// ==========================
// Host emits (only host)
// ==========================
function onPlayerStateChange(e) {
  if (!playerReady) return;
  if (suppress) return;
  if (!myIsHost) return;

  const t = getTime();

  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-play", { time: t });
    lastHostEmitAt = Date.now();
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-pause", { time: t });
    lastHostEmitAt = Date.now();
  }
}

// Detect manual seeks on host reliably (because YouTube doesn’t always give a clean seek event)
function updateHostWatcher() {
  if (hostWatchTimer) {
    clearInterval(hostWatchTimer);
    hostWatchTimer = null;
  }
  if (!myIsHost || !playerReady) return;

  lastHostTime = getTime();

  hostWatchTimer = setInterval(() => {
    if (!myIsHost || !playerReady) return;
    if (suppress) return;

    const t = getTime();
    const diff = Math.abs(t - lastHostTime);

    // if jumped a lot quickly => manual seek
    if (diff >= SEEK_DETECT_JUMP) {
      const nowMs = Date.now();
      if (nowMs - lastHostEmitAt > SEEK_DETECT_COOLDOWN) {
        socket.emit("video-seek", { time: t });
        lastHostEmitAt = nowMs;
      }
    }

    lastHostTime = t;
  }, 350);
}

// ==========================
// Apply sync (only non-host)
// ==========================
function applySync(targetTime, shouldPlay) {
  if (!playerReady || !player) return;

  // host never applies sync to itself (prevents jitter / “stops”)
  if (myIsHost) return;

  const local = getTime();
  const diff = targetTime - local;
  const abs = Math.abs(diff);

  suppress = true;

  if (abs > HARD_SYNC) {
    try { player.seekTo(targetTime, true); } catch {}
  } else if (abs > SOFT_SYNC) {
    setRateSafe(diff > 0 ? 1.02 : 0.98);
  } else {
    setRateSafe(1);
  }

  try {
    if (shouldPlay) {
      if (!isPlaying()) player.playVideo();
    } else {
      if (isPlaying()) player.pauseVideo();
    }
  } catch {}

  setTimeout(() => { suppress = false; }, 250);
}

// ==========================
// Socket events
// ==========================
socket.on("room-state", (state) => {
  myIsHost = !!state?.me?.isHost;
  currentHostSocketId = state?.host?.socketId || null;
  setHostUI();

  // If role changed — restart watcher
  updateHostWatcher();

  const vid = state?.video?.videoId;
  if (vid) {
    ensurePlayer(vid);
    setTimeout(() => {
      applySync(state.video.time || 0, !!state.video.playing);
    }, 400);
  }
});

socket.on("host-changed", (data) => {
  currentHostSocketId = data?.hostSocketId || null;
  // role recalculated via room-state, but UI should react fast too:
  socket.emit("get-state");
});

// Strict: non-host ignores load events if they are host (host already has source of truth)
socket.on("video-load", (data) => {
  if (myIsHost) return;
  if (data?.videoId) ensurePlayer(data.videoId);
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

// for debug/UX
socket.on("video:denied", () => {
  // можно вывести тост/лог если хочешь
});

// ==========================
// Host beacon
// ==========================
setInterval(() => {
  if (!myIsHost) return;
  if (!playerReady || !player) return;

  socket.emit("sync-time", {
    time: getTime(),
    playing: isPlaying(),
  });
}, SYNC_INTERVAL);