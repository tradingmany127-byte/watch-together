// server.js — HOST CLAIM + STRICT HOST-ONLY VIDEO CONTROL
// Express + Socket.IO, rooms in memory

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

function parseYouTubeId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // direct id
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

  try {
    const u = new URL(s);

    // youtu.be/<id>
    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "").trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    // watch?v=<id>
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    // /shorts/<id> or /embed/<id>
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
  return room && room.hostSocketId === socket.id;
}

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

io.on("connection", (socket) => {
  socket.data.roomId = null;

  function getRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return null;
    return rooms.get(roomId) || null;
  }

  function deny(reason = "HOST_ONLY") {
    socket.emit("video:denied", { reason });
  }

  // JOIN: { roomId, username }
  socket.on("join-room", (payload = {}) => {
    const roomId = String(payload.roomId || "").trim();
    const username = String(payload.username || payload.name || "").trim().slice(0, 32);

    if (!roomId) return socket.emit("join-error", { error: "MISSING_ID" });
    if (!digitsOnly(roomId)) return socket.emit("join-error", { error: "ONLY_DIGITS" });
    if (!username) return socket.emit("join-error", { error: "MISSING_NAME" });

    // leave old
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      socket.leave(socket.data.roomId);
      const old = rooms.get(socket.data.roomId);
      if (old) {
        old.users.delete(socket.id);
        if (old.hostSocketId === socket.id) {
          old.hostSocketId = null;
          old.hostName = null;
          io.to(old.id).emit("host-changed", { hostSocketId: null, hostName: null });
        }
        io.to(old.id).emit("room-users", {
          usersCount: old.users.size,
          hostName: old.hostName,
          hostSocketId: old.hostSocketId,
        });
        cleanupIfEmpty(old.id);
      }
    }

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    room.users.set(socket.id, { name: username });

    // НЕ назначаем хоста автоматически. Хоста берут кнопкой "Я HOST".
    // Но если хоста нет — UI покажет "хоста нет" пока кто-то не возьмет.

    socket.emit("room-state", statePayload(room, socket));
    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
      hostSocketId: room.hostSocketId,
    });
    io.to(roomId).emit("host-changed", { hostSocketId: room.hostSocketId, hostName: room.hostName });
  });

  socket.on("leave-room", () => leaveCurrentRoom());
  socket.on("disconnect", () => leaveCurrentRoom(true));

  function leaveCurrentRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    socket.leave(roomId);
    socket.data.roomId = null;

    if (!room) return;

    room.users.delete(socket.id);

    // если вышел HOST — хоста сбрасываем
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      room.hostName = null;
      io.to(roomId).emit("host-changed", { hostSocketId: null, hostName: null });
    }

    io.to(roomId).emit("room-users", {
      usersCount: room.users.size,
      hostName: room.hostName,
      hostSocketId: room.hostSocketId,
    });

    cleanupIfEmpty(roomId);
  }

  // -------------------- HOST CLAIM --------------------
  // Нажал "Я HOST" -> подтвердил -> становится хостом
  socket.on("host-claim", () => {
    const room = getRoom();
    if (!room) return;

    const me = room.users.get(socket.id);
    if (!me) return;

    room.hostSocketId = socket.id;
    room.hostName = me.name;

    io.to(room.id).emit("host-changed", {
      hostSocketId: room.hostSocketId,
      hostName: room.hostName,
    });

    // обновим состояние всем (важно для UI)
    for (const sid of room.users.keys()) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit("room-state", statePayload(room, s));
    }
  });

  // -------------------- CHAT --------------------
  socket.on("chat-send", (payload = {}) => {
    const room = getRoom();
    if (!room) return;

    const me = room.users.get(socket.id);
    if (!me) return;

    const text = String(payload.text || "").trim();
    if (!text) return;

    io.to(room.id).emit("chat-msg", { name: me.name, text, at: now() });
  });

  // -------------------- VIDEO (STRICT HOST ONLY) --------------------
  function requireHost(room) {
    if (!room) return false;
    if (!isHost(socket, room)) {
      deny("HOST_ONLY");
      return false;
    }
    return true;
  }

  socket.on("video-load", (payload = {}) => {
    const room = getRoom();
    if (!requireHost(room)) return;

    const raw = payload.videoId || payload.url || payload.videoUrl || payload.link || payload.id;
    const videoId = parseYouTubeId(raw);

    if (!videoId) return socket.emit("video:error", { error: "BAD_VIDEO" });

    room.video.videoId = videoId;
    room.video.time = 0;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-load", { videoId, time: 0, playing: false });
  });

  socket.on("video-play", (payload = {}) => {
    const room = getRoom();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, liveTime(room));
    room.video.time = Math.max(0, t);
    room.video.playing = true;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-play", { time: room.video.time });
  });

  socket.on("video-pause", (payload = {}) => {
    const room = getRoom();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, liveTime(room));
    room.video.time = Math.max(0, t);
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(room.id).emit("video-pause", { time: room.video.time });
  });

  socket.on("video-seek", (payload = {}) => {
    const room = getRoom();
    if (!requireHost(room)) return;

    const t = safeNum(payload.time, 0);
    room.video.time = Math.max(0, t);
    room.video.updatedAt = now();

    io.to(room.id).emit("video-seek", { time: room.video.time });
  });

  // host beacon (поддержка ровного тайминга)
  socket.on("sync-time", (payload = {}) => {
    const room = getRoom();
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

  socket.on("get-state", () => {
    const room = getRoom();
    if (!room) return;
    socket.emit("room-state", statePayload(room, socket));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Server running on port", PORT));