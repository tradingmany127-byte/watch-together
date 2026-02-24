const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// room state in memory
const rooms = new Map();
// room = { hostSocketId, videoId, playing, time, updatedAt, users: Map(socketId->{username,role}) }

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostSocketId: null,
      videoId: null,
      playing: false,
      time: 0,
      updatedAt: Date.now(),
      users: new Map()
    });
  }
  return rooms.get(roomId);
}

function calcNowTime(room) {
  if (!room) return 0;
  if (!room.playing) return Number(room.time || 0);
  const elapsed = (Date.now() - (room.updatedAt || Date.now())) / 1000;
  return Math.max(0, Number(room.time || 0) + elapsed);
}

function usersPayload(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({
    id,
    username: u.username,
    role: u.role
  }));
}

function snapshot(roomId, room) {
  return {
    roomId,
    hostSocketId: room.hostSocketId,
    videoId: room.videoId,
    playing: room.playing,
    time: calcNowTime(room),
    updatedAt: Date.now(),
    users: usersPayload(room)
  };
}

function isHost(room, socketId) {
  return room && room.hostSocketId && room.hostSocketId === socketId;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, username, role }) => {
    try {
      roomId = String(roomId || "").trim();
      username = String(username || "").trim();
      role = String(role || "viewer").trim();

      if (!roomId) return socket.emit("error-msg", "Room ID пустой.");
      if (!username) return socket.emit("error-msg", "Username пустой.");
      if (role !== "host" && role !== "viewer") role = "viewer";

      const room = ensureRoom(roomId);

      socket.join(roomId);
      room.users.set(socket.id, { username, role });
      socket.data.roomId = roomId;

      // assign host if none
      if (!room.hostSocketId) room.hostSocketId = socket.id;

      socket.emit("room-state", snapshot(roomId, room));
      socket.to(roomId).emit("user-joined", { id: socket.id, username, role });
      io.to(roomId).emit("users-update", usersPayload(room));
    } catch (e) {
      socket.emit("error-msg", "Ошибка join-room: " + e.message);
    }
  });

  socket.on("leave-room", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.users.delete(socket.id);
    socket.leave(roomId);

    if (room.hostSocketId === socket.id) {
      const next = room.users.keys().next().value || null;
      room.hostSocketId = next;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId });
    }

    io.to(roomId).emit("users-update", usersPayload(room));
    if (room.users.size === 0) rooms.delete(roomId);

    socket.data.roomId = null;
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.users.delete(socket.id);

    if (room.hostSocketId === socket.id) {
      const next = room.users.keys().next().value || null;
      room.hostSocketId = next;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId });
    }

    io.to(roomId).emit("users-update", usersPayload(room));
    if (room.users.size === 0) rooms.delete(roomId);
  });

  // chat
  socket.on("chat-msg", ({ roomId, username, text }) => {
    roomId = String(roomId || "").trim();
    username = String(username || "").trim();
    text = String(text || "").trim();
    if (!roomId || !text) return;

    io.to(roomId).emit("chat-msg", { username: username || "anon", text, ts: Date.now() });
  });

  // sync request
  socket.on("request-sync", ({ roomId }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit("room-state", snapshot(roomId, room));
  });

  // youtube sync: host only
  socket.on("video-set", ({ roomId, videoId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.videoId = String(videoId || "").trim() || null;
    room.playing = false;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-set", {
      videoId: room.videoId,
      time: room.time,
      playing: room.playing,
      updatedAt: room.updatedAt
    });
  });

  socket.on("video-play", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.playing = true;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-play", { time: room.time, updatedAt: room.updatedAt });
  });

  socket.on("video-pause", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.playing = false;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-pause", { time: room.time, updatedAt: room.updatedAt });
  });

  socket.on("video-seek", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-seek", { time: room.time, updatedAt: room.updatedAt });
  });
});

const PORT = process.env.PORT || 3000;
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// room state in memory
const rooms = new Map();
// room = { hostSocketId, videoId, playing, time, updatedAt, users: Map(socketId->{username,role}) }

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostSocketId: null,
      videoId: null,
      playing: false,
      time: 0,
      updatedAt: Date.now(),
      users: new Map()
    });
  }
  return rooms.get(roomId);
}

function calcNowTime(room) {
  if (!room) return 0;
  if (!room.playing) return Number(room.time || 0);
  const elapsed = (Date.now() - (room.updatedAt || Date.now())) / 1000;
  return Math.max(0, Number(room.time || 0) + elapsed);
}

function usersPayload(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({
    id,
    username: u.username,
    role: u.role
  }));
}

function snapshot(roomId, room) {
  return {
    roomId,
    hostSocketId: room.hostSocketId,
    videoId: room.videoId,
    playing: room.playing,
    time: calcNowTime(room),
    updatedAt: Date.now(),
    users: usersPayload(room)
  };
}

function isHost(room, socketId) {
  return room && room.hostSocketId && room.hostSocketId === socketId;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, username, role }) => {
    try {
      roomId = String(roomId || "").trim();
      username = String(username || "").trim();
      role = String(role || "viewer").trim();

      if (!roomId) return socket.emit("error-msg", "Room ID пустой.");
      if (!username) return socket.emit("error-msg", "Username пустой.");
      if (role !== "host" && role !== "viewer") role = "viewer";

      const room = ensureRoom(roomId);

      socket.join(roomId);
      room.users.set(socket.id, { username, role });
      socket.data.roomId = roomId;

      // assign host if none
      if (!room.hostSocketId) room.hostSocketId = socket.id;

      socket.emit("room-state", snapshot(roomId, room));
      socket.to(roomId).emit("user-joined", { id: socket.id, username, role });
      io.to(roomId).emit("users-update", usersPayload(room));
    } catch (e) {
      socket.emit("error-msg", "Ошибка join-room: " + e.message);
    }
  });

  socket.on("leave-room", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.users.delete(socket.id);
    socket.leave(roomId);

    if (room.hostSocketId === socket.id) {
      const next = room.users.keys().next().value || null;
      room.hostSocketId = next;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId });
    }

    io.to(roomId).emit("users-update", usersPayload(room));
    if (room.users.size === 0) rooms.delete(roomId);

    socket.data.roomId = null;
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.users.delete(socket.id);

    if (room.hostSocketId === socket.id) {
      const next = room.users.keys().next().value || null;
      room.hostSocketId = next;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId });
    }

    io.to(roomId).emit("users-update", usersPayload(room));
    if (room.users.size === 0) rooms.delete(roomId);
  });

  // chat
  socket.on("chat-msg", ({ roomId, username, text }) => {
    roomId = String(roomId || "").trim();
    username = String(username || "").trim();
    text = String(text || "").trim();
    if (!roomId || !text) return;

    io.to(roomId).emit("chat-msg", { username: username || "anon", text, ts: Date.now() });
  });

  // sync request
  socket.on("request-sync", ({ roomId }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit("room-state", snapshot(roomId, room));
  });

  // youtube sync: host only
  socket.on("video-set", ({ roomId, videoId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.videoId = String(videoId || "").trim() || null;
    room.playing = false;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-set", {
      videoId: room.videoId,
      time: room.time,
      playing: room.playing,
      updatedAt: room.updatedAt
    });
  });

  socket.on("video-play", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.playing = true;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-play", { time: room.time, updatedAt: room.updatedAt });
  });

  socket.on("video-pause", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.playing = false;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-pause", { time: room.time, updatedAt: room.updatedAt });
  });

  socket.on("video-seek", ({ roomId, time }) => {
    roomId = String(roomId || "").trim();
    const room = rooms.get(roomId);
    if (!room) return;
    if (!isHost(room, socket.id)) return;

    room.time = Number(time || 0);
    room.updatedAt = Date.now();

    io.to(roomId).emit("video-seek", { time: room.time, updatedAt: room.updatedAt });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server started on port", PORT));