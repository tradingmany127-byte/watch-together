require('dotenv').config()
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const app = express();
// sessions
app.use(session({
  secret: process.env.SESSION_SECRET || "dev_secret",
  resave: false,
  saveUninitialized: false,
}));

// passport init
app.use(passport.initialize());
app.use(passport.session());

// serialize/deserialize
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// google strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL,
}, (accessToken, refreshToken, profile, done) => {
  return done(null, {
    id: profile.id,
    displayName: profile.displayName,
    email: profile.emails?.[0]?.value,
    photos: profile.photos?.[0]?.value,
  });
}));

// routes auth
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => res.redirect("/")
);

app.get("/logout", (req, res) => {
  req.logout(() => res.redirect("/"));
});

app.get("/me", (req, res) => {
  if (!req.user) return res.status(401).json({ user: null });
  res.json({ user: req.user });
});
const server = http.createServer(app);

// Для ngrok/мобилы лучше разрешить cors
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
// ===== Anti-spam / rate limit for Socket.IO =====
const ipConnCount = new Map();
const ipMsgCount = new Map();

function getIP(socket) {
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (xf ? xf.split(",")[0] : socket.handshake.address) || "unknown";
  return ip.trim();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of ipMsgCount.entries()) {
    if (now - v.ts > 10_000) ipMsgCount.delete(ip);
  }
}, 10_000);

io.use((socket, next) => {
  const ip = getIP(socket);

  const c = (ipConnCount.get(ip) || 0) + 1;
  ipConnCount.set(ip, c);

  if (c > 5) {
    return next(new Error("Too many connections"));
  }

  socket.data._ip = ip;
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// Храним состояние комнаты (последнее видео + время + play/pause)
const rooms = new Map(); // roomId -> { videoId, time, isPlaying, updatedAt }

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { videoId: null, time: 0, isPlaying: false, updatedAt: Date.now() });
  }
  return rooms.get(roomId);
}

io.on("connection", (socket) => {
  const ip = socket.data._ip || getIP(socket);

socket.onAny(() => {
  const now = Date.now();
  const v = ipMsgCount.get(ip) || { count: 0, ts: now };

  if (now - v.ts > 2000) {
    v.count = 0;
    v.ts = now;
  }

  v.count++;
  ipMsgCount.set(ip, v);

  if (v.count > 40) {
    socket.disconnect(true);
  }
});

socket.on("disconnect", () => {
  const cur = (ipConnCount.get(ip) || 1) - 1;
  if (cur <= 0) ipConnCount.delete(ip);
  else ipConййnCount.set(ip, cur);
});
  socket.on("join-room", ({ roomId }) => {
    if (!roomId) return;

    socket.join(roomId);
    socket.roomId = roomId;

    // отдаем текущий state новому участнику
    const state = getRoomState(roomId);
    socket.emit("room-state", state);
  });
 // ===== WebRTC signaling (voice) =====

// host -> room
socket.on("webrtc-offer", ({ roomId, offer }) => {
  socket.to(roomId).emit("webrtc-offer", { offer });
});

// viewer -> room
socket.on("webrtc-answer", ({ roomId, answer }) => {
  socket.to(roomId).emit("webrtc-answer", { answer });
});

// both -> room
socket.on("webrtc-ice", ({ roomId, candidate }) => {
  socket.to(roomId).emit("webrtc-ice", { candidate });
}); 

  // установить видео (по ссылке/ID)
  socket.on("set-video", ({ roomId, videoId }) => {
    if (!roomId || !videoId) return;

    const state = getRoomState(roomId);
    state.videoId = videoId;
    state.time = 0;
    state.isPlaying = false;
    state.updatedAt = Date.now();

    io.to(roomId).emit("room-state", state);
  });

  // любые действия плеера: play / pause / seek / sync
  socket.on("player-event", ({ roomId, type, time, isPlaying, videoId }) => {
    if (!roomId || !type) return;

    const state = getRoomState(roomId);

    // обновляем state максимально аккуратно
    if (videoId) state.videoId = videoId;
    if (typeof time === "number") state.time = time;
    if (typeof isPlaying === "boolean") state.isPlaying = isPlaying;
    state.updatedAt = Date.now();

    // рассылаем всем, кроме отправителя (чтобы не было зацикливания)
    socket.to(roomId).emit("player-event", { type, time: state.time, isPlaying: state.isPlaying, videoId: state.videoId });
  });

  socket.on("disconnect", () => {
    // не обязательно чистить комнаты — можно оставить
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});