// server.js (FULL REWRITE)
// Node + Express + Socket.IO
// Host-only control for video. Auto-delete room when empty.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// ----- Static -----
app.use(express.static(path.join(__dirname, "public")));

// ----- In-memory rooms -----
// rooms.get(roomId) => {
//   id: string,
//   password: string,
//   hostSocketId: string|null,
//   hostName: string|null,
//   members: Map(socketId => { name: string }),
//   video: { videoId: string|null, time: number, playing: boolean, updatedAt: number },
//   logs: Array<{ t:number, text:string }>
// }
const rooms = new Map();

function now() {
  return Date.now();
}

function isDigitsOnly(s) {
  return /^\d+$/.test(String(s || "").trim());
}

function addLog(room, text) {
  const item = { t: now(), text: String(text) };
  room.logs.push(item);
  // ограничим логи, чтобы память не росла бесконечно
  if (room.logs.length > 200) room.logs.splice(0, room.logs.length - 200);
  io.to(room.id).emit("logs:new", item);
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) return null;
  return rooms.get(roomId);
}

function roomStatePayload(room, socketId) {
  const me = room.members.get(socketId);
  return {
    roomId: room.id,
    isHost: room.hostSocketId === socketId,
    hostName: room.hostName,
    membersCount: room.members.size,
    logs: room.logs,
    video: {
      videoId: room.video.videoId,
      time: room.video.time,
      playing: room.video.playing,
      updatedAt: room.video.updatedAt,
    },
    me: { name: me?.name || "" },
  };
}

// ----- API create room (optional) -----
// Если у тебя на клиенте create-room через fetch — оставляю.
// Требования: id только цифры, пароль обязателен.
app.get("/api/create-room/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  const password = String(req.query.pwd || "").trim(); // например /api/create-room/123?pwd=xxx

  if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });
  if (!isDigitsOnly(id)) return res.status(400).json({ ok: false, error: "ONLY_DIGITS" });
  if (!password) return res.status(400).json({ ok: false, error: "MISSING_PASSWORD" });

  if (rooms.has(id)) return res.status(409).json({ ok: false, error: "ALREADY_EXISTS" });

  rooms.set(id, {
    id,
    password,
    hostSocketId: null,
    hostName: null,
    members: new Map(),
    video: { videoId: null, time: 0, playing: false, updatedAt: now() },
    logs: [],
  });

  return res.json({ ok: true, roomId: id });
});

// ----- Socket.IO -----
io.on("connection", (socket) => {
  // где сейчас находится сокет
  socket.data.roomId = null;

  // -----------------------
  // JOIN / LEAVE
  // -----------------------
  // ожидаемый payload:
  // { roomId, username, password, asCreator? }
  socket.on("join-room", (payload = {}) => {
    try {
      const roomId = String(payload.roomId || "").trim();
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "").trim();
      const asCreator = !!payload.asCreator;

      if (!roomId) {
        socket.emit("join-error", { error: "MISSING_ID" });
        return;
      }
      if (!isDigitsOnly(roomId)) {
        socket.emit("join-error", { error: "ONLY_DIGITS" });
        return;
      }
      if (!username) {
        socket.emit("join-error", { error: "MISSING_NAME" });
        return;
      }
      if (!password) {
        socket.emit("join-error", { error: "MISSING_PASSWORD" });
        return;
      }

      const room = ensureRoom(roomId);
      if (!room) {
        socket.emit("join-error", { error: "NOT_FOUND" });
        return;
      }
      if (room.password !== password) {
        socket.emit("join-error", { error: "BAD_PASSWORD" });
        return;
      }

      // если сокет уже был в комнате — выйдем
      if (socket.data.roomId && socket.data.roomId !== roomId) {
        safeLeave(socket);
      }

      socket.join(roomId);
      socket.data.roomId = roomId;

      room.members.set(socket.id, { name: username });

      // назначение хоста:
      // - если host пустой → первый вошедший становится host
      // - или если asCreator=true (создатель зашёл) → если host пустой, становится host
      if (!room.hostSocketId) {
        room.hostSocketId = socket.id;
        room.hostName = username;
        addLog(room, `HOST назначен: ${username}`);
      } else {
        addLog(room, `${username} вошёл в комнату`);
      }

      // отдадим state вошедшему
      socket.emit("room-state", roomStatePayload(room, socket.id));

      // всем обновим кратко инфу о комнате (опционально)
      io.to(roomId).emit("room-members", { count: room.members.size, hostName: room.hostName });

    } catch (e) {
      socket.emit("join-error", { error: "JOIN_FAILED" });
    }
  });

  socket.on("leave-room", () => {
    safeLeave(socket);
  });

  socket.on("disconnect", () => {
    safeLeave(socket, true);
  });

  function safeLeave(sock, isDisconnect = false) {
    const roomId = sock.data.roomId;
    if (!roomId) return;

    const room = ensureRoom(roomId);
    sock.leave(roomId);
    sock.data.roomId = null;

    if (!room) return;

    const me = room.members.get(sock.id);
    room.members.delete(sock.id);

    const meName = me?.name || "user";

    // если вышел хост → передаём хост любому оставшемуся
    if (room.hostSocketId === sock.id) {
      const next = room.members.keys().next();
      if (!next.done) {
        const nextId = next.value;
        room.hostSocketId = nextId;
        room.hostName = room.members.get(nextId)?.name || "HOST";
        addLog(room, `HOST вышел → новый HOST: ${room.hostName}`);
      } else {
        room.hostSocketId = null;
        room.hostName = null;
      }
    } else {
      addLog(room, `${meName} вышел из комнаты`);
    }

    io.to(roomId).emit("room-members", { count: room.members.size, hostName: room.hostName });

    // авто-удаление комнаты если пусто
    if (room.members.size === 0) {
      rooms.delete(roomId);
      // лог некуда слать — комнаты уже нет
      return;
    }
  }

  // -----------------------
  // CHAT (any member)
  // -----------------------
  socket.on("chat-send", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = ensureRoom(roomId);
    if (!room) return;

    const me = room.members.get(socket.id);
    if (!me) return;

    const text = String(payload.text || "").trim();
    if (!text) return;

    io.to(roomId).emit("chat-msg", {
      name: me.name,
      text,
      at: now(),
    });
  });

  // -----------------------
  // VIDEO CONTROL (HOST ONLY)
  // -----------------------
  function mustBeHost(room) {
    return room && room.hostSocketId === socket.id;
  }

  socket.on("video-load", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;

    if (!mustBeHost(room)) return; // 🔒 ONLY HOST

    const videoId = String(payload.videoId || "").trim();
    const time = Number(payload.time || 0);
    const playing = !!payload.playing;

    if (!videoId) return;

    room.video.videoId = videoId;
    room.video.time = Number.isFinite(time) ? time : 0;
    room.video.playing = playing;
    room.video.updatedAt = now();

    addLog(room, `Видео установлено: ${videoId}`);

    io.to(roomId).emit("video-load", {
      videoId: room.video.videoId,
      time: room.video.time,
      playing: room.video.playing,
    });
  });

  socket.on("video-play", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;

    if (!mustBeHost(room)) return; // 🔒 ONLY HOST

    const time = Number(payload.time || 0);

    room.video.time = Number.isFinite(time) ? time : room.video.time;
    room.video.playing = true;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-play", { time: room.video.time });
  });

  socket.on("video-pause", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;

    if (!mustBeHost(room)) return; // 🔒 ONLY HOST

    const time = Number(payload.time || 0);

    room.video.time = Number.isFinite(time) ? time : room.video.time;
    room.video.playing = false;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-pause", { time: room.video.time });
  });

  socket.on("video-seek", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;

    if (!mustBeHost(room)) return; // 🔒 ONLY HOST

    const time = Number(payload.time || 0);
    room.video.time = Number.isFinite(time) ? time : room.video.time;
    room.video.updatedAt = now();

    io.to(roomId).emit("video-seek", { time: room.video.time });
  });

  // OPTIONAL: host can periodically send sync-time
  socket.on("sync-time", (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;

    if (!mustBeHost(room)) return; // 🔒 ONLY HOST

    const time = Number(payload.time || 0);
    const playing = !!payload.playing;
    const videoId = String(payload.videoId || "").trim();

    if (videoId) room.video.videoId = videoId;
    room.video.time = Number.isFinite(time) ? time : room.video.time;
    room.video.playing = playing;
    room.video.updatedAt = now();

    io.to(roomId).emit("sync-time", {
      videoId: room.video.videoId,
      time: room.video.time,
      playing: room.video.playing,
    });
  });

  // -----------------------
  // STATE REQUEST
  // -----------------------
  socket.on("room-state:get", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = ensureRoom(roomId);
    if (!room) return;
    socket.emit("room-state", roomStatePayload(room, socket.id));
  });
});

// ----- Listen (Render-friendly) -----
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});