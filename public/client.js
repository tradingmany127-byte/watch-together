/* public/client.js */
(() => {
  // =========================
  // Helpers / DOM
  // =========================
  const $ = (id) => document.getElementById(id);

  // Ожидаемые элементы (если каких-то нет — код не падает)
  const roomIdEl = $("roomId");
  const usernameEl = $("username");
  const joinBtn = $("joinBtn");
  const leaveBtn = $("leaveBtn");
  const videoUrlEl = $("videoUrl");
  const loadBtn = $("loadBtn");
  const statusEl = $("status");
  const playerContainer = $("player");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
    console.log("[STATUS]", msg);
  }

  // =========================
  // Socket
  // =========================
  const socket = io();

  let currentRoomId = "";
  let isHost = false;

  // =========================
  // YouTube Player state
  // =========================
  let player = null;
  let playerReady = false;

  let currentVideoId = null;

  // чтобы не ловить циклы (локальное событие -> emit -> прилетело обратно)
  let suppressLocal = false;

  // очередь команд пока плеер не готов
  let pending = {
    load: null,   // { videoId, time, playing }
    seek: null,   // number
    play: null,   // number (time)
    pause: null,  // number (time)
  };

  // анти-спам синка
  const SYNC_THRESHOLD = 1.2;       // если расхождение больше — подгоняем
  const HARD_SYNC_THRESHOLD = 4.0;  // если очень улетели — жёстко
  let lastSeekAt = 0;

  // =========================
  // Parse YouTube ID
  // =========================
  function parseYouTubeId(input) {
    const s = String(input || "").trim();
    if (!s) return "";

    // если уже id
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

    try {
      const url = new URL(s);

      // youtu.be/ID
      if (url.hostname.includes("youtu.be")) {
        return url.pathname.replace("/", "").slice(0, 11);
      }

      // youtube.com/watch?v=ID
      if (url.hostname.includes("youtube.com")) {
        const v = url.searchParams.get("v");
        if (v) return v.slice(0, 11);

        // /shorts/ID
        const parts = url.pathname.split("/").filter(Boolean);
        const shortsIdx = parts.indexOf("shorts");
        if (shortsIdx >= 0 && parts[shortsIdx + 1]) return parts[shortsIdx + 1].slice(0, 11);

        // /embed/ID
        const embedIdx = parts.indexOf("embed");
        if (embedIdx >= 0 && parts[embedIdx + 1]) return parts[embedIdx + 1].slice(0, 11);
      }
    } catch (e) {}

    return "";
  }

  // =========================
  // Load YouTube Iframe API safely
  // =========================
  function loadYouTubeAPI() {
    return new Promise((resolve, reject) => {
      if (!playerContainer) {
        reject(new Error("Нет элемента #player на странице"));
        return;
      }

      // уже загружено
      if (window.YT && window.YT.Player) {
        resolve();
        return;
      }

      // если уже добавляли скрипт
      const exists = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      if (exists) {
        // ждём callback
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (window.YT && window.YT.Player) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - t0 > 15000) {
            clearInterval(timer);
            reject(new Error("YT API не загрузился за 15 сек"));
          }
        }, 100);
        return;
      }

      // стандартный callback от API
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        try { prev && prev(); } catch (e) {}
        resolve();
      };

      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      tag.onerror = () => reject(new Error("Не удалось загрузить https://www.youtube.com/iframe_api"));
      document.head.appendChild(tag);

      // страховка на случай если callback не сработает
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - t0 > 15000) {
          clearInterval(timer);
          reject(new Error("YT API не загрузился за 15 сек"));
        }
      }, 100);
    });
  }

  function ensurePlayer() {
    if (player || !playerContainer) return;

    loadYouTubeAPI()
      .then(() => {
        player = new YT.Player("player", {
          width: "100%",
          height: "100%",
          videoId: "",
          playerVars: {
            playsinline: 1,
            rel: 0,
            modestbranding: 1
          },
          events: {
            onReady: () => {
              playerReady = true;
              setStatus("✅ Плеер готов. Вставь ссылку или войди в комнату.");
              applyPending();
              hookPlayerEvents();
            },
            onStateChange: (e) => {
              if (suppressLocal) return;
              if (!currentRoomId) return;

              // host шлёт события
              if (!isHost) return;

              // 1 = playing, 2 = paused
              const st = e.data;
              if (st === YT.PlayerState.PLAYING) {
                emitPlay();
              } else if (st === YT.PlayerState.PAUSED) {
                emitPause();
              }
            }
          }
        });
      })
      .catch((err) => {
        console.error(err);
        setStatus("❌ Плеер не загрузился: " + err.message);
      });
  }

  function hookPlayerEvents() {
    // перемотка мышью/ползунком отлавливается плохо (YT не даёт event "seek"),
    // поэтому делаем лёгкий polling только для HOST, чтобы отследить резкий скачок времени.
    if (!isHost) return;

    let lastT = safeGetTime();
    setInterval(() => {
      if (!playerReady || !player || !currentRoomId || !isHost) return;

      const t = safeGetTime();
      const dt = Math.abs(t - lastT);

      // если скачок времени большой — это почти точно ручная перемотка
      if (dt > 1.0) {
        socket.emit("video-seek", { time: t });
      }
      lastT = t;
    }, 900);
  }

  // =========================
  // Player safe wrappers
  // =========================
  function safeGetTime() {
    try {
      if (!playerReady || !player || !player.getCurrentTime) return 0;
      const t = player.getCurrentTime();
      return Number.isFinite(t) ? t : 0;
    } catch (e) { return 0; }
  }

  function seekTo(t) {
    try {
      if (!playerReady || !player) return;
      player.seekTo(Number(t) || 0, true);
    } catch (e) {}
  }

  function playLocal() {
    try {
      if (!playerReady || !player) return;

      // mobile autoplay: если нельзя — просто не рухнет
      try { player.mute && player.mute(); } catch (e) {}

      const p = player.playVideo();
      // некоторые браузеры возвращают Promise
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {}
  }

  function pauseLocal() {
    try {
      if (!playerReady || !player) return;
      player.pauseVideo();
    } catch (e) {}
  }

  function applyPending() {
    if (!playerReady || !player) return;

    if (pending.load) {
      const { videoId, time, playing } = pending.load;
      pending.load = null;

      suppressLocal = true;
      try {
        currentVideoId = videoId || null;
        player.loadVideoById(videoId, Number(time) || 0);
        if (!playing) player.pauseVideo();
      } catch (e) {}
      setTimeout(() => { suppressLocal = false; }, 250);
    }

    if (pending.seek != null) {
      suppressLocal = true;
      seekTo(pending.seek);
      pending.seek = null;
      setTimeout(() => { suppressLocal = false; }, 200);
    }

    if (pending.play != null) {
      suppressLocal = true;
      seekTo(pending.play);
      playLocal();
      pending.play = null;
      setTimeout(() => { suppressLocal = false; }, 250);
    }

    if (pending.pause != null) {
      suppressLocal = true;
      seekTo(pending.pause);
      pauseLocal();
      pending.pause = null;
      setTimeout(() => { suppressLocal = false; }, 250);
    }
  }

  // =========================
  // Sync logic (client side)
  // =========================
  function maybeSyncToTarget(target, shouldBePlaying) {
    const cur = safeGetTime();
    const diff = Math.abs(cur - target);

    // 1) сильно улетели — редкий жёсткий seek
    if (diff > HARD_SYNC_THRESHOLD) {
      const now = Date.now();
      if (now - lastSeekAt > 2500) {
        lastSeekAt = now;
        seekTo(target);
      }
      return;
    }

    // 2) средний улёт — тоже редкий seek
    if (diff > SYNC_THRESHOLD) {
      const now = Date.now();
      if (now - lastSeekAt > 2500) {
        lastSeekAt = now;
        seekTo(target);
      }
      return;
    }

    // 3) маленький дрейф — ничего не делаем, иначе будет "дёргать"
    // (в YouTube смена скорости иногда ломает мобилки)
    if (shouldBePlaying) {
      // оставляем как есть
    }
  }

  // =========================
  // Emitters (host)
  // =========================
  function emitPlay() {
    if (!currentRoomId || !isHost) return;
    socket.emit("video-play", { time: safeGetTime() });
  }
  function emitPause() {
    if (!currentRoomId || !isHost) return;
    socket.emit("video-pause", { time: safeGetTime() });
  }

  // =========================
  // UI actions
  // =========================
  function joinRoom(roomId, username) {
    currentRoomId = String(roomId || "").trim();
    if (!currentRoomId) {
      setStatus("❌ Введи ID комнаты");
      return;
    }
    socket.emit("join-room", { roomId: currentRoomId, username: username || "User" });
    setStatus("⏳ Подключение к комнате...");
  }

  function leaveRoom() {
    if (!currentRoomId) return;
    socket.emit("leave-room");
    currentRoomId = "";
    isHost = false;
    setStatus("✅ Ты вышел из комнаты");
  }

  function loadVideoFromUI() {
    if (!isHost) {
      setStatus("⚠️ Только HOST может загружать видео");
      return;
    }
    const raw = videoUrlEl ? videoUrlEl.value : "";
    const videoId = parseYouTubeId(raw);
    if (!videoId) {
      setStatus("❌ Не смог распознать ссылку/ID");
      return;
    }
    currentVideoId = videoId;

    // хост загружает локально и рассылает всем
    if (!playerReady) {
      pending.load = { videoId, time: 0, playing: false };
      ensurePlayer();
      setStatus("⏳ Ждём плеер...");
      return;
    }

    suppressLocal = true;
    try {
      player.loadVideoById(videoId, 0);
      player.pauseVideo();
    } catch (e) {}
    setTimeout(() => { suppressLocal = false; }, 300);

    socket.emit("video-load", { videoId, time: 0, playing: false });
    setStatus("✅ Видео загружено (host).");
  }

  // =========================
  // Socket listeners
  // =========================
  socket.on("connect", () => {
    setStatus("✅ Соединение с сервером есть.");
    ensurePlayer(); // создаём плеер сразу
  });

  // сервер должен присылать статус комнаты
  // ожидаемый payload: { roomId, isHost, videoId, playing, time }
  socket.on("room-state", (state) => {
    try {
      if (!state) return;
      currentRoomId = state.roomId || currentRoomId;
      isHost = !!state.isHost;

      // если есть видео — применяем
      if (state.videoId) {
        currentVideoId = state.videoId;

        if (!playerReady) {
          pending.load = {
            videoId: state.videoId,
            time: Number(state.time) || 0,
            playing: !!state.playing
          };
          ensurePlayer();
          setStatus("⏳ Получил state, жду плеер...");
        } else {
          pending.load = {
            videoId: state.videoId,
            time: Number(state.time) || 0,
            playing: !!state.playing
          };
          applyPending();
          setStatus("✅ State применён.");
        }
      }

    } catch (e) {
      console.error(e);
    }
  });

  socket.on("video-load", ({ videoId, time, playing }) => {
    if (!videoId) return;
    if (!playerReady) {
      pending.load = { videoId, time: Number(time) || 0, playing: !!playing };
      ensurePlayer();
      setStatus("⏳ Видео пришло, жду плеер...");
      return;
    }

    pending.load = { videoId, time: Number(time) || 0, playing: !!playing };
    applyPending();
    setStatus("✅ Видео синхронизировано.");
  });

  socket.on("video-play", ({ time }) => {
    if (isHost) return;
    const target = Number(time) || 0;

    if (!playerReady) {
      pending.play = target;
      ensurePlayer();
      setStatus("⏳ Play пришёл, жду плеер...");
      return;
    }

    maybeSyncToTarget(target, true);
    suppressLocal = true;
    seekTo(target);
    playLocal();
    setTimeout(() => { suppressLocal = false; }, 250);
  });

  socket.on("video-pause", ({ time }) => {
    if (isHost) return;
    const target = Number(time) || 0;

    if (!playerReady) {
      pending.pause = target;
      ensurePlayer();
      setStatus("⏳ Pause пришёл, жду плеер...");
      return;
    }

    maybeSyncToTarget(target, false);
    suppressLocal = true;
    seekTo(target);
    pauseLocal();
    setTimeout(() => { suppressLocal = false; }, 250);
  });

  socket.on("video-seek", ({ time }) => {
    if (isHost) return;
    const target = Number(time) || 0;

    if (!playerReady) {
      pending.seek = target;
      ensurePlayer();
      setStatus("⏳ Seek пришёл, жду плеер...");
      return;
    }

    // seek делаем редким, чтобы не дёргало
    const now = Date.now();
    if (now - lastSeekAt > 800) {
      lastSeekAt = now;
      suppressLocal = true;
      seekTo(target);
      setTimeout(() => { suppressLocal = false; }, 200);
    }
  });

  // =========================
  // Bind UI
  // =========================
  if (joinBtn) {
    joinBtn.addEventListener("click", () => {
      const rid = roomIdEl ? roomIdEl.value : "";
      const un = usernameEl ? usernameEl.value : "User";
      joinRoom(rid, un);
    });
  }
  if (leaveBtn) {
    leaveBtn.addEventListener("click", () => leaveRoom());
  }
  if (loadBtn) {
    loadBtn.addEventListener("click", () => loadVideoFromUI());
  }

  // Auto-fill room from URL /room/123?name=x&asCreator=1
  try {
    const pathParts = location.pathname.split("/").filter(Boolean);
    const isRoomPath = pathParts[0] === "room" && pathParts[1];
    if (isRoomPath && roomIdEl) roomIdEl.value = pathParts[1];

    const q = new URLSearchParams(location.search);
    if (usernameEl && q.get("name")) usernameEl.value = q.get("name");
  } catch (e) {}

})();