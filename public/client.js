// client.js — STABLE HOST-ONLY SYNC (FIX STOPPING)
// Host = source of truth. Host DOES NOT apply sync events to itself.

const socket = io();

let player = null;
let playerReady = false;
let isHost = false;
let suppress = false;

const HARD_SYNC = 2.5;       // большой улёт -> seek
const SOFT_SYNC = 0.45;      // малый улёт -> скорость (без seek)
const SYNC_INTERVAL = 1100;  // как часто хост шлёт таймкод
const RATE_RESET_MS = 1200;

let rateTimer = null;

// ---------- UI ----------
const videoInput = document.getElementById("videoUrl");
const loadBtn = document.getElementById("loadBtn");

function setHostUI() {
  if (videoInput) videoInput.disabled = !isHost;
  if (loadBtn) loadBtn.disabled = !isHost;
}

if (loadBtn) {
  loadBtn.addEventListener("click", () => {
    if (!isHost) return;
    const val = videoInput?.value?.trim();
    if (!val) return;

    // важно: хост сам себе грузит сразу (не ждём ответ сервера)
    // сервер всё равно отправит участникам
    socket.emit("video-load", { url: val });
    // очистка инпута — норм, но видео должно появиться
    // (если хочешь — можешь убрать следующую строку)
    // videoInput.value = "";
  });
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
    // если уже есть — просто переключаем видео
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

        // full screen allow
        try {
          const iframe = player.getIframe();
          iframe.setAttribute("allowfullscreen", "true");
          iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
          iframe.style.width = "100%";
          iframe.style.height = "100%";
        } catch (_) {}
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

// ---------- HOST local control -> emit to server ----------
function onPlayerStateChange(e) {
  if (!playerReady) return;
  if (suppress) return;
  if (!isHost) return; // ✅ only host emits

  const time = getTime();

  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-play", { time });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-pause", { time });
  }
}

// ---------- APPLY SYNC (ONLY FOR NON-HOST) ----------
function applySync(targetTime, shouldPlay) {
  if (!playerReady || !player) return;

  // ✅ хост НЕ применяет синхрон к себе (это убирает “стопы”)
  if (isHost) return;

  const local = getTime();
  const diff = targetTime - local;
  const abs = Math.abs(diff);

  suppress = true;

  // 1) большой улёт — редкий seek
  if (abs > HARD_SYNC) {
    try { player.seekTo(targetTime, true); } catch {}
  }
  // 2) средний/малый улёт — скорость вместо seek
  else if (abs > SOFT_SYNC) {
    // чуть-чуть, чтобы не дёргалось
    setRateSafe(diff > 0 ? 1.02 : 0.98);
  } else {
    setRateSafe(1);
  }

  // play/pause только если реально отличается
  try {
    if (shouldPlay) {
      if (!isPlaying()) player.playVideo();
    } else {
      if (isPlaying()) player.pauseVideo();
    }
  } catch {}

  // дольше suppress, чтобы ютуб не зациклился
  setTimeout(() => { suppress = false; }, 250);
}

// ---------- SOCKET EVENTS ----------
socket.on("room-state", (state) => {
  isHost = !!state.me?.isHost;
  setHostUI();

  const vid = state.video?.videoId;
  if (vid) {
    ensurePlayer(vid);
    // применяем состояние только не-хосту
    setTimeout(() => applySync(state.video.time || 0, !!state.video.playing), 400);
  }
});

// важное: хост игнорит входящие video events (он сам источник)
socket.on("video-load", (data) => {
  if (isHost) return;
  if (data?.videoId) ensurePlayer(data.videoId);
});

socket.on("video-play", (data) => {
  applySync(Number(data?.time || 0), true);
});

socket.on("video-pause", (data) => {
  applySync(Number(data?.time || 0), false);
});

socket.on("video-seek", (data) => {
  // сохраняем текущий playing
  applySync(Number(data?.time || 0), isPlaying());
});

socket.on("sync-time", (data) => {
  applySync(Number(data?.time || 0), !!data?.playing);
});

// ---------- HOST BEACON ----------
setInterval(() => {
  if (!isHost) return;
  if (!playerReady || !player) return;

  socket.emit("sync-time", {
    time: getTime(),
    playing: isPlaying(),
  });
}, SYNC_INTERVAL);