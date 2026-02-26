// server.js — Host-only video control (FULL)
// Node.js + Express + Socket.IO
// Rooms are in-memory. When room becomes empty => deleted.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Rooms (in-memory) ----------
/**
 * rooms.get(roomId) => {
 *   id: string,
 *   hostSocketId: string|null,
 *   hostName: string|null,
 *   users: Map<socketId, { name: string }>,
 *   video: { videoId: string|null, time: number, playing: boolean, updatedAt: number },
 * }
 */
const rooms = new Map();

function isDigitsOnly(id) {
  return /^\d+$/.test(String(id || "").trim());
}
function now() {
  return Date.now();
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

function serverTime(room) {
  // вычисляем "живое" время, если playing
  if (!room.video.playing) return room.video.time;
  const dt = (now() - room.video.updatedAt) / 1000;
  return room.video.time + dt;
}

function mustBeHost(socket, room) {
  return room && room.hostSocketId === socket.id;
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
      time: serverTime(room),
      playing: room.video.playing,
      updatedAt: room.video.updatedAt,
    },
  };
}

function pickNewHost(room) {
  const it = room.users.keys().next();
  if (it.done) return null;
  return it.value;
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.users.size === 0) {
    rooms.delete(roomId);
  }
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  socket.data.roomId = null;

  // JOIN
  // payload: { roomId, username }
  socket.on("join-room", (payload = {}) => {
    const roomId = String(payload.roomId || "").trim();
    const username = String(payload.username || "").trim();

    if (!roomId) return socket.emit("join-error", { error: "MISSING_ID" });
    if (!isDigitsOnly(roomId)) return socket.emit("join-error", { error: "ONLY_DIGITS" });
    if (!username) return socket.emit("join-error", { error: "MISSING_NAME" });

    // если уже в другой комнате — выйдем
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      leaveCurrentRoom(socket);
    }

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;

    room.users.set(socket.id, { name: username });

    // первый вошедший => HOST
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
      room.hostName = username;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId, hostName: room.hostName });
    }

    // отправим состояние вошедшему
    socket.emit("room-state", statePayload(room, socket.id));
    // остальным сообщим обновление
    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
    });
  });

  // LEAVE (ручной)
  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    leaveCurrentRoom(socket, true);
  });

  function leaveCurrentRoom(sock, isDisconnect = false) {
    const roomId = sock.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    sock.leave(roomId);
    sock.data.roomId = null;

    if (!room) return;

    room.users.delete(sock.id);

    // если вышел HOST — назначим нового
    if (room.hostSocketId === sock.id) {
      const newHostId = pickNewHost(room);
      if (newHostId) {
        room.hostSocketId = newHostId;
        room.hostName = room.users.get(newHostId)?.name || "HOST";
        io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId, hostName: room.hostName });
      } else {
        room.hostSocketId = null;
        room.hostName = null;
      }
    }

    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
    });

    // авто-удаление комнаты если пусто
    cleanupRoomIfEmpty(roomId);
  }

  // ---------- CHAT (everyone) ----------
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

  // ---------- VIDEO CONTROL (HOST ONLY) ----------
  // Все события управления видео — только от HOST.
  // Если не HOST — сервер просто игнорирует.

  socket.on("video-load", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!mustBeHost(socket, room)) return; // 🔒 ONLY HOST

    const videoId = String(payload.videoId || "").trim();
    if (!videoId) return;

    room.video.videoId = videoId;
    room.video.time = 0;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-load", {
      videoId: room.video.videoId,
      time: room.video.time,
      playing: room.video.playing,
    });

    io.to(roomId).emit("room-state", statePayload(room, socket.id));
  });

  socket.on("video-play", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!mustBeHost(socket, room)) return; // 🔒 ONLY HOST

    const t = Number(payload.time || serverTime(room));
    room.video.time = Number.isFinite(t) ? t : serverTime(room);
    room.video.playing = true;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-play", { time: room.video.time });
  });

  socket.on("video-pause", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!mustBeHost(socket, room)) return; // 🔒 ONLY HOST

    const t = Number(payload.time || serverTime(room));
    room.video.time = Number.isFinite(t) ? t : serverTime(room);
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-pause", { time: room.video.time });
  });

  socket.on("video-seek", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!mustBeHost(socket, room)) return; // 🔒 ONLY HOST

    const t = Number(payload.time || 0);
    room.video.time = Number.isFinite(t) ? Math.max(0, t) : room.video.time;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-seek", { time: room.video.time });
  });

  // optional: host beacon / sync
  socket.on("sync-time", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (!mustBeHost(socket, room)) return; // 🔒 ONLY HOST

    const t = Number(payload.time || serverTime(room));
    const playing = !!payload.playing;

    room.video.time = Number.isFinite(t) ? t : serverTime(room);
    room.video.playing = playing;
    room.video.updatedAt = now();

    io.to(roomId).emit("sync-time", {
      videoId: room.video.videoId,
      time: serverTime(room),
      playing: room.video.playing,
    });
  });

  // request state
  socket.on("get-state", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit("room-state", statePayload(room, socket.id));
  });
});

// ---------- Listen (Render friendly) ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});