const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const rooms = new Map();
const bannedUsers = new Map(); // roomId -> Set of socket ids/names

function getUsers(roomId) {
  const room = rooms.get(roomId);
  return room ? Array.from(room.users.values()) : [];
}

io.on("connection", (socket) => {

  // ── Join Room ──
  socket.on("join-room", ({ roomId, user, password }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        password: password || "",
        hostId: socket.id,
        users: new Map(),
        notes: "",
        agenda: [],
        polls: [],
        locked: false,
        waitingRoom: [],
        bannedIds: new Set(),
        chat: [],
        talkTime: new Map(),
        roomCreatedAt: Date.now()
      });
    }

    const room = rooms.get(roomId);

    // Check lock
    if (room.locked && socket.id !== room.hostId) {
      socket.emit("room-locked");
      return;
    }

    // Check ban
    if (room.bannedIds.has(user.name)) {
      socket.emit("you-are-banned");
      return;
    }

    if (room.password && room.password !== password) {
      socket.emit("wrong-password");
      return;
    }

    const finalUser = {
      id: socket.id,
      name: user.name || "Guest",
      email: user.email || "",
      avatar: user.avatar || "GU",
      isHost: socket.id === room.hostId,
      handRaised: false,
      handQueuePos: 0,
      role: socket.id === room.hostId ? "host" : (user.role || "participant"),
      talkTime: 0,
      joinedAt: Date.now(),
      isSpeaking: false,
      isMuted: false,
      isCameraOff: false,
      reactions: 0,
      messages: 0
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.user = finalUser;
    room.users.set(socket.id, finalUser);
    room.talkTime.set(socket.id, 0);

    socket.emit("room-ready", {
      hostId: room.hostId,
      notes: room.notes,
      agenda: room.agenda,
      polls: room.polls,
      locked: room.locked,
      chat: room.chat.slice(-50),
      existingUsers: getUsers(roomId).filter(u => u.id !== socket.id)
    });

    socket.to(roomId).emit("user-joined", finalUser);
    io.to(roomId).emit("participants-update", getUsers(roomId));
    io.to(roomId).emit("system-message", `${finalUser.name} joined the meeting 👋`);
  });

  // ── WebRTC ──
  socket.on("offer", (data) => {
    io.to(data.targetId).emit("offer", { fromId: socket.id, offer: data.offer, user: socket.data.user });
  });
  socket.on("answer", (data) => {
    io.to(data.targetId).emit("answer", { fromId: socket.id, answer: data.answer });
  });
  socket.on("ice-candidate", (data) => {
    io.to(data.targetId).emit("ice-candidate", { fromId: socket.id, candidate: data.candidate });
  });

  // ── Chat ──
  socket.on("chat-message", ({ roomId, message, replyTo, dm }) => {
    const user = socket.data.user || { name: "Guest" };
    const room = rooms.get(roomId);
    if (!room) return;

    const msg = {
      id: Date.now() + Math.random(),
      name: user.name,
      avatar: user.avatar,
      message,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      replyTo: replyTo || null,
      dm: dm || null,
      reactions: {}
    };

    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();

    // track messages count
    if (room.users.has(socket.id)) room.users.get(socket.id).messages++;

    if (dm) {
      // Private message
      io.to(dm).emit("chat-message", { ...msg, isPrivate: true });
      socket.emit("chat-message", { ...msg, isPrivate: true });
    } else {
      io.to(roomId).emit("chat-message", msg);
    }
  });

  // ── Message reaction ──
  socket.on("msg-reaction", ({ roomId, msgId, emoji }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    io.to(roomId).emit("msg-reaction", { msgId, emoji, from: socket.data.user?.name });
  });

  // ── Reactions ──
  socket.on("reaction", ({ roomId, reaction }) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) room.users.get(socket.id).reactions++;
    io.to(roomId).emit("reaction", { from: socket.data.user?.name || "Guest", reaction });
  });

  // ── Raise Hand ──
  socket.on("raise-hand", ({ roomId, raised }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.handRaised = raised;
    if (raised) {
      const pos = Array.from(room.users.values()).filter(u => u.handRaised).length;
      user.handQueuePos = pos;
    } else {
      user.handQueuePos = 0;
    }
    io.to(roomId).emit("participants-update", getUsers(roomId));
    io.to(roomId).emit("system-message", `${user.name} ${raised ? "raised hand ✋" : "lowered hand"}`);
  });

  // ── Notes ──
  socket.on("notes-update", ({ roomId, notes }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.notes = notes;
    socket.to(roomId).emit("notes-update", notes);
  });

  // ── Agenda ──
  socket.on("agenda-update", ({ roomId, agenda }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.agenda = agenda;
    io.to(roomId).emit("agenda-update", agenda);
  });

  // ── Poll ──
  socket.on("create-poll", ({ roomId, question, options }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const poll = { id: Date.now(), question, options: options.map(o => ({ text: o, votes: [], voters: [] })), active: true };
    room.polls.push(poll);
    io.to(roomId).emit("poll-created", poll);
  });

  socket.on("vote-poll", ({ roomId, pollId, optionIndex }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const poll = room.polls.find(p => p.id === pollId);
    if (!poll || !poll.active) return;
    // Remove previous vote
    poll.options.forEach(o => { o.voters = o.voters.filter(v => v !== socket.id); });
    poll.options[optionIndex].voters.push(socket.id);
    io.to(roomId).emit("poll-update", poll);
  });

  socket.on("close-poll", ({ roomId, pollId }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const poll = room.polls.find(p => p.id === pollId);
    if (poll) poll.active = false;
    io.to(roomId).emit("poll-update", poll);
  });

  // ── Talk time ──
  socket.on("talk-start", ({ roomId }) => {
    socket.data.talkStart = Date.now();
  });

  socket.on("talk-end", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !socket.data.talkStart) return;
    const elapsed = Math.floor((Date.now() - socket.data.talkStart) / 1000);
    const user = room.users.get(socket.id);
    if (user) user.talkTime = (user.talkTime || 0) + elapsed;
    socket.data.talkStart = null;
    io.to(roomId).emit("participants-update", getUsers(roomId));
  });

  // ── Speaking indicator ──
  socket.on("speaking", ({ roomId, isSpeaking }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.isSpeaking = isSpeaking;
    io.to(roomId).emit("speaking-update", { userId: socket.id, isSpeaking });
  });

  // ── Lock room ──
  socket.on("lock-room", ({ roomId, locked }) => {
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.locked = locked;
    io.to(roomId).emit("room-locked-status", locked);
    io.to(roomId).emit("system-message", `Room ${locked ? "locked 🔒" : "unlocked 🔓"} by host`);
  });

  // ── Host controls ──
  socket.on("host-mute-user", ({ targetId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(targetId).emit("muted-by-host");
  });

  socket.on("host-remove-user", ({ targetId }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    io.to(targetId).emit("removed-by-host");
  });

  socket.on("host-ban-user", ({ targetId, targetName }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    room.bannedIds.add(targetName);
    io.to(targetId).emit("you-are-banned");
    io.to(roomId).emit("system-message", `${targetName} was banned from the room`);
  });

  socket.on("host-set-role", ({ targetId, role }) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.id) return;
    const user = room.users.get(targetId);
    if (user) user.role = role;
    io.to(roomId).emit("participants-update", getUsers(roomId));
  });

  // ── File share ──
  socket.on("file-shared", ({ roomId, fileName }) => {
    const name = socket.data.user?.name || "Someone";
    io.to(roomId).emit("system-message", `📎 ${name} shared: ${fileName}`);
  });

  // ── Whiteboard ──
  socket.on("whiteboard-draw", ({ roomId, data }) => {
    socket.to(roomId).emit("whiteboard-draw", data);
  });

  socket.on("whiteboard-clear", ({ roomId }) => {
    io.to(roomId).emit("whiteboard-clear");
  });

  // ── Layout change ──
  socket.on("layout-change", ({ roomId, layout }) => {
    io.to(roomId).emit("layout-change", layout);
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    socket.to(roomId).emit("user-left", socket.id);

    if (user) io.to(roomId).emit("system-message", `${user.name} left the meeting`);

    if (room.hostId === socket.id) {
      const nextHost = room.users.keys().next().value;
      if (nextHost) {
        room.hostId = nextHost;
        const nextUser = room.users.get(nextHost);
        if (nextUser) { nextUser.isHost = true; nextUser.role = "host"; }
        io.to(roomId).emit("system-message", `${nextUser?.name || "Someone"} is now host 👑`);
      }
    }

    io.to(roomId).emit("participants-update", getUsers(roomId));
    if (room.users.size === 0) rooms.delete(roomId);
  });
});

server.listen(PORT, () => console.log(`ConnectNow running at http://localhost:${PORT}`));
