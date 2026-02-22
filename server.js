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

app.get("/health", (req, res) => res.send("ok"));

/**
 * roomId -> Set(socketId)
 */
const rooms = new Map();

function getRoomSize(roomId) {
  const set = rooms.get(roomId);
  return set ? set.size : 0;
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId) return;

    // лимит 2 человека
    if (getRoomSize(roomId) >= 2) {
      socket.emit("room-full");
      return;
    }

    socket.data.roomId = roomId;
    socket.data.name = (name || "User").slice(0, 30);

    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(socket.id);

    // кто в комнате сейчас
    const users = [...rooms.get(roomId)].map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data?.name || "User"
    }));

    socket.emit("room-users", users);
    socket.to(roomId).emit("user-joined", { id: socket.id, name: socket.data.name });
  });

  socket.on("chat-message", ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const msg = {
      from: socket.data.name || "User",
      text: String(text || "").slice(0, 500),
      ts: Date.now()
    };
    io.to(roomId).emit("chat-message", msg);
  });

  // WebRTC signaling
  socket.on("webrtc-offer", ({ roomId, offer }) => {
    if (!roomId) roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc-offer", { from: socket.id, offer });
  });

  socket.on("webrtc-answer", ({ roomId, answer }) => {
    if (!roomId) roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc-answer", { from: socket.id, answer });
  });

  socket.on("webrtc-ice", ({ roomId, candidate }) => {
    if (!roomId) roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit("webrtc-ice", { from: socket.id, candidate });
  });

  socket.on("leave-room", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    socket.leave(roomId);
    rooms.get(roomId)?.delete(socket.id);
    socket.to(roomId).emit("user-left", { id: socket.id });

    if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
    socket.data.roomId = null;
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    rooms.get(roomId)?.delete(socket.id);
    socket.to(roomId).emit("user-left", { id: socket.id });

    if (rooms.get(roomId)?.size === 0) rooms.delete(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running on port", PORT));