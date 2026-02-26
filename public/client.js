// client.js — STABLE HOST-ONLY SYNC

const socket = io();

let player = null;
let playerReady = false;
let isHost = false;
let suppress = false;

const HARD_SYNC = 1.2;      // >1.2s → жесткий seek
const SOFT_SYNC = 0.25;     // 0.25–1.2s → мягкая подстройка
const SYNC_INTERVAL = 1000; // host beacon
const RATE_RESET_MS = 1200;

let rateTimer = null;

// ==========================
// UI
// ==========================

const videoInput = document.getElementById("videoUrl");
const loadBtn = document.getElementById("loadBtn");

if (loadBtn) {
  loadBtn.addEventListener("click", () => {
    if (!isHost) return;
    const val = videoInput?.value?.trim();
    if (!val) return;
    socket.emit("video-load", { url: val });
  });
}

// ==========================
// YOUTUBE
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

async function createPlayer(videoId) {
  await loadYT();

  if (player) {
    player.loadVideoById(videoId);
    return;
  }

  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId,
    playerVars: {
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
    },
    events: {
      onReady: () => {
        playerReady = true;
      },
      onStateChange: onPlayerStateChange
    }
  });

  setTimeout(() => {
    const iframe = document.querySelector("#player iframe");
    if (iframe) {
      iframe.setAttribute("allowfullscreen", "true");
      iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
    }
  }, 500);
}

function getTime() {
  if (!playerReady || !player) return 0;
  return player.getCurrentTime() || 0;
}

function isPlaying() {
  if (!playerReady || !player) return false;
  return player.getPlayerState() === YT.PlayerState.PLAYING;
}

// ==========================
// HOST EVENTS
// ==========================

function onPlayerStateChange(e) {
  if (!playerReady) return;
  if (suppress) return;
  if (!isHost) return;

  const time = getTime();

  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-play", { time });
  }

  if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-pause", { time });
  }
}

// ==========================
// SYNC APPLY
// ==========================

function applySync(targetTime, playing) {
  if (!playerReady) return;

  const local = getTime();
  const diff = targetTime - local;
  const abs = Math.abs(diff);

  suppress = true;

  if (abs > HARD_SYNC) {
    player.seekTo(targetTime, true);
  } else if (abs > SOFT_SYNC) {
    const rate = diff > 0 ? 1.05 : 0.95;
    try {
      player.setPlaybackRate(rate);
      if (rateTimer) clearTimeout(rateTimer);
      rateTimer = setTimeout(() => {
        try { player.setPlaybackRate(1); } catch {}
      }, RATE_RESET_MS);
    } catch {}
  }

  if (playing) {
    if (!isPlaying()) player.playVideo();
  } else {
    if (isPlaying()) player.pauseVideo();
  }

  setTimeout(() => suppress = false, 100);
}

// ==========================
// SOCKET
// ==========================

socket.on("room-state", (state) => {
  isHost = !!state.me?.isHost;

  if (videoInput) videoInput.disabled = !isHost;
  if (loadBtn) loadBtn.disabled = !isHost;

  const vid = state.video?.videoId;
  if (vid) {
    createPlayer(vid);
    setTimeout(() => {
      applySync(state.video.time || 0, state.video.playing);
    }, 500);
  }
});

socket.on("video-load", (data) => {
  createPlayer(data.videoId);
});

socket.on("video-play", (data) => {
  applySync(data.time, true);
});

socket.on("video-pause", (data) => {
  applySync(data.time, false);
});

socket.on("video-seek", (data) => {
  applySync(data.time, isPlaying());
});

socket.on("sync-time", (data) => {
  applySync(data.time, data.playing);
});

// ==========================
// HOST BEACON
// ==========================

setInterval(() => {
  if (!isHost) return;
  if (!playerReady) return;

  socket.emit("sync-time", {
    time: getTime(),
    playing: isPlaying()
  });
}, SYNC_INTERVAL);