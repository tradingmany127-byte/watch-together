const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

// Простое хранение состояния комнат в памяти (на бесплатном Render может ресетаться при рестарте — это норм)
const rooms = new Map();
// rooms.get(roomId) => {
//   hostSocketId: string|null,
//   videoId: string|null,
//   playing: boolean,
//   time: number,
//   updatedAt: number,
//   users: Map(socketId -> { username, role })
// }

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

function roomUsersPayload(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({
    id,
    username: u.username,
    role: u.role
  }));
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

      // Назначаем host: если нет host — первый кто вошёл как host или просто первый вообще
      if (!room.hostSocketId) {
        if (role === "host") room.hostSocketId = socket.id;
        else room.hostSocketId = socket.id; // чтобы не было “без хоста”
      } else {
        // Если кто-то входит как host, но хост уже есть — оставляем текущего
      }

      socket.data.roomId = roomId;

      socket.emit("room-state", {
        roomId,
        hostSocketId: room.hostSocketId,
        videoId: room.videoId,
        playing: room.playing,
        time: room.time,
        updatedAt: room.updatedAt,
        users: roomUsersPayload(room)
      });

      socket.to(roomId).emit("user-joined", {
        id: socket.id,
        username,
        role
      });

      io.to(roomId).emit("users-update", roomUsersPayload(room));
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

    // Если ушёл хост — назначим нового
    if (room.hostSocketId === socket.id) {
      const next = room.users.keys().next().value || null;
      room.hostSocketId = next;
      io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId });
    }

    io.to(roomId).emit("users-update", roomUsersPayload(room));

    // Если никого не осталось — удаляем комнату
    if (room.users.size === 0) rooms.delete(roomId);

    socket.data.roomId = null;
  });

  // CHAT
  socket.on("chat-msg", ({ roomId, username, text }) => {
    roomId = String(roomId || "").trim();
    username = String(username || "").trim();
    text = String(text || "").trim();
    if (!roomId || !text) return;

    io.to(roomId).emit("chat-msg", {
      username: username || "anon",
      text,
      ts: Date.now()
    });
  });

  // YOUTUBE SYNC (принимаем как от хоста, так и от любого — но сервер хранит состояние)
  socket.on("video-set", ({ roomId, videoId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.videoId = videoId || null;
    room.time = Number(time || 0);
    room.playing = false;
    room.updatedAt = Date.now();
    io.to(roomId).emit("video-set", {
      videoId: room.videoId,
      time: room.time,
      playing: room.playing,
      updatedAt: room.updatedAt
    });
  });

  socket.on("video-play", ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = true;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();
    io.to(roomId).emit("video-play", {
      time: room.time,
      updatedAt: room.updatedAt
    });
  });

  socket.on("video-pause", ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.playing = false;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();
    io.to(roomId).emit("video-pause", {
      time: room.time,
      updatedAt: room.updatedAt
    });
  });

  socket.on("video-seek", ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.time = Number(time || 0);
    room.updatedAt = Date.now();
    io.to(roomId).emit("video-seek", {
      time: room.time,
      updatedAt: room.updatedAt
    });
  });

  // WEBRTC SIGNALING (voice)
  socket.on("webrtc-offer", ({ roomId, to, offer }) => {
    io.to(to).emit("webrtc-offer", { from: socket.id, offer });
  });
  socket.on("webrtc-answer", ({ roomId, to, answer }) => {
    io.to(to).emit("webrtc-answer", { from: socket.id, answer });
  });
  socket.on("webrtc-ice", ({ roomId, to, candidate }) => {
    io.to(to).emit("webrtc-ice", { from: socket.id, candidate });
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

    io.to(roomId).emit("users-update", roomUsersPayload(room));
    if (room.users.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server started on port", PORT));