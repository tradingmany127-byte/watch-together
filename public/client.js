const socket = io();

let currentRoom = null;
let player;
let ignoreEvents = false;

const mainMenu = document.getElementById("mainMenu");
const roomView = document.getElementById("roomView");

document.getElementById("createRoom").onclick = () => {
  const id = Math.floor(100 + Math.random() * 900000).toString();
  socket.emit("create-room", id);
  joinRoom(id);
};

document.getElementById("joinRoom").onclick = () => {
  const id = document.getElementById("roomInput").value.replace(/\D/g, "");
  socket.emit("check-room", id, (exists) => {
    if (exists) joinRoom(id);
    else alert("Комната не найдена");
  });
};

function joinRoom(id) {
  currentRoom = id;

  socket.emit("join-room", id, (ok) => {
    if (!ok) return alert("Комната не найдена");
  });

  document.getElementById("roomLabel").innerText = "Комната #" + id;

  mainMenu.classList.add("hidden");
  roomView.classList.remove("hidden");
}

document.getElementById("leaveBtn").onclick = () => location.reload();

document.getElementById("inviteBtn").onclick = () => {
  const link = location.origin + "?room=" + currentRoom;
  navigator.clipboard.writeText(link);
  alert("Ссылка скопирована");
};

document.getElementById("loadVideo").onclick = () => {
  const url = document.getElementById("videoUrl").value;
  const videoId = new URL(url).searchParams.get("v");
  if (!videoId) return alert("Неверная ссылка");

  socket.emit("video-change", { roomId: currentRoom, videoId });
};

socket.on("video-change", (videoId) => player.loadVideoById(videoId));

socket.on("video-play", ({ time }) => {
  ignoreEvents = true;
  player.seekTo(time);
  player.playVideo();
  setTimeout(() => ignoreEvents = false, 300);
});

socket.on("video-pause", ({ time }) => {
  ignoreEvents = true;
  player.seekTo(time);
  player.pauseVideo();
  setTimeout(() => ignoreEvents = false, 300);
});

socket.on("chat-message", (msg) => {
  const div = document.createElement("div");
  div.className = "message";
  div.innerText = msg.text;
  document.getElementById("messages").appendChild(div);
});

document.getElementById("sendMsg").onclick = () => {
  const text = document.getElementById("chatText").value;
  if (!text) return;

  socket.emit("chat-message", {
    roomId: currentRoom,
    message: { text, time: Date.now() }
  });

  document.getElementById("chatText").value = "";
};

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    height: "400",
    width: "100%",
    events: {
      onStateChange: (e) => {
        if (!currentRoom || ignoreEvents) return;

        const time = player.getCurrentTime();

        if (e.data === YT.PlayerState.PLAYING)
          socket.emit("video-play", { roomId: currentRoom, time });

        if (e.data === YT.PlayerState.PAUSED)
          socket.emit("video-pause", { roomId: currentRoom, time });
      }
    }
  });
};