import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = new Map();

function createRoom(id) {
  rooms.set(id, {
    videoId: null,
    time: 0,
    playing: false,
    users: new Set()
  });
}

io.on("connection", (socket) => {

  socket.on("create-room", (id) => {
    if (!rooms.has(id)) createRoom(id);
  });

  socket.on("check-room", (id, cb) => {
    cb(rooms.has(id));
  });

  socket.on("join-room", (id, cb) => {
    if (!rooms.has(id)) return cb(false);

    socket.join(id);
    rooms.get(id).users.add(socket.id);
    cb(true);

    socket.emit("sync-state", rooms.get(id));
  });

  socket.on("video-change", ({ roomId, videoId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.videoId = videoId;
    room.time = 0;
    io.to(roomId).emit("video-change", videoId);
  });

  socket.on("video-play", ({ roomId, time }) => {
    io.to(roomId).emit("video-play", { time });
  });

  socket.on("video-pause", ({ roomId, time }) => {
    io.to(roomId).emit("video-pause", { time });
  });

  socket.on("video-seek", ({ roomId, time }) => {
    io.to(roomId).emit("video-seek", { time });
  });

  socket.on("chat-message", ({ roomId, message }) => {
    io.to(roomId).emit("chat-message", message);
  });

  socket.on("disconnect", () => {
    rooms.forEach((room, id) => {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        if (room.users.size === 0) rooms.delete(id);
      }
    });
  });

});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server started on port", PORT);
});