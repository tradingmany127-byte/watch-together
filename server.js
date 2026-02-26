// server.js — STRICT HOST-ONLY CONTROL (token based)
// Express + Socket.IO, in-memory rooms.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const now = () => Date.now();
const digitsOnly = (s) => /^\d+$/.test(String(s || "").trim());
const safeNum = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

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
    if (shorts >= 0 && parts[shorts + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[shorts + 1])) return parts[shorts + 1];
    const embed = parts.indexOf("embed");
    if (embed >= 0 && parts[embed + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[embed + 1])) return parts[embed + 1];
  } catch {}
  return null;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      hostSocketId: null,
      hostName: null,
      hostToken: null, // <-- ключ хоста
      users: new Map(), // socketId -> { name }
      video: { videoId: null, time: 0, playing: false, updatedAt: now() },
    });
  }
  return rooms.get(roomId);
}

function liveTime(room) {
  if (!room.video.playing) return room.video.time;
  return room.video.time + (now() - room.video.updatedAt) / 1000;
}

function statePayload(room, socketId) {
  const me = room.users.get(socketId);
  return {
    roomId: room.id,
    me: { name: me?.name || "", isHost: room.hostSocketId === socketId },
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

// Проверка хоста ПО ТОКЕНУ (а не только socketId)
function requireHost(socket, room, payload) {
  if (!room || !room.hostSocketId || !room.hostToken) return false;
  const token = payload?.hostToken;
  if (!token) return false;
  return token === room.hostToken && socket.id === room.hostSocketId;
}

function cleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.users.size === 0) rooms.delete(roomId);
}

io.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("join-room", (payload = {}) => {
    const roomId = String(payload.roomId || "").trim();
    const username = String(payload.username || payload.name || "").trim().slice(0, 32);

    if (!roomId) return socket.emit("join-error", { error: "MISSING_ID" });
    if (!digitsOnly(roomId)) return socket.emit("join-error", { error: "ONLY_DIGITS" });
    if (!username) return socket.emit("join-error", { error: "MISSING_NAME" });

    // leave previous room
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(socket.data.roomId);
      socket.data.roomId = null;
    }

    const room = ensureRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;

    room.users.set(socket.id, { name: username });

    // Host = first user in room
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
      room.hostName = username;
      room.hostToken = crypto.randomBytes(16).toString("hex"); // <-- генерим токен
      socket.emit("host-token", { hostToken: room.hostToken }); // <-- выдаём только хосту
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId, hostName: room.hostName });
    }

    socket.emit("room-state", statePayload(room, socket.id));
    io.to(roomId).emit("room-users", { usersCount: room.users.size, hostName: room.hostName });
  });

  socket.on("leave-room", () => leave());
  socket.on("disconnect", () => leave());

  function leave() {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    socket.leave(roomId);
    socket.data.roomId = null;

    if (!room) return;
    room.users.delete(socket.id);

    // если хост ушёл — управление НИКОМУ (комната “заморожена”)
    io.to(roomId).emit("room-users", { usersCount: room.users.size, hostName: room.hostName });

    cleanup(roomId);
  }

  // ---------------- VIDEO (HOST ONLY) ----------------

  socket.on("video-load", (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!requireHost(socket, room, payload)) return socket.emit("video:denied", { reason: "HOST_ONLY" });

    const raw = payload.url || payload.videoId || payload.id;
    const videoId = parseYouTubeId(raw);
    if (!videoId) return socket.emit("video:error", { error: "BAD_VIDEO" });

    room.video.videoId = videoId;
    room.video.time = 0;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-load", { videoId, time: 0, playing: false });
  });

  socket.on("video-play", (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!requireHost(socket, room, payload)) return;

    const t = Math.max(0, safeNum(payload.time, liveTime(room)));
    room.video.time = t;
    room.video.playing = true;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-play", { time: t });
  });

  socket.on("video-pause", (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!requireHost(socket, room, payload)) return;

    const t = Math.max(0, safeNum(payload.time, liveTime(room)));
    room.video.time = t;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-pause", { time: t });
  });

  socket.on("video-seek", (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!requireHost(socket, room, payload)) return;

    const t = Math.max(0, safeNum(payload.time, 0));
    room.video.time = t;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-seek", { time: t });
  });

  // Host beacon: only host can send, server rebroadcasts
  socket.on("sync-time", (payload = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!requireHost(socket, room, payload)) return;

    const t = Math.max(0, safeNum(payload.time, liveTime(room)));
    const playing = !!payload.playing;

    room.video.time = t;
    room.video.playing = playing;
    room.video.updatedAt = now();

    io.to(roomId).emit("sync-time", { time: liveTime(room), playing, videoId: room.video.videoId });
  });

  socket.on("get-state", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit("room-state", statePayload(room, socket.id));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));