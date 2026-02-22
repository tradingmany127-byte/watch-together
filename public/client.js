/* ==========================
   Watch Night — client.js
   Voice (WebRTC) + Settings + YouTube Sync + Chat
   ========================== */

(() => {
  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg, ok = true) => {
    const el = $("statusLine");
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok ? "" : "#ff8b8b";
  };

  function parseYouTubeId(input) {
    const s = String(input || "").trim();
    if (!s) return null;

    // If already id
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

    try {
      const url = new URL(s);
      // youtu.be/<id>
      if (url.hostname.includes("youtu.be")) {
        const id = url.pathname.split("/").filter(Boolean)[0];
        if (id && id.length >= 11) return id.slice(0, 11);
      }
      // youtube.com/watch?v=<id>
      if (url.searchParams.get("v")) {
        const id = url.searchParams.get("v");
        if (id) return id.slice(0, 11);
      }
      // youtube.com/embed/<id>
      const m = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    } catch {}
    // fallback: find 11-char id in string
    const m2 = s.match(/([a-zA-Z0-9_-]{11})/);
    return m2 ? m2[1] : null;
  }

  // ---------- DOM ----------
  const roomIdEl = $("roomId");
  const usernameEl = $("username");
  const joinBtn = $("joinBtn");
  const hostBtn = $("hostBtn");
  const rolePill = $("rolePill");
  const leaveBtn = $("leaveBtn");

  const ytLinkEl = $("ytLink");
  const sendVideoBtn = $("sendVideoBtn");
  const videoOverlay = $("videoOverlay");

  const chatBox = $("chatBox");
  const chatInput = $("chatInput");
  const chatSendBtn = $("chatSendBtn");

  const voiceBtn = $("voiceBtn");

  const settingsBtn = $("settingsBtn");
  const settingsMenu = $("settingsMenu");
  const copyInviteBtn = $("copyInviteBtn");
  const autoSyncToggle = $("autoSyncToggle");

  // ---------- Socket ----------
  const socket = io();

  let currentRoomId = null;
  let myRole = "viewer";
  let hostSocketId = null;

  // ---------- Settings menu (WORKING) ----------
  function closeSettingsMenu() {
    if (!settingsMenu) return;
    settingsMenu.classList.remove("open");
  }
  function toggleSettingsMenu() {
    if (!settingsMenu) return;
    settingsMenu.classList.toggle("open");
  }

  if (settingsBtn && settingsMenu) {
    settingsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettingsMenu();
    });

    document.addEventListener("click", (e) => {
      if (!settingsMenu.classList.contains("open")) return;
      if (settingsMenu.contains(e.target) || settingsBtn.contains(e.target)) return;
      closeSettingsMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSettingsMenu();
    });
  }

  // Persist autosync checkbox
  if (autoSyncToggle) {
    const saved = localStorage.getItem("wn_autosync");
    if (saved !== null) autoSyncToggle.checked = saved === "1";
    autoSyncToggle.addEventListener("change", () => {
      localStorage.setItem("wn_autosync", autoSyncToggle.checked ? "1" : "0");
    });
  }

  // Copy invite link
  if (copyInviteBtn) {
    copyInviteBtn.addEventListener("click", async () => {
      try {
        if (!currentRoomId) {
          setStatus("Сначала зайди в комнату, чтобы скопировать ссылку.", false);
          return;
        }
        const url = new URL(window.location.href);
        url.searchParams.set("room", currentRoomId);
        await navigator.clipboard.writeText(url.toString());
        setStatus("✅ Invite link скопирован в буфер обмена.");
      } catch (e) {
        setStatus("❌ Не удалось скопировать ссылку (браузер запретил).", false);
      }
    });
  }

  // Auto-fill room from URL ?room=123
  try {
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    if (r && roomIdEl) roomIdEl.value = r;
  } catch {}

  // ---------- YouTube Player ----------
  let player = null;
  let ytReadyPoll = null;
  let ytVideoId = null;
  let suppressPlayerEvents = false;

  function ensurePlayer() {
    if (player) return;
    // wait for YT API
    if (!window.YT || !window.YT.Player) return;

    player = new YT.Player("player", {
      height: "390",
      width: "640",
      videoId: ytVideoId || undefined,
      playerVars: {
        rel: 0,
        modestbranding: 1,
      },
      events: {
        onReady: () => {
          setStatus("✅ Плеер готов. Войди в комнату.");
        },
        onStateChange: (e) => {
          if (!currentRoomId) return;
          const autosync = autoSyncToggle ? autoSyncToggle.checked : true;
          if (!autosync) return;

          // Only host should emit control signals
          if (socket.id !== hostSocketId) return;

          if (suppressPlayerEvents) return;

          const t = safeGetTime();
          // YT states: 1 play, 2 pause
          if (e.data === 1) socket.emit("video-play", { roomId: currentRoomId, time: t });
          if (e.data === 2) socket.emit("video-pause", { roomId: currentRoomId, time: t });
        },
      },
    });
  }

  // polling init
  ytReadyPoll = setInterval(() => {
    if (window.YT && window.YT.Player) {
      clearInterval(ytReadyPoll);
      ensurePlayer();
    }
  }, 100);

  function safeGetTime() {
    try {
      return player ? Number(player.getCurrentTime() || 0) : 0;
    } catch {
      return 0;
    }
  }

  function safeSeek(t) {
    if (!player) return;
    suppressPlayerEvents = true;
    try {
      player.seekTo(Number(t || 0), true);
    } catch {}
    setTimeout(() => (suppressPlayerEvents = false), 200);
  }

  function safePlay() {
    if (!player) return;
    suppressPlayerEvents = true;
    try {
      player.playVideo();
    } catch {}
    setTimeout(() => (suppressPlayerEvents = false), 200);
  }

  function safePause() {
    if (!player) return;
    suppressPlayerEvents = true;
    try {
      player.pauseVideo();
    } catch {}
    setTimeout(() => (suppressPlayerEvents = false), 200);
  }

  function loadVideo(id, startTime = 0) {
    ytVideoId = id;
    if (videoOverlay) videoOverlay.style.display = "none";
    ensurePlayer();
    if (!player) return;

    suppressPlayerEvents = true;
    try {
      player.loadVideoById({ videoId: id, startSeconds: Number(startTime || 0) });
    } catch {}
    setTimeout(() => (suppressPlayerEvents = false), 400);
  }

  // ---------- UI actions ----------
  function updateRoleUI() {
    if (rolePill) rolePill.textContent = `Role: ${myRole}`;
  }

  if (hostBtn) {
    hostBtn.addEventListener("click", () => {
      myRole = "host";
      updateRoleUI();
      setStatus("ℹ️ Роль Host выбрана. Зайди в комнату или переподключись.");
    });
  }

  if (joinBtn) {
    joinBtn.addEventListener("click", () => {
      const roomId = String(roomIdEl?.value || "").trim();
      const username = String(usernameEl?.value || "").trim();

      if (!roomId) return setStatus("❌ Введи Room ID.", false);
      if (!username) return setStatus("❌ Введи имя пользователя.", false);

      socket.emit("join-room", { roomId, username, role: myRole });
    });
  }

  if (leaveBtn) {
    leaveBtn.addEventListener("click", () => {
      socket.emit("leave-room");
      currentRoomId = null;
      hostSocketId = null;
      leaveBtn.disabled = true;
      setStatus("✅ Ты вышел из комнаты.");
      stopVoice();
    });
  }

  if (sendVideoBtn) {
    sendVideoBtn.addEventListener("click", () => {
      if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.", false);
      if (socket.id !== hostSocketId) return setStatus("❌ Только Host может отправлять видео.", false);

      const id = parseYouTubeId(ytLinkEl?.value || "");
      if (!id) return setStatus("❌ Нужна корректная YouTube ссылка/ID.", false);

      socket.emit("video-set", { roomId: currentRoomId, videoId: id, time: 0 });
    });
  }

  // chat send
  function sendChat() {
    if (!currentRoomId) return setStatus("❌ Сначала зайди в комнату.", false);
    const username = String(usernameEl?.value || "").trim() || "anon";
    const text = String(chatInput?.value || "").trim();
    if (!text) return;
    socket.emit("chat-msg", { roomId: currentRoomId, username, text });
    chatInput.value = "";
  }

  if (chatSendBtn) chatSendBtn.addEventListener("click", sendChat);
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });
  }

  function addChatLine(username, text) {
    if (!chatBox) return;
    const div = document.createElement("div");
    div.className = "chatLine";
    div.innerHTML = `<b>${escapeHtml(username)}:</b> ${escapeHtml(text)}`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ---------- Socket handlers ----------
  socket.on("error-msg", (msg) => setStatus("❌ " + msg, false));

  socket.on("room-state", (st) => {
    currentRoomId = st.roomId;
    hostSocketId = st.hostSocketId || null;

    leaveBtn && (leaveBtn.disabled = false);

    // if got video state
    if (st.videoId) {
      loadVideo(st.videoId, st.time || 0);
      // apply play/pause
      if (st.playing) safePlay();
      else safePause();
    } else {
      if (videoOverlay) videoOverlay.style.display = "flex";
    }

    setStatus(`✅ В комнате: ${currentRoomId}. Host: ${hostSocketId === socket.id ? "ты" : "другой"}.`);
    // if voice already enabled, refresh peers
    if (voiceEnabled) rebuildVoicePeers(st.users || []);
  });

  socket.on("host-changed", ({ hostSocketId: hid }) => {
    hostSocketId = hid || null;
    setStatus(`ℹ️ Новый Host: ${hostSocketId === socket.id ? "ты" : hostSocketId}`);
  });

  socket.on("chat-msg", ({ username, text }) => addChatLine(username, text));

  socket.on("video-set", ({ videoId, time }) => {
    if (videoId) loadVideo(videoId, time || 0);
    setStatus("✅ Видео обновлено.");
  });

  socket.on("video-play", ({ time }) => {
    // Seek a bit then play (better sync)
    safeSeek(time || 0);
    safePlay();
  });

  socket.on("video-pause", ({ time }) => {
    safeSeek(time || 0);
    safePause();
  });

  socket.on("video-seek", ({ time }) => {
    safeSeek(time || 0);
  });

  socket.on("users-update", (users) => {
    // if voice enabled, ensure peers for new users
    if (voiceEnabled) rebuildVoicePeers(users || []);
  });

  // ---------- VOICE (WebRTC) ----------
  // Uses server signaling events:
  // webrtc-offer {to, offer}, webrtc-answer {to, answer}, webrtc-ice {to, candidate}

  let voiceEnabled = false;
  let localStream = null;
  const peers = new Map(); // peerId -> { pc, audioEl }

  function iAmInitiator(peerId) {
    // deterministic: smaller id starts offer (avoid double offers)
    return String(socket.id) < String(peerId);
  }

  async function startVoice() {
    if (!currentRoomId) {
      setStatus("❌ Сначала зайди в комнату, потом включай Voice.", false);
      return;
    }
    if (voiceEnabled) return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      voiceEnabled = true;
      if (voiceBtn) voiceBtn.textContent = "🎙 Voice (вкл)";
      setStatus("✅ Voice включён. Разрешение на микрофон получено.");

      // Ask server for freshest state/users
      socket.emit("request-sync", { roomId: currentRoomId });
    } catch (e) {
      voiceEnabled = false;
      localStream = null;
      if (voiceBtn) voiceBtn.textContent = "🎙 Voice (вкл)";
      setStatus("❌ Микрофон не доступен (разреши доступ в браузере).", false);
    }
  }

  function stopVoice() {
    voiceEnabled = false;
    if (voiceBtn) voiceBtn.textContent = "🎙 Voice (вкл)";

    for (const [peerId, obj] of peers.entries()) {
      try { obj.pc.close(); } catch {}
      if (obj.audioEl) obj.audioEl.remove();
      peers.delete(peerId);
    }

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    setStatus("ℹ️ Voice выключен.");
  }

  function ensureRemoteAudio(peerId) {
    let el = document.getElementById(`wn-audio-${peerId}`);
    if (el) return el;
    el = document.createElement("audio");
    el.id = `wn-audio-${peerId}`;
    el.autoplay = true;
    el.playsInline = true;
    // keep hidden
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  }

  function createPeer(peerId) {
    if (!voiceEnabled || !localStream) return null;
    if (peers.has(peerId)) return peers.get(peerId).pc;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // add local audio track
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    const audioEl = ensureRemoteAudio(peerId);

    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      if (stream) audioEl.srcObject = stream;
    };

    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        socket.emit("webrtc-ice", {
          roomId: currentRoomId,
          to: peerId,
          candidate: evt.candidate,
        });
      }
    };

    peers.set(peerId, { pc, audioEl });
    return pc;
  }

  async function rebuildVoicePeers(users) {
    if (!voiceEnabled || !localStream) return;
    // users = [{id, username, role}]
    const others = users.map((u) => u.id).filter((id) => id && id !== socket.id);

    // remove old peers not present
    for (const peerId of Array.from(peers.keys())) {
      if (!others.includes(peerId)) {
        const obj = peers.get(peerId);
        try { obj.pc.close(); } catch {}
        if (obj.audioEl) obj.audioEl.remove();
        peers.delete(peerId);
      }
    }

    // create missing peers
    for (const peerId of others) {
      const pc = createPeer(peerId);
      if (!pc) continue;

      // initiator creates offer
      if (iAmInitiator(peerId)) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit("webrtc-offer", {
            roomId: currentRoomId,
            to: peerId,
            offer: pc.localDescription,
          });
        } catch (e) {
          // ignore
        }
      }
    }
  }

  socket.on("webrtc-offer", async ({ from, offer }) => {
    if (!voiceEnabled || !localStream) return;
    if (!from || !offer) return;

    const pc = createPeer(from);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", {
        roomId: currentRoomId,
        to: from,
        answer: pc.localDescription,
      });
    } catch (e) {
      // ignore
    }
  });

  socket.on("webrtc-answer", async ({ from, answer }) => {
    if (!voiceEnabled || !localStream) return;
    if (!from || !answer) return;

    const obj = peers.get(from);
    if (!obj) return;

    try {
      await obj.pc.setRemoteDescription(answer);
    } catch (e) {
      // ignore
    }
  });

  socket.on("webrtc-ice", async ({ from, candidate }) => {
    if (!voiceEnabled || !localStream) return;
    if (!from || !candidate) return;

    const obj = peers.get(from);
    if (!obj) return;

    try {
      await obj.pc.addIceCandidate(candidate);
    } catch (e) {
      // ignore
    }
  });

  if (voiceBtn) {
    voiceBtn.addEventListener("click", async () => {
      // toggle
      if (!voiceEnabled) {
        await startVoice();
      } else {
        stopVoice();
      }
    });
  }

  // ---------- On load ----------
  updateRoleUI();
  setStatus("✅ Плеер готов. Войди в комнату.");

})();