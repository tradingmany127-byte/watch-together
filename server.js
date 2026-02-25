const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function now() {
  return Date.now();
}

function generateNumericRoomId() {
  for (let i = 0; i < 60; i++) {
    const len = 3 + Math.floor(Math.random() * 4); // 3-6
    let s = "";
    for (let k = 0; k < len; k++) s += String(Math.floor(Math.random() * 10));
    if (!rooms.has(s)) return s;
  }
  let s = String(Math.floor(100000 + Math.random() * 900000));
  while (rooms.has(s)) s = String(Math.floor(100000 + Math.random() * 900000));
  return s;
}

// сервер вычисляет текущую позицию (учитывая время)
function computePosition(room) {
  if (!room.videoId) return 0;
  if (!room.isPlaying) return room.positionSec;
  const elapsed = (now() - room.lastUpdateAt) / 1000;
  return room.positionSec + elapsed;
}

function pushLog(room, text) {
  const item = { id: `${now()}_${Math.random().toString(16).slice(2)}`, text, ts: now() };
  room.logs.push(item);
  if (room.logs.length > 120) room.logs = room.logs.slice(-120);
  io.to(room.id).emit("logs:new", item);
}

app.get("/api/create-room", (req, res) => {
  const id = generateNumericRoomId();
  rooms.set(id, {
    id,
    hostSocketId: null,
    hostName: null,
    videoId: null,
    isPlaying: false,
    positionSec: 0,
    lastUpdateAt: now(),
    logs: []
  });
  res.json({ roomId: id });
});

app.get("/api/room-exists/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  res.json({ exists: rooms.has(id) });
});

app.get("/room/:id", (req, res) => {
  // room.html сам покажет "Комната не найдена" красиво, если комнаты нет
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

io.on("connection", (socket) => {
  socket.data.name = null;

  socket.on("room:join", ({ roomId, name, asCreator }) => {
    const id = String(roomId || "").trim();
    const userName = String(name || "").trim().slice(0, 24);

    if (!/^\d+$/.test(id)) {
      socket.emit("room:notFound", { roomId: id });
      return;
    }

    const room = rooms.get(id);
    if (!room) {
      socket.emit("room:notFound", { roomId: id });
      return;
    }

    if (!userName) {
      socket.emit("room:badName");
      return;
    }

    socket.data.name = userName;
    socket.join(id);

    // назначаем хоста только создателю
    if (asCreator && !room.hostSocketId) {
      room.hostSocketId = socket.id;
      room.hostName = userName;
      pushLog(room, `HOST: ${userName} создал комнату #${id}`);
    }

    const isHost = socket.id === room.hostSocketId;
    pushLog(room, `${userName} вошёл`);

    socket.emit("room:state", {
      roomId: id,
      me: { name: userName, isHost },
      room: {
        hostName: room.hostName,
        videoId: room.videoId,
        isPlaying: room.isPlaying,
        positionSec: computePosition(room),
        serverNow: now()
      },
      logs: room.logs.slice(-80)
    });

    socket.to(id).emit("presence", { text: `${userName} вошёл`, ts: now() });
  });

  socket.on("room:leave", ({ roomId }) => {
    const id = String(roomId || "").trim();
    const room = rooms.get(id);
    const n = socket.data.name || "User";
    socket.leave(id);
    if (room) {
      pushLog(room, `${n} вышел`);
      socket.to(id).emit("presence", { text: `${n} вышел`, ts: now() });
      // хоста НЕ перекидываем автоматически (как ты не просил), можно сделать позже
    }
  });

  // Загрузка/смена видео
  socket.on("video:set", ({ roomId, videoId, atSec }) => {
    const id = String(roomId || "").trim();
    const room = rooms.get(id);
    if (!room) return;

    room.videoId = String(videoId || "").trim() || null;
    room.isPlaying = false;
    room.positionSec = Number.isFinite(atSec) ? atSec : 0;
    room.lastUpdateAt = now();

    pushLog(room, `Видео установлено: ${room.videoId}`);

    io.to(id).emit("video:sync", {
      reason: "set",
      state: {
        videoId: room.videoId,
        isPlaying: room.isPlaying,
        positionSec: computePosition(room),
        serverNow: now()
      }
    });
  });

  // Play/Pause/Seek (сервер авторитетен)
  socket.on("video:intent", ({ roomId, action, atSec }) => {
    const id = String(roomId || "").trim();
    const room = rooms.get(id);
    if (!room || !room.videoId) return;

    const t = Number.isFinite(atSec) ? atSec : computePosition(room);

    if (action === "play") {
      room.isPlaying = true;
      room.positionSec = t;
      room.lastUpdateAt = now();
      pushLog(room, `▶ Play @ ${t.toFixed(1)}s`);
    } else if (action === "pause") {
      room.isPlaying = false;
      room.positionSec = t;
      room.lastUpdateAt = now();
      pushLog(room, `⏸ Pause @ ${t.toFixed(1)}s`);
    } else if (action === "seek") {
      room.positionSec = t;
      room.lastUpdateAt = now();
      pushLog(room, `⏩ Seek → ${t.toFixed(1)}s`);
    } else {
      return;
    }

    io.to(id).emit("video:sync", {
      reason: action,
      state: {
        videoId: room.videoId,
        isPlaying: room.isPlaying,
        positionSec: computePosition(room),
        serverNow: now()
      }
    });
  });

  socket.on("video:requestState", ({ roomId }) => {
    const id = String(roomId || "").trim();
    const room = rooms.get(id);
    if (!room) return;
    socket.emit("video:sync", {
      reason: "snapshot",
      state: {
        videoId: room.videoId,
        isPlaying: room.isPlaying,
        positionSec: computePosition(room),
        serverNow: now()
      }
    });
  });

  // Чат
  socket.on("chat:send", ({ roomId, text }) => {
    const id = String(roomId || "").trim();
    const room = rooms.get(id);
    if (!room) return;

    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;

    const msg = {
      id: `${now()}_${Math.random().toString(16).slice(2)}`,
      name: socket.data.name || "User",
      text: clean,
      ts: now()
    };

    io.to(id).emit("chat:new", msg);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});