const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.static(path.join(__dirname, "public")));

// roomId -> room
const rooms = new Map();
/**
room = {
  hostSocketId: string|null,
  hostName: string|null,
  videoId: string|null,
  playing: boolean,
  time: number,
  updatedAt: number,
  users: Map(socketId -> { username })
}
*/

function now() {
  return Date.now();
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostSocketId: null,
      hostName: null,
      videoId: null,
      playing: false,
      time: 0,
      updatedAt: now(),
      users: new Map(),
    });
  }
  return rooms.get(roomId);
}

// "живое" время (если playing)
function getServerTime(room) {
  if (!room.playing) return room.time;
  const dt = (now() - room.updatedAt) / 1000;
  return room.time + dt;
}

function emitMany(socketOrIo, eventNames, payload) {
  for (const ev of eventNames) socketOrIo.emit(ev, payload);
}

// для совместимости с разными client.js
const OUT = {
  ROOM_STATE: ["room-state", "roomState", "state"],
  ROOM_USERS: ["room-users", "roomUsers", "users"],
  HOST_CHANGED: ["host-changed", "hostChanged"],
  VIDEO_LOAD: ["video-load", "videoLoad", "load-video", "loadVideo"],
  VIDEO_PLAY: ["video-play", "videoPlay", "play-video", "playVideo"],
  VIDEO_PAUSE: ["video-pause", "videoPause", "pause-video", "pauseVideo"],
  VIDEO_SEEK: ["video-seek", "videoSeek", "seek-video", "seekVideo"],
  SYNC_TIME: ["sync-time", "syncTime", "sync"],
  CHAT_MSG: ["chat-msg", "chatMsg", "message"],
  JOIN_ERR: ["join-error", "joinError", "error-join"],
};

function roomStatePayload(room, roomId, socketId) {
  const me = room.users.get(socketId);
  return {
    roomId,
    me: { username: me?.username || "", isHost: room.hostSocketId === socketId },
    hostSocketId: room.hostSocketId,
    hostName: room.hostName,
    usersCount: room.users.size,
    videoId: room.videoId,
    playing: room.playing,
    time: getServerTime(room),
    updatedAt: room.updatedAt,
  };
}

function setHost(room, roomId, socketId) {
  room.hostSocketId = socketId;
  room.hostName = room.users.get(socketId)?.username || "HOST";
  io.to(roomId).emit(OUT.HOST_CHANGED[0], { hostSocketId: room.hostSocketId, hostName: room.hostName });
  // ещё дубль-ивенты для совместимости
  emitMany(io.to(roomId), OUT.HOST_CHANGED.slice(1), { hostSocketId: room.hostSocketId, hostName: room.hostName });
}

function pickNewHost(room) {
  const it = room.users.keys().next();
  return it.done ? null : it.value;
}

function isHost(room, socket) {
  return room && room.hostSocketId === socket.id;
}

io.on("connection", (socket) => {
  socket.data.roomId = null;

  // ---------- JOIN (aliases) ----------
  const joinHandler = (payload = {}) => {
    const roomId = String(payload.roomId || payload.room || payload.id || "").trim();
    const username = String(payload.username || payload.name || payload.user || "").trim();

    if (!roomId) return emitMany(socket, OUT.JOIN_ERR, { error: "MISSING_ROOM" });
    if (!/^\d+$/.test(roomId)) return emitMany(socket, OUT.JOIN_ERR, { error: "ONLY_DIGITS" });
    if (!username) return emitMany(socket, OUT.JOIN_ERR, { error: "MISSING_NAME" });

    // если был в другой комнате — выйти
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      leaveRoom(socket);
    }

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;

    room.users.set(socket.id, { username });

    // первый вошёл -> host
    if (!room.hostSocketId) {
      setHost(room, roomId, socket.id);
    }

    // отдать стейт вошедшему
    const st = roomStatePayload(room, roomId, socket.id);
    emitMany(socket, OUT.ROOM_STATE, st);

    // обновление для всех
    const usersPayload = { usersCount: room.users.size, hostName: room.hostName, hostSocketId: room.hostSocketId };
    emitMany(io.to(roomId), OUT.ROOM_USERS, usersPayload);

    // и продублируем текущий видео-стейт (чтобы у клиента панель/плеер появились)
    emitMany(socket, OUT.SYNC_TIME, {
      videoId: room.videoId,
      time: getServerTime(room),
      playing: room.playing,
      updatedAt: room.updatedAt,
    });
  };

  socket.on("join-room", joinHandler);
  socket.on("joinRoom", joinHandler);
  socket.on("join", joinHandler);

  // ---------- LEAVE ----------
  socket.on("leave-room", () => leaveRoom(socket));
  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("leave", () => leaveRoom(socket));

  socket.on("disconnect", () => leaveRoom(socket, true));

  function leaveRoom(sock, silent = false) {
    const roomId = sock.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    sock.leave(roomId);
    sock.data.roomId = null;
    if (!room) return;

    room.users.delete(sock.id);

    // если вышел host -> новый host
    if (room.hostSocketId === sock.id) {
      const newHostId = pickNewHost(room);
      if (newHostId) setHost(room, roomId, newHostId);
      else {
        room.hostSocketId = null;
        room.hostName = null;
      }
    }

    const usersPayload = { usersCount: room.users.size, hostName: room.hostName, hostSocketId: room.hostSocketId };
    emitMany(io.to(roomId), OUT.ROOM_USERS, usersPayload);

    if (room.users.size === 0) rooms.delete(roomId);
  }

  // ---------- CHAT (everyone) ----------
  const chatHandler = (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const me = room.users.get(socket.id);
    if (!me) return;

    const text = String(payload.text || payload.msg || payload.message || "").trim();
    if (!text) return;

    const msg = { name: me.username, text, at: now() };
    emitMany(io.to(roomId), OUT.CHAT_MSG, msg);
  };

  socket.on("chat-send", chatHandler);
  socket.on("chatSend", chatHandler);
  socket.on("chat", chatHandler);

  // ---------- VIDEO CONTROL (HOST ONLY) ----------
  // ВАЖНО: принимаем разные имена событий и разные ключи payload, чтобы client.js не ломался.

  function requireHost(room) {
    if (!isHost(room, socket)) return false;
    return true;
  }

  function handleLoad(payload = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!requireHost(room)) return;

    const videoId = String(payload.videoId || payload.id || payload.v || payload.video || "").trim();
    if (!videoId) return;

    room.videoId = videoId;
    room.playing = false;
    room.time = 0;
    room.updatedAt = now();

    emitMany(io.to(roomId), OUT.VIDEO_LOAD, { videoId });
    emitMany(io.to(roomId), OUT.SYNC_TIME, {
      videoId: room.videoId,
      time: 0,
      playing: false,
      updatedAt: room.updatedAt,
    });

    // обновим стейт (некоторые клиенты по нему рисуют панель)
    emitMany(io.to(roomId), OUT.ROOM_STATE, roomStatePayload(room, roomId, socket.id));
  }

  function handlePlay(payload = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!requireHost(room)) return;

    const t = Number(payload.time ?? payload.t ?? getServerTime(room));
    room.time = Number.isFinite(t) ? t : getServerTime(room);
    room.playing = true;
    room.updatedAt = now();

    emitMany(io.to(roomId), OUT.VIDEO_PLAY, { time: room.time });
  }

  function handlePause(payload = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!requireHost(room)) return;

    const t = Number(payload.time ?? payload.t ?? getServerTime(room));
    room.time = Number.isFinite(t) ? t : getServerTime(room);
    room.playing = false;
    room.updatedAt = now();

    emitMany(io.to(roomId), OUT.VIDEO_PAUSE, { time: room.time });
  }

  function handleSeek(payload = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!requireHost(room)) return;

    const t = Number(payload.time ?? payload.t ?? 0);
    room.time = Number.isFinite(t) ? Math.max(0, t) : room.time;
    room.updatedAt = now();

    emitMany(io.to(roomId), OUT.VIDEO_SEEK, { time: room.time });
  }

  function handleSync(payload = {}) {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (!requireHost(room)) return;

    const t = Number(payload.time ?? payload.t ?? getServerTime(room));
    const playing = !!(payload.playing ?? payload.isPlaying ?? payload.p);

    room.time = Number.isFinite(t) ? t : getServerTime(room);
    room.playing = playing;
    room.updatedAt = now();

    emitMany(io.to(roomId), OUT.SYNC_TIME, {
      videoId: room.videoId,
      time: getServerTime(room),
      playing: room.playing,
      updatedAt: room.updatedAt,
    });
  }

  // входящие алиасы
  socket.on("video-load", handleLoad);
  socket.on("videoLoad", handleLoad);
  socket.on("load-video", handleLoad);
  socket.on("loadVideo", handleLoad);

  socket.on("video-play", handlePlay);
  socket.on("videoPlay", handlePlay);
  socket.on("play-video", handlePlay);
  socket.on("playVideo", handlePlay);

  socket.on("video-pause", handlePause);
  socket.on("videoPause", handlePause);
  socket.on("pause-video", handlePause);
  socket.on("pauseVideo", handlePause);

  socket.on("video-seek", handleSeek);
  socket.on("videoSeek", handleSeek);
  socket.on("seek-video", handleSeek);
  socket.on("seekVideo", handleSeek);

  socket.on("sync-time", handleSync);
  socket.on("syncTime", handleSync);
  socket.on("sync", handleSync);

  // запрос состояния (aliases)
  const getState = () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    emitMany(socket, OUT.ROOM_STATE, roomStatePayload(room, roomId, socket.id));
  };
  socket.on("get-state", getState);
  socket.on("getState", getState);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server on", PORT));