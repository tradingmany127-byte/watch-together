// server.js — STRICT HOST-ONLY VIDEO CONTROL (NO EXCEPTIONS)
// Express + Socket.IO. Rooms in memory. Empty room => deleted.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, "public")));

// -------------------- ROOMS --------------------
// room = {
//   id,
//   hostSocketId, hostName,
//   users: Map(socketId -> { name }),
//   video: { videoId, time, playing, updatedAt }
// }
const rooms = new Map();
const now = () => Date.now();

const digitsOnly = (s) => /^\d+$/.test(String(s || "").trim());
const safeNum = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

// YouTube ID parser: supports id, watch?v=, youtu.be, shorts, embed
function parseYouTubeId(input) {
  if (!input) return null;
  const s = String(input).trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  try {
    const u = new URL(s);

    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "").trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    const parts = u.pathname.split("/").filter(Boolean);

    const shorts = parts.indexOf("shorts");
    if (shorts >= 0 && parts[shorts + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[shorts + 1])) {
      return parts[shorts + 1];
    }

    const embed = parts.indexOf("embed");
    if (embed >= 0 && parts[embed + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[embed + 1])) {
      return parts[embed + 1];
    }
  } catch (_) {}

  return null;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      hostSocketId: null,
      hostName: null,
      users: new Map(),
      video: { videoId: null, time: 0, playing: false, updatedAt: now() },
    });
  }
  return rooms.get(roomId);
}

function liveTime(room) {
  if (!room.video.playing) return room.video.time;
  const dt = (now() - room.video.updatedAt) / 1000;
  return room.video.time + dt;
}

function isHost(socket, room) {
  return !!room && room.hostSocketId === socket.id;
}

// ⚠️ HOST НЕ МЕНЯЕТСЯ НИКОГДА.
// Если HOST вышел — комната становится "без хоста", и видео никому нельзя трогать,
// пока он не зайдёт снова (или ты решишь иначе).
function statePayload(room, socket) {
  const me = room.users.get(socket.id);
  return {
    roomId: room.id,
    me: { name: me?.name || "", isHost: room.hostSocketId === socket.id },
    host: { name: room.hostName, socketId: room.hostSocketId },
    usersCount: room.users.size,
    video: {
      videoId: room.video.videoId,
      time: liveTime(room),
      playing: room.video.playing,
      updatedAt: room.video.updatedAt,
    },
  };
}

function cleanupIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.users.size === 0) rooms.delete(roomId);
}

// -------------------- SOCKETS --------------------
io.on("connection", (socket) => {
  socket.data.roomId = null;

  // JOIN: { roomId, username }
  socket.on("join-room", (payload = {}) => {
    const roomId = String(payload.roomId || "").trim();
    const username = String(payload.username || payload.name || "").trim().slice(0, 32);

    if (!roomId) return socket.emit("join-error", { error: "MISSING_ID" });
    if (!digitsOnly(roomId)) return socket.emit("join-error", { error: "ONLY_DIGITS" });
    if (!username) return socket.emit("join-error", { error: "MISSING_NAME" });

    // leave previous
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.emit("leave-room");
    }

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    room.users.set(socket.id, { name: username });

    // ✅ HOST = СОЗДАТЕЛЬ: ПЕРВЫЙ ВОШЕДШИЙ В КОМНАТУ
    // И он НЕ меняется автоматически.
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
      room.hostName = username;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId, hostName: room.hostName });
    }

    socket.emit("room-state", statePayload(room, socket));
    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
      hostSocketId: room.hostSocketId,
    });
  });

  socket.on("leave-room", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => leaveCurrentRoom(socket, true));

  function leaveCurrentRoom(sock) {
    const roomId = sock.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    sock.leave(roomId);
    sock.data.roomId = null;

    if (!room) return;

    room.users.delete(sock.id);

    // ❗ HOST НЕ ПЕРЕНОСИМ.
    // Если вышел HOST — хост остаётся привязан к его socketId, видео управлять нельзя
    // до тех пор, пока он снова не зайдёт (или пока комната не удалится).
    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
      hostSocketId: room.hostSocketId,
    });

    cleanupIfEmpty(roomId);
  }

  // CHAT
  socket.on("chat-send", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const me = room.users.get(socket.id);
    if (!me) return;

    const text = String(payload.text || "").trim();
    if (!text) return;

    io.to(roomId).emit("chat-msg", { name: me.name, text, at: now() });
  });

  // -------------------- STRICT HOST-ONLY VIDEO --------------------
  function roomFromSocket() {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }

  function deny() {
    socket.emit("video:denied", { reason: "HOST_ONLY" });
  }

  function requireHost(room) {
    if (!room) return false;
    if (!isHost(socket, room)) {
      deny();
      return false;
    }
    return true;
  }

  // LOAD
  socket.on("video-load", (payload = {}) => {
    const room = roomFromSocket();
    if (!requireHost(room)) return;

    const raw = payload.videoId || payload.url || payload.videoUrl || payload.link || payload.id;
    const videoId = parseYouTubeId(raw);

    if (!videoId) {
      socket.emit("video:error", { error: "BAD_VIDEO" });
      return;
    }

    room.video.videoId = videoId;
    room.video.time = 0;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-load", { videoId, time: 0, playing: false });
  });

  // PLAY
  socket.on("video-play", (payload = {}) => {
    const room = roomFromSocket();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, liveTime(room));
    room.video.time = Math.max(0, t);
    room.video.playing = true;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-play", { time: room.video.time });
  });

  // PAUSE
  socket.on("video-pause", (payload = {}) => {
    const room = roomFromSocket();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, liveTime(room));
    room.video.time = Math.max(0, t);
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-pause", { time: room.video.time });
  });

  // SEEK
  socket.on("video-seek", (payload = {}) => {
    const room = roomFromSocket();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, 0);
    room.video.time = Math.max(0, t);
    room.video.updatedAt = now();

    io.to(room.id).emit("video-seek", { time: room.video.time });
  });

  // HOST BEACON (optional but good)
  socket.on("sync-time", (payload = {}) => {
    const room = roomFromSocket();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, liveTime(room));
    const playing = !!payload.playing;

    room.video.time = Math.max(0, t);
    room.video.playing = playing;
    room.video.updatedAt = now();

    io.to(room.id).emit("sync-time", {
      videoId: room.video.videoId,
      time: liveTime(room),
      playing: room.video.playing,
      updatedAt: room.video.updatedAt,
      hostSocketId: room.hostSocketId,
    });
  });

  // STATE REQUEST
  socket.on("get-state", () => {
    const room = roomFromSocket();
    if (!room) return;
    socket.emit("room-state", statePayload(room, socket));
  });
});

// -------------------- LISTEN --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));