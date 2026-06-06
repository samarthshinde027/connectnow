const socket = io();
const $ = id => document.getElementById(id);

/* ── State ── */
let currentUser = null, roomId = "", password = "";
let localStream = null, peers = {}, participants = [];
let isMuted = false, isCameraOff = false, handRaised = false;
let isHost = false, startedAt = null, timerInterval = null;
let currentLayout = "grid", pinnedUser = null;
let captionsOn = false, recognition = null;
let currentFilter = "none", isBlurred = false, isMirrored = false;
let dmTarget = null;
let unreadCount = 0, rightPanelOpen = false;
let wbDrawing = false, wbLastX = 0, wbLastY = 0, wbTool = "pen";
let agendaItems = [], currentPollId = null;
let avatarColor = "#7c6fff";
let soundsEnabled = true, meetingChatLog = [];
let meetingStartStats = { messages: 0 };
let speechCtx = null;

const SOUNDS = {
  join: () => playTone(440, 0.1, "sine"),
  leave: () => playTone(330, 0.1, "sine"),
  message: () => playTone(880, 0.05, "sine"),
  bell: () => playTone(660, 0.3, "triangle"),
  tada: () => { playTone(523, 0.1, "sine"); setTimeout(() => playTone(659, 0.1, "sine"), 100); setTimeout(() => playTone(784, 0.2, "sine"), 200); },
  applause: () => { for(let i=0;i<8;i++) setTimeout(() => playTone(200+Math.random()*300, 0.04, "sawtooth"), i*60); },
  drum: () => { playTone(80, 0.2, "sawtooth"); setTimeout(() => playTone(120, 0.15, "square"), 150); },
  laugh: () => { for(let i=0;i<5;i++) setTimeout(() => playTone(400+i*50, 0.08, "sine"), i*120); },
  boo: () => { playTone(200, 0.3, "sawtooth"); }
};

function playTone(freq, dur, type = "sine") {
  try {
    if (!speechCtx) speechCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = speechCtx.createOscillator();
    const gain = speechCtx.createGain();
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, speechCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, speechCtx.currentTime + dur);
    osc.connect(gain); gain.connect(speechCtx.destination);
    osc.start(); osc.stop(speechCtx.currentTime + dur);
  } catch(e) {}
}

/* ── Toast ── */
function toast(msg, type = "info", dur = 3000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), dur);
}

/* ── Confetti ── */
function launchConfetti() {
  const canvas = $("confettiCanvas");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth; canvas.height = innerHeight;
  const particles = Array.from({ length: 120 }, () => ({
    x: Math.random() * innerWidth, y: -10,
    vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4 + 2,
    color: ["#7c6fff","#c084fc","#34d399","#fbbf24","#f472b6"][Math.floor(Math.random()*5)],
    size: Math.random() * 8 + 4, rotation: Math.random() * 360
  }));
  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rotation += 3;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation * Math.PI / 180);
      ctx.fillStyle = p.color; ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
      ctx.restore();
    });
    if (++frame < 80) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

/* ── Helpers ── */
function initials(name) {
  return (name || "G").split(" ").map(x => x[0]).join("").substring(0, 2).toUpperCase() || "GU";
}
function saveUser(u) { localStorage.setItem("cn-user", JSON.stringify(u)); }
function loadUser() {
  const s = localStorage.getItem("cn-user");
  if (s) { currentUser = JSON.parse(s); showApp(); return true; }
  return false;
}
function showApp() {
  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  if ($("userNameTop")) $("userNameTop").textContent = currentUser.name;
  if ($("userAvatarTop")) {
    $("userAvatarTop").textContent = currentUser.avatar;
    $("userAvatarTop").style.background = currentUser.color || "linear-gradient(135deg,#7c6fff,#c084fc)";
  }
  if ($("greetName")) $("greetName").textContent = `, ${currentUser.name.split(" ")[0]}`;
  loadProfileInputs();
  renderSchedules(); renderQuickMessages(); renderContacts(); renderAnalytics();
  checkNextMeeting();
}

/* ── Avatar Color ── */
document.querySelectorAll(".av-opt").forEach(opt => {
  opt.onclick = () => {
    opt.closest(".avatar-picker").querySelectorAll(".av-opt").forEach(o => o.classList.remove("active"));
    opt.classList.add("active");
    avatarColor = opt.dataset.color;
  };
});

/* ── Auth ── */
$("loginBtn").onclick = () => {
  const name = $("nameInput").value.trim();
  const email = $("emailInput").value.trim();
  if (!name || !email) return toast("Enter your name and email.", "error");
  currentUser = { name, email, avatar: initials(name), color: avatarColor };
  saveUser(currentUser);
  showApp();
};

$("logoutBtn").onclick = () => { localStorage.removeItem("cn-user"); location.reload(); };

function toggleTheme() { document.body.classList.toggle("light"); }
$("themeBtn").onclick = toggleTheme;
$("themeBtn2") && ($("themeBtn2").onclick = toggleTheme);

/* ── Sidebar Nav ── */
document.querySelectorAll(".side-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".side-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
    const pg = $(btn.dataset.page);
    if (pg) pg.classList.remove("hidden");
  };
});
$("newMeetingFocusBtn").onclick = () => $("roomInput").focus();

/* ── Room ── */
function makeRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function urlRoom() { return new URLSearchParams(location.search).get("room") || ""; }

$("createRoomBtn").onclick = () => {
  const id = makeRoomId();
  password = $("passwordInput").value.trim();
  history.pushState(null, "", `?room=${id}`);
  startMeeting(id);
};

$("joinRoomBtn").onclick = () => {
  const id = $("roomInput").value.trim() || urlRoom();
  if (!id) return toast("Enter a Room ID.", "error");
  password = $("passwordInput").value.trim();
  history.pushState(null, "", `?room=${id}`);
  startMeeting(id);
};

$("genIcsBtn") && ($("genIcsBtn").onclick = () => {
  const id = $("roomInput").value.trim() || makeRoomId();
  downloadIcs("Meeting", id, new Date(Date.now() + 3600000));
});

/* ── Start Meeting ── */
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

async function startMeeting(id) {
  roomId = id;
  $("roomText").textContent = roomId;
  $("meetingTitle").textContent = `Room · ${roomId}`;
  $("dashboardLayout").classList.add("hidden");
  $("meetingScreen").classList.remove("hidden");
  startedAt = Date.now();
  timerInterval = setInterval(updateTimer, 1000);

  // Track meeting history
  const history = JSON.parse(localStorage.getItem("cn-history") || "[]");
  history.unshift({ roomId, date: new Date().toLocaleString(), duration: 0 });
  localStorage.setItem("cn-history", JSON.stringify(history.slice(0, 20)));

  // Stats
  let stats = JSON.parse(localStorage.getItem("cn-stats") || '{"meetings":0,"totalSec":0,"msgs":0}');
  stats.meetings++;
  localStorage.setItem("cn-stats", JSON.stringify(stats));

  try {
    const constraints = localStorage.getItem("cn-prefs-lowbw") === "true"
      ? { video: false, audio: true }
      : { video: true, audio: true };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    addVideoTile("local", `${currentUser.name} (You)`, currentUser.avatar, localStream, true);
    socket.emit("join-room", { roomId, user: currentUser, password });
    initSpeechDetection();
    initWhiteboard();
  } catch (e) {
    toast("Camera/mic permission required.", "error");
    console.error(e);
  }
}

function updateTimer() {
  const total = Math.floor((Date.now() - startedAt) / 1000);
  const min = String(Math.floor(total / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  $("timerText").textContent = `${min}:${sec}`;
}

/* ── Audio Detection (speaking indicator) ── */
function initSpeechDetection() {
  try {
    if (!speechCtx) speechCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = speechCtx.createMediaStreamSource(localStream);
    const analyser = speechCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const nowSpeaking = avg > 20 && !isMuted;
      if (nowSpeaking !== speaking) {
        speaking = nowSpeaking;
        socket.emit("speaking", { roomId, isSpeaking: speaking });
        const tile = $("tile-local");
        if (tile) tile.classList.toggle("speaking-highlight", speaking);
      }
    }, 300);
  } catch(e) {}
}

/* ── Video Tiles ── */
function addVideoTile(id, name, avatar, stream, muted = false) {
  let tile = $(`tile-${id}`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = `tile-${id}`;
    tile.innerHTML = `
      <video autoplay playsinline ${muted ? "muted" : ""}></video>
      <div class="video-avatar" id="avatar-${id}">
        <div class="avatar-circle" style="background:${currentUser.color||'linear-gradient(135deg,#7c6fff,#c084fc)'}">${avatar}</div>
        <h3>${name}</h3>
      </div>
      <div class="video-name">${name}</div>
      <div class="tile-actions">
        <button onclick="pinUser('${id}')" title="Pin">📌</button>
        ${id !== "local" ? `<button onclick="dmUser('${id}','${name}')" title="DM">💬</button>` : ""}
      </div>
    `;
    $("videoGrid").appendChild(tile);
  }
  const video = tile.querySelector("video");
  if (stream) {
    video.srcObject = stream;
    if (currentFilter !== "none") video.style.filter = currentFilter;
    if (isMirrored && muted) video.classList.add("mirrored");
  }
  const av = $(`avatar-${id}`);
  if (av) av.style.display = stream ? "none" : "grid";
  return tile;
}

function removeVideoTile(id) { const t = $(`tile-${id}`); if (t) t.remove(); }

function pinUser(id) {
  document.querySelectorAll(".video-tile").forEach(t => t.classList.remove("pinned"));
  const tile = $(`tile-${id}`);
  if (tile) { tile.classList.add("pinned"); pinnedUser = id; toast("📌 Pinned"); }
}

function dmUser(id, name) {
  dmTarget = id;
  $("dmTargetName").textContent = name;
  $("dmBanner").classList.remove("hidden");
  openRightPanel("chat");
  toast(`💬 DM mode: ${name}`);
}

/* ── WebRTC ── */
function createPeer(userId, user, offerer) {
  const pc = new RTCPeerConnection(rtcConfig);
  peers[userId] = pc;
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => addVideoTile(userId, user?.name || "Participant", user?.avatar || "GU", e.streams[0]);
  pc.onicecandidate = e => e.candidate && socket.emit("ice-candidate", { targetId: userId, candidate: e.candidate });
  if (offerer) {
    pc.createOffer().then(o => pc.setLocalDescription(o))
      .then(() => socket.emit("offer", { targetId: userId, offer: pc.localDescription }));
  }
  return pc;
}

socket.on("wrong-password", () => { toast("Wrong room password.", "error"); location.href = "/"; });
socket.on("room-locked", () => { toast("Room is locked by the host.", "error"); location.href = "/"; });
socket.on("you-are-banned", () => { alert("You have been banned from this room."); location.href = "/"; });

socket.on("room-ready", ({ existingUsers, notes, agenda, polls, locked, chat, hostId }) => {
  if ($("notesArea")) $("notesArea").value = notes || "";
  isHost = socket.id === hostId;
  if (locked) $("roomLockedBadge").classList.remove("hidden");
  existingUsers.forEach(u => createPeer(u.id, u, true));
  // Render polls
  if (polls) polls.forEach(p => renderPoll(p));
  // Render agenda
  if (agenda) { agendaItems = agenda; renderAgenda(); }
  // Restore chat
  if (chat) chat.forEach(m => appendMessage(m.name, m.message, m.time, false, m.id));
  if (isHost) $("newPollBtn").style.display = "flex";
  else { $("newPollBtn").style.display = "none"; $("createPollForm").classList.add("hidden"); }
});

socket.on("offer", async ({ fromId, offer, user }) => {
  const pc = createPeer(fromId, user, false);
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("answer", { targetId: fromId, answer });
});

socket.on("answer", async ({ fromId, answer }) => {
  if (peers[fromId]) await peers[fromId].setRemoteDescription(answer);
});

socket.on("ice-candidate", async ({ fromId, candidate }) => {
  if (peers[fromId]) await peers[fromId].addIceCandidate(candidate);
});

socket.on("user-joined", user => {
  addSystemMessage(`${user.name} joined 👋`);
  if (soundsEnabled) SOUNDS.join();
  if (user.name !== currentUser.name) toast(`👋 ${user.name} joined`, "info");
});

socket.on("user-left", id => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  removeVideoTile(id);
  if (soundsEnabled) SOUNDS.leave();
});

socket.on("speaking-update", ({ userId, isSpeaking }) => {
  const tile = $(`tile-${userId}`);
  if (tile) tile.classList.toggle("speaking-highlight", isSpeaking);
  const item = document.querySelector(`.participant-item[data-id="${userId}"]`);
  if (item) item.classList.toggle("speaking", isSpeaking);
});

socket.on("participants-update", users => {
  participants = users;
  $("participantCount").textContent = users.length;
  const list = $("participantsList");
  list.innerHTML = users.map(u => `
    <div class="participant-item${u.isSpeaking ? " speaking" : ""}" data-id="${u.id}">
      <div class="part-avatar" style="background:${currentUser.color||'linear-gradient(135deg,#7c6fff,#c084fc)'}">${u.avatar || initials(u.name)}</div>
      <div class="part-info">
        <div class="part-name">${u.name}${u.handRaised ? " ✋" : ""}${u.isHost ? " 👑" : ""}</div>
        <div class="part-role">${u.role || (u.isHost ? "Host" : "Participant")}</div>
        <div class="part-talk-time">🗣 ${Math.floor((u.talkTime||0)/60)}m ${(u.talkTime||0)%60}s</div>
      </div>
      ${isHost && u.id !== socket.id ? `
        <div class="part-actions">
          <button onclick="hostMute('${u.id}')" title="Mute">🔇</button>
          <button onclick="hostKick('${u.id}')" title="Remove">✕</button>
          <button onclick="hostBan('${u.id}','${u.name}')" title="Ban">🚫</button>
        </div>` : ""}
    </div>
  `).join("");

  // Hand queue
  const raised = users.filter(u => u.handRaised).sort((a,b) => a.handQueuePos - b.handQueuePos);
  const qs = $("handQueueSection");
  if (raised.length) {
    qs.classList.remove("hidden");
    $("handQueueList").innerHTML = raised.map((u,i) => `<div class="hand-queue-item">${i+1}. ${u.name}</div>`).join("");
  } else {
    qs.classList.add("hidden");
  }
});

window.hostMute = id => socket.emit("host-mute-user", { targetId: id });
window.hostKick = id => socket.emit("host-remove-user", { targetId: id });
window.hostBan = (id, name) => socket.emit("host-ban-user", { targetId: id, targetName: name });

socket.on("muted-by-host", () => { if (!isMuted) $("muteBtn").click(); toast("🔇 Muted by host"); });
socket.on("removed-by-host", () => { alert("You were removed by the host."); location.href = "/"; });
socket.on("system-message", addSystemMessage);
socket.on("room-locked-status", locked => {
  const badge = $("roomLockedBadge");
  if (locked) badge.classList.remove("hidden"); else badge.classList.add("hidden");
  $("lockRoomBtn").textContent = locked ? "🔓 Unlock Room" : "🔒 Lock Room";
  $("lockRoomBtn").dataset.locked = locked;
});

socket.on("reaction", ({ from, reaction }) => {
  $("reactionBubble").textContent = reaction;
  addSystemMessage(`${from} reacted ${reaction}`);
  if (["🎉","👏","💯"].includes(reaction)) launchConfetti();
  setTimeout(() => $("reactionBubble").textContent = "", 2500);
});

socket.on("notes-update", notes => { if ($("notesArea")) $("notesArea").value = notes; });
socket.on("agenda-update", ag => { agendaItems = ag; renderAgenda(); });
socket.on("poll-created", poll => { renderPoll(poll); toast("📊 New poll launched!"); });
socket.on("poll-update", poll => { renderPoll(poll, true); });

socket.on("msg-reaction", ({ msgId, emoji, from }) => {
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  let row = msgEl.querySelector(".msg-reactions-row");
  if (!row) { row = document.createElement("div"); row.className = "msg-reactions-row"; msgEl.appendChild(row); }
  const existing = row.querySelector(`[data-emoji="${emoji}"]`);
  if (existing) { existing.textContent = emoji + " " + (parseInt(existing.dataset.count||1)+1); existing.dataset.count = (parseInt(existing.dataset.count||1)+1); }
  else { const chip = document.createElement("span"); chip.className = "msg-react-chip"; chip.dataset.emoji = emoji; chip.dataset.count = 1; chip.textContent = emoji + " 1"; row.appendChild(chip); }
});

socket.on("whiteboard-draw", data => wbRemoteDraw(data));
socket.on("whiteboard-clear", () => { const canvas = $("whiteboardCanvas"); canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height); });

/* ── Controls ── */
$("muteBtn").onclick = () => {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $("muteBtn").classList.toggle("active", isMuted);
  $("muteBtn").querySelector(".ctrl-icon").textContent = isMuted ? "🔇" : "🎙️";
  $("muteBtn").querySelector(".ctrl-label").textContent = isMuted ? "Unmute" : "Mute";
  if (isMuted) socket.emit("talk-end", { roomId }); else socket.emit("talk-start", { roomId });
};

$("cameraBtn").onclick = () => {
  isCameraOff = !isCameraOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !isCameraOff);
  $("cameraBtn").classList.toggle("active", isCameraOff);
  $("cameraBtn").querySelector(".ctrl-label").textContent = isCameraOff ? "Start" : "Video";
  const av = $("avatar-local");
  if (av) av.style.display = isCameraOff ? "grid" : "none";
};

$("screenBtn").onclick = async () => {
  try {
    const ss = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = ss.getVideoTracks()[0];
    Object.values(peers).forEach(pc => {
      const s = pc.getSenders().find(s => s.track?.kind === "video");
      if (s) s.replaceTrack(track);
    });
    const v = document.querySelector("#tile-local video");
    if (v) v.srcObject = ss;
    $("screenBtn").classList.add("active");
    track.onended = () => {
      const ct = localStream.getVideoTracks()[0];
      Object.values(peers).forEach(pc => {
        const s = pc.getSenders().find(s => s.track?.kind === "video");
        if (s) s.replaceTrack(ct);
      });
      if (v) v.srcObject = localStream;
      $("screenBtn").classList.remove("active");
    };
  } catch(e) {}
};

$("blurBtn").onclick = () => {
  isBlurred = !isBlurred;
  $("blurBtn").classList.toggle("active", isBlurred);
  const v = document.querySelector("#tile-local video");
  if (v) v.style.filter = isBlurred ? "blur(8px)" : (currentFilter !== "none" ? currentFilter : "");
  toast(isBlurred ? "🌫️ Background blur on" : "🌫️ Blur off");
};

$("filterBtn").onclick = e => { $("filterPicker").classList.toggle("hidden"); e.stopPropagation(); };
document.querySelectorAll(".filter-opt").forEach(btn => {
  btn.onclick = () => {
    currentFilter = btn.dataset.filter;
    document.querySelectorAll(".filter-opt").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".video-tile video").forEach(v => v.style.filter = currentFilter === "none" ? "" : currentFilter);
    $("filterPicker").classList.add("hidden");
  };
});

$("handBtn").onclick = () => {
  handRaised = !handRaised;
  $("handBtn").classList.toggle("active", handRaised);
  $("handBtn").querySelector(".ctrl-label").textContent = handRaised ? "Lower" : "Hand";
  socket.emit("raise-hand", { roomId, raised: handRaised });
};

$("reactionBtn").onclick = e => { $("reactionPicker").classList.toggle("hidden"); e.stopPropagation(); };
document.querySelectorAll(".react-opt").forEach(btn => {
  btn.onclick = () => {
    socket.emit("reaction", { roomId, reaction: btn.dataset.r });
    $("reactionPicker").classList.add("hidden");
  };
});

$("soundboardBtn").onclick = e => { $("soundboard").classList.toggle("hidden"); e.stopPropagation(); };
document.querySelectorAll(".sound-btn").forEach(btn => {
  btn.onclick = () => { if (SOUNDS[btn.dataset.sound]) SOUNDS[btn.dataset.sound](); };
});

/* ── Layout ── */
document.querySelectorAll(".layout-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".layout-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentLayout = btn.dataset.layout;
    const grid = $("videoGrid");
    grid.className = `video-grid layout-${currentLayout}`;
    socket.emit("layout-change", { roomId, layout: currentLayout });
  };
});

socket.on("layout-change", layout => {
  currentLayout = layout;
  $("videoGrid").className = `video-grid layout-${currentLayout}`;
});

/* ── Captions ── */
$("captionsToggleBtn").onclick = () => {
  captionsOn = !captionsOn;
  $("captionsBar").classList.toggle("hidden", !captionsOn);
  $("captionsToggleBtn").classList.toggle("active", captionsOn);
  if (captionsOn) startCaptions(); else stopCaptions();
};

function startCaptions() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast("Captions not supported in this browser", "error"); return; }
  recognition = new SpeechRecognition();
  recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = e => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join(" ");
    $("captionsText").textContent = transcript;
  };
  recognition.start();
}

function stopCaptions() { if (recognition) { recognition.stop(); recognition = null; } $("captionsText").textContent = "Captions will appear here…"; }

/* ── Right Panel ── */
function openRightPanel(tab) {
  $("rightPanel").classList.add("open");
  rightPanelOpen = true;
  const tabs = { chat: "chatTabBtn", notes: "notesTabBtn", whiteboard: "whiteboardTabBtn", polls: "pollTabBtn", agenda: "agendaTabBtn" };
  const panels = { chat: "chatPanel", notes: "notesPanel", whiteboard: "whiteboardPanel", polls: "pollsPanel", agenda: "agendaPanel" };
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".panel-body").forEach(p => p.classList.add("hidden"));
  if (tabs[tab]) $(tabs[tab]).classList.add("active");
  if (panels[tab]) $(panels[tab]).classList.remove("hidden");
  if (tab === "whiteboard") resizeWhiteboard();
  if (tab === "chat") { unreadCount = 0; $("unreadBadge").classList.add("hidden"); }
}

$("chatOpenBtn").onclick = () => openRightPanel("chat");
$("notesOpenBtn").onclick = () => openRightPanel("notes");
$("whiteboardBtn").onclick = () => openRightPanel("whiteboard");
$("pollBtn").onclick = () => openRightPanel("polls");
$("agendaBtn").onclick = () => openRightPanel("agenda");
$("mobileParticipantsBtn").onclick = () => $("leftPanel").classList.toggle("open");
$("closePanelBtn").onclick = () => { $("rightPanel").classList.remove("open"); rightPanelOpen = false; };

$("chatTabBtn").onclick = () => openRightPanel("chat");
$("notesTabBtn").onclick = () => openRightPanel("notes");
$("whiteboardTabBtn").onclick = () => openRightPanel("whiteboard");
$("pollTabBtn").onclick = () => openRightPanel("polls");
$("agendaTabBtn").onclick = () => openRightPanel("agenda");

/* ── Chat ── */
$("sendMessageBtn").onclick = sendMessage;
$("messageInput").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
$("clearDmBtn") && ($("clearDmBtn").onclick = () => { dmTarget = null; $("dmBanner").classList.add("hidden"); });

function sendMessage() {
  const msg = $("messageInput").value.trim();
  if (!msg) return;
  socket.emit("chat-message", { roomId, message: msg, dm: dmTarget });
  $("messageInput").value = "";
  meetingChatLog.push({ sender: currentUser.name, msg, time: new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) });
}

socket.on("chat-message", ({ id, name, message, time, isPrivate }) => {
  appendMessage(name, message, time, false, id, isPrivate);
  if (!rightPanelOpen) {
    unreadCount++;
    $("unreadBadge").textContent = unreadCount;
    $("unreadBadge").classList.remove("hidden");
  }
  if (soundsEnabled) SOUNDS.message();
  let stats = JSON.parse(localStorage.getItem("cn-stats") || '{"meetings":0,"totalSec":0,"msgs":0}');
  if (name === currentUser.name) { stats.msgs = (stats.msgs || 0) + 1; localStorage.setItem("cn-stats", JSON.stringify(stats)); }
});

function appendMessage(sender, body, time, isSystem, msgId, isPrivate) {
  const list = $("messages");
  const div = document.createElement("div");
  div.className = `msg-item${isSystem ? " msg-system" : ""}${isPrivate ? " msg-dm" : ""}`;
  if (msgId) div.dataset.msgId = msgId;
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-sender">${isPrivate ? "🔒 " : ""}${sender}</span>
      <span class="msg-time">${time || ""}</span>
    </div>
    <div class="msg-body">${body}</div>
    ${msgId && !isSystem ? `<div class="msg-reactions-row"></div>` : ""}
  `;
  if (msgId && !isSystem) {
    div.addEventListener("dblclick", () => {
      const emojis = ["👍","❤️","😂","🔥"];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      socket.emit("msg-reaction", { roomId, msgId, emoji });
    });
  }
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function addSystemMessage(text) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  appendMessage("System", text, time, true);
}

$("fileInput").onchange = () => {
  if ($("fileInput").files[0]) {
    socket.emit("file-shared", { roomId, fileName: $("fileInput").files[0].name });
    $("fileInput").value = "";
  }
};

/* ── Notes ── */
$("notesArea").oninput = () => socket.emit("notes-update", { roomId, notes: $("notesArea").value });

$("exportNotesBtn").onclick = () => {
  const blob = new Blob([$("notesArea").value], { type: "text/plain" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `notes-${roomId}.txt`; a.click();
  toast("📥 Notes exported");
};

$("clearNotesBtn").onclick = () => { $("notesArea").value = ""; socket.emit("notes-update", { roomId, notes: "" }); };

/* ── Whiteboard ── */
function initWhiteboard() {
  const canvas = $("whiteboardCanvas");
  if (!canvas) return;
  resizeWhiteboard();
  const ctx = canvas.getContext("2d");
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }

  function startDraw(e) {
    wbDrawing = true;
    const p = getPos(e); wbLastX = p.x; wbLastY = p.y;
    e.preventDefault();
  }

  function draw(e) {
    if (!wbDrawing) return;
    e.preventDefault();
    const p = getPos(e);
    ctx.globalCompositeOperation = wbTool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = $("wbColor").value;
    ctx.lineWidth = parseInt($("wbSize").value);
    ctx.beginPath(); ctx.moveTo(wbLastX, wbLastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    socket.emit("whiteboard-draw", { roomId, data: { x1: wbLastX, y1: wbLastY, x2: p.x, y2: p.y, color: $("wbColor").value, size: $("wbSize").value, eraser: wbTool === "eraser" } });
    wbLastX = p.x; wbLastY = p.y;
  }

  canvas.addEventListener("mousedown", startDraw);
  canvas.addEventListener("mousemove", draw);
  canvas.addEventListener("mouseup", () => wbDrawing = false);
  canvas.addEventListener("touchstart", startDraw, { passive: false });
  canvas.addEventListener("touchmove", draw, { passive: false });
  canvas.addEventListener("touchend", () => wbDrawing = false);
}

function resizeWhiteboard() {
  const canvas = $("whiteboardCanvas");
  if (!canvas) return;
  const panel = canvas.parentElement;
  canvas.width = panel.clientWidth - 28;
  canvas.height = panel.clientHeight - 80;
}

function wbRemoteDraw({ x1, y1, x2, y2, color, size, eraser }) {
  const canvas = $("whiteboardCanvas"); if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
  ctx.strokeStyle = color; ctx.lineWidth = size; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}

document.querySelectorAll(".wb-tool").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".wb-tool").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    wbTool = btn.dataset.tool;
  };
});

$("wbClearBtn").onclick = () => {
  const canvas = $("whiteboardCanvas");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  socket.emit("whiteboard-clear", { roomId });
};

/* ── Polls ── */
$("newPollBtn") && ($("newPollBtn").onclick = () => $("createPollForm").classList.toggle("hidden"));
$("addPollOptionBtn") && ($("addPollOptionBtn").onclick = () => {
  const inp = document.createElement("input");
  inp.className = "poll-opt"; inp.placeholder = `Option ${$("pollOptions").querySelectorAll("input").length + 1}`;
  inp.style.marginBottom = "6px";
  $("pollOptions").appendChild(inp);
});
$("cancelPollBtn") && ($("cancelPollBtn").onclick = () => $("createPollForm").classList.add("hidden"));
$("launchPollBtn") && ($("launchPollBtn").onclick = () => {
  const q = $("pollQuestion").value.trim();
  const opts = Array.from($("pollOptions").querySelectorAll("input")).map(i => i.value.trim()).filter(Boolean);
  if (!q || opts.length < 2) return toast("Enter a question and at least 2 options.", "error");
  socket.emit("create-poll", { roomId, question: q, options: opts });
  $("createPollForm").classList.add("hidden");
  $("pollQuestion").value = "";
});

function renderPoll(poll, update = false) {
  const list = $("pollsList");
  let card = document.querySelector(`[data-poll-id="${poll.id}"]`);
  const totalVotes = poll.options.reduce((s, o) => s + o.voters.length, 0);
  const myVote = poll.options.findIndex(o => o.voters.includes(socket.id));

  const html = `
    <div class="poll-card" data-poll-id="${poll.id}">
      <div class="poll-q">${poll.question} ${!poll.active ? "✅ Closed" : ""}</div>
      ${poll.options.map((opt, i) => {
        const pct = totalVotes ? Math.round(opt.voters.length / totalVotes * 100) : 0;
        return `<div class="poll-option${myVote === i ? " voted" : ""}" onclick="votePoll(${poll.id}, ${i})">
          <div class="poll-option-label"><span>${opt.text}</span><span>${pct}% (${opt.voters.length})</span></div>
          <div class="poll-bar-wrap"><div class="poll-bar" style="width:${pct}%"></div></div>
        </div>`;
      }).join("")}
      ${isHost && poll.active ? `<button onclick="closePoll(${poll.id})" class="btn-ghost" style="font-size:12px;margin-top:8px">Close Poll</button>` : ""}
    </div>
  `;

  if (card) card.outerHTML = html;
  else list.insertAdjacentHTML("afterbegin", html);
}

window.votePoll = (pollId, idx) => socket.emit("vote-poll", { roomId, pollId, optionIndex: idx });
window.closePoll = id => socket.emit("close-poll", { roomId, pollId: id });

/* ── Agenda ── */
$("addAgendaBtn").onclick = () => {
  const text = $("agendaItemInput").value.trim();
  if (!text) return;
  agendaItems.push({ text, done: false });
  socket.emit("agenda-update", { roomId, agenda: agendaItems });
  $("agendaItemInput").value = "";
  renderAgenda();
};

function renderAgenda() {
  $("agendaList").innerHTML = agendaItems.map((item, i) => `
    <div class="agenda-item${item.done ? " done" : ""}">
      <span class="agenda-check" onclick="toggleAgenda(${i})">${item.done ? "✅" : "⬜"}</span>
      <span>${item.text}</span>
    </div>
  `).join("");
}

window.toggleAgenda = i => {
  agendaItems[i].done = !agendaItems[i].done;
  socket.emit("agenda-update", { roomId, agenda: agendaItems });
  renderAgenda();
};

/* ── Room Controls ── */
$("copyLinkBtn").onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast("🔗 Invite link copied!");
};

$("showQrBtn").onclick = () => {
  const link = location.href;
  $("qrLinkInput").value = link;
  $("qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(link)}`;
  $("qrModal").classList.remove("hidden");
};

$("closeQrBtn").onclick = () => $("qrModal").classList.add("hidden");
$("qrModal").onclick = e => { if (e.target === $("qrModal")) $("qrModal").classList.add("hidden"); };
$("copyQrLinkBtn").onclick = async () => { await navigator.clipboard.writeText($("qrLinkInput").value); toast("Copied!"); };

$("shareWhatsappMeetBtn") && ($("shareWhatsappMeetBtn").onclick = () => {
  const url = `https://wa.me/?text=${encodeURIComponent("Join my ConnectNow meeting: " + location.href)}`;
  window.open(url, "_blank");
});

$("lockRoomBtn").onclick = () => {
  const locked = $("lockRoomBtn").dataset.locked !== "true";
  socket.emit("lock-room", { roomId, locked });
};

$("attendanceBtn").onclick = () => {
  const csv = "Name,Email,Host,Hand Raised,Talk Time (sec),Messages,Reactions\n" + participants.map(p =>
    `"${p.name}","${p.email||""}",${p.isHost},${p.handRaised},${p.talkTime||0},${p.messages||0},${p.reactions||0}`
  ).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `attendance-${roomId}.csv`; a.click();
  toast("📋 Attendance exported");
};

/* ── AI Summary ── */
$("aiSummaryBtn").onclick = () => {
  $("aiModal").classList.remove("hidden");
  $("aiLoading").style.display = "flex";
  $("aiSummaryContent").innerHTML = "";
  $("aiSummaryContent").appendChild($("aiLoading"));

  const notes = $("notesArea").value || "(no notes)";
  const chatSample = meetingChatLog.slice(-20).map(m => `${m.sender}: ${m.msg}`).join("\n") || "(no chat)";
  const duration = $("timerText").textContent;
  const partNames = participants.map(p => p.name).join(", ");

  const prompt = `You are a professional meeting assistant. Generate a concise meeting summary.\n\nMeeting Duration: ${duration}\nParticipants: ${partNames}\n\nShared Notes:\n${notes}\n\nChat Highlights:\n${chatSample}\n\nProvide:\n1. Summary (2-3 sentences)\n2. Key Discussion Points (bullet list)\n3. Action Items (bullet list)\n4. Next Steps\n\nBe concise and professional.`;

  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
  })
  .then(r => r.json())
  .then(data => {
    const text = data.content?.[0]?.text || "Could not generate summary.";
    $("aiSummaryContent").innerHTML = `<div style="white-space:pre-wrap">${text}</div>`;
    window._aiSummaryText = text;
  })
  .catch(() => {
    $("aiSummaryContent").innerHTML = generateLocalSummary(notes, chatSample, duration, partNames);
    window._aiSummaryText = $("aiSummaryContent").textContent;
  });
};

function generateLocalSummary(notes, chat, duration, participants) {
  return `<div style="white-space:pre-wrap"><b>📋 Meeting Summary</b>

⏱ Duration: ${duration}
👥 Participants: ${participants}

<b>📝 Notes Recap:</b>
${notes.substring(0, 400) || "No notes taken."}

<b>💬 Chat Highlights:</b>
${chat.substring(0, 300) || "No chat messages."}

<b>✅ Status:</b> Meeting completed successfully.</div>`;
}

$("closeAiModal").onclick = () => $("aiModal").classList.add("hidden");
$("copyAiSummaryBtn").onclick = () => { navigator.clipboard.writeText(window._aiSummaryText || ""); toast("📋 Copied!"); };
$("exportAiSummaryBtn").onclick = () => {
  const blob = new Blob([window._aiSummaryText || ""], { type: "text/plain" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `summary-${roomId}.txt`; a.click();
};

/* ── Leave ── */
$("leaveBtn").onclick = leaveMeeting;

function leaveMeeting() {
  // Save stats
  if (startedAt) {
    const dur = Math.floor((Date.now() - startedAt) / 1000);
    let stats = JSON.parse(localStorage.getItem("cn-stats") || '{"meetings":0,"totalSec":0,"msgs":0}');
    stats.totalSec = (stats.totalSec || 0) + dur;
    localStorage.setItem("cn-stats", JSON.stringify(stats));
    // Update history
    const hist = JSON.parse(localStorage.getItem("cn-history") || "[]");
    if (hist[0]) { hist[0].duration = dur; localStorage.setItem("cn-history", JSON.stringify(hist)); }
  }

  localStream?.getTracks().forEach(t => t.stop());
  Object.values(peers).forEach(pc => pc.close());
  clearInterval(timerInterval);
  stopCaptions();
  $("moodModal").classList.remove("hidden");
}

document.querySelectorAll(".mood-btn").forEach(btn => {
  btn.onclick = () => { $("moodModal").classList.add("hidden"); toast(`Thanks for the feedback! You rated: ${btn.dataset.mood}`); setTimeout(() => location.href = "/", 500); };
});
$("skipMoodBtn").onclick = () => { $("moodModal").classList.add("hidden"); location.href = "/"; };

/* ── Keyboard Shortcuts ── */
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const key = e.key.toLowerCase();
  if (!$("meetingScreen").classList.contains("hidden")) {
    if (key === "m") $("muteBtn").click();
    else if (key === "v") $("cameraBtn").click();
    else if (key === "s") $("screenBtn").click();
    else if (key === "h") $("handBtn").click();
    else if (key === "c") openRightPanel("chat");
    else if (key === "n") openRightPanel("notes");
    else if (key === "w") openRightPanel("whiteboard");
    else if (key === "r") $("reactionBtn").click();
    else if (key === "q") leaveMeeting();
    else if (key === "?") $("shortcutsModal").classList.remove("hidden");
  }
});

$("closeShortcutsModal") && ($("closeShortcutsModal").onclick = () => $("shortcutsModal").classList.add("hidden"));

document.addEventListener("click", () => {
  $("reactionPicker")?.classList.add("hidden");
  $("filterPicker")?.classList.add("hidden");
  $("soundboard")?.classList.add("hidden");
});

/* ── Dashboard Sections ── */
function loadProfileInputs() {
  if ($("profileName")) $("profileName").value = currentUser?.name || "";
  if ($("profileEmail")) $("profileEmail").value = currentUser?.email || "";
  const prefs = JSON.parse(localStorage.getItem("cn-prefs") || "{}");
  if ($("prefSounds")) $("prefSounds").checked = prefs.sounds !== false;
  if ($("prefCaptions")) $("prefCaptions").checked = prefs.captions || false;
  if ($("prefMirror")) $("prefMirror").checked = prefs.mirror || false;
  if ($("prefLowBW")) $("prefLowBW").checked = prefs.lowbw || false;
  soundsEnabled = prefs.sounds !== false;
}

$("saveProfileBtn").onclick = () => {
  currentUser.name = $("profileName").value.trim() || currentUser.name;
  currentUser.email = $("profileEmail").value.trim() || currentUser.email;
  currentUser.avatar = initials(currentUser.name);
  const prefs = { sounds: $("prefSounds").checked, captions: $("prefCaptions").checked, mirror: $("prefMirror").checked, lowbw: $("prefLowBW").checked };
  localStorage.setItem("cn-prefs", JSON.stringify(prefs));
  localStorage.setItem("cn-prefs-lowbw", prefs.lowbw);
  soundsEnabled = prefs.sounds;
  saveUser(currentUser);
  if ($("userNameTop")) $("userNameTop").textContent = currentUser.name;
  toast("✅ Profile saved!");
};

$("clearDataBtn").onclick = () => {
  if (confirm("Clear all local data?")) { localStorage.clear(); location.reload(); }
};

/* ── Schedule ── */
$("saveScheduleBtn").onclick = () => {
  const title = $("scheduleTitle").value.trim();
  const date = $("scheduleDate").value;
  const rId = $("scheduleRoom").value.trim() || makeRoomId();
  if (!title || !date) return toast("Enter title and date.", "error");
  const items = JSON.parse(localStorage.getItem("cn-schedules") || "[]");
  items.push({ title, date, roomId: rId });
  localStorage.setItem("cn-schedules", JSON.stringify(items));
  $("scheduleTitle").value = ""; $("scheduleDate").value = "";
  renderSchedules(); checkNextMeeting();
  toast("📅 Meeting scheduled!");
};

$("downloadIcsBtn").onclick = () => {
  const title = $("scheduleTitle").value.trim() || "Meeting";
  const date = $("scheduleDate").value;
  if (!date) return toast("Enter a date first.", "error");
  downloadIcs(title, $("scheduleRoom").value || makeRoomId(), new Date(date));
};

$("shareWhatsappBtn").onclick = () => {
  const title = $("scheduleTitle").value.trim() || "Meeting";
  const date = $("scheduleDate").value;
  const url = `https://wa.me/?text=${encodeURIComponent(`Join "${title}" on ConnectNow at ${date}.\nLink: ${location.origin}?room=${$("scheduleRoom").value || makeRoomId()}`)}`;
  window.open(url, "_blank");
};

function downloadIcs(title, rId, date) {
  const start = date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const end = new Date(date.getTime() + 3600000).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const link = `${location.origin}?room=${rId}`;
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${start}\nDTEND:${end}\nSUMMARY:${title}\nDESCRIPTION:Join: ${link}\nURL:${link}\nEND:VEVENT\nEND:VCALENDAR`;
  const a = document.createElement("a"); a.href = "data:text/calendar," + encodeURIComponent(ics);
  a.download = `${title.replace(/\s/g,"_")}.ics`; a.click();
  toast("📅 Calendar file downloaded");
}

function renderSchedules() {
  const items = JSON.parse(localStorage.getItem("cn-schedules") || "[]");
  $("scheduleList").innerHTML = items.length ? items.map((s, i) => `
    <div class="list-item">
      <b>${s.title}</b> <small>Room: ${s.roomId}</small><br>
      <small>${new Date(s.date).toLocaleString()}</small>
      <div style="margin-top:8px;display:flex;gap:8px">
        <a href="?room=${s.roomId}" class="btn-primary" style="padding:5px 12px;font-size:12px;text-decoration:none">Join</a>
        <button onclick="deleteSchedule(${i})" class="btn-ghost" style="font-size:12px">Delete</button>
      </div>
    </div>
  `).join("") : '<p style="color:var(--text-3);font-size:14px">No scheduled meetings yet.</p>';
}

window.deleteSchedule = i => {
  const items = JSON.parse(localStorage.getItem("cn-schedules") || "[]");
  items.splice(i, 1); localStorage.setItem("cn-schedules", JSON.stringify(items));
  renderSchedules(); checkNextMeeting();
};

function checkNextMeeting() {
  const items = JSON.parse(localStorage.getItem("cn-schedules") || "[]");
  const upcoming = items.filter(s => new Date(s.date) > new Date()).sort((a,b) => new Date(a.date)-new Date(b.date));
  if (upcoming.length && $("nextMeetingBanner")) {
    const next = upcoming[0];
    $("nextMeetingBanner").classList.remove("hidden");
    $("nextMeetingName").textContent = next.title;
    $("nextMeetingJoin").href = `?room=${next.roomId}`;
    function updateCountdown() {
      const diff = new Date(next.date) - new Date();
      if (diff <= 0) { $("nextMeetingCountdown").textContent = "Now!"; return; }
      const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
      $("nextMeetingCountdown").textContent = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    updateCountdown();
    setInterval(updateCountdown, 60000);
  }
}

/* ── Messages ── */
$("saveQuickMessageBtn").onclick = () => {
  const text = $("quickMessage").value.trim();
  if (!text) return;
  const items = JSON.parse(localStorage.getItem("cn-qmsgs") || "[]");
  items.push({ text, date: new Date().toLocaleString() });
  localStorage.setItem("cn-qmsgs", JSON.stringify(items));
  $("quickMessage").value = "";
  renderQuickMessages(); toast("💾 Note saved!");
};

function renderQuickMessages() {
  const items = JSON.parse(localStorage.getItem("cn-qmsgs") || "[]");
  $("quickMessageList").innerHTML = items.length ? items.slice().reverse().map(i => `
    <div class="list-item"><div style="font-size:12px;color:var(--text-3);margin-bottom:4px">${i.date}</div>${i.text}</div>
  `).join("") : '<p style="color:var(--text-3);font-size:14px">No saved notes yet.</p>';
}

/* ── Contacts ── */
$("addContactBtn").onclick = () => {
  const name = $("contactName").value.trim(), email = $("contactEmail").value.trim();
  if (!name || !email) return toast("Enter name and email.", "error");
  const contacts = JSON.parse(localStorage.getItem("cn-contacts") || "[]");
  contacts.push({ name, email });
  localStorage.setItem("cn-contacts", JSON.stringify(contacts));
  $("contactName").value = ""; $("contactEmail").value = "";
  renderContacts(); toast("👤 Contact added!");
};

function renderContacts() {
  const contacts = JSON.parse(localStorage.getItem("cn-contacts") || "[]");
  $("contactList").innerHTML = contacts.length ? contacts.map((c, i) => `
    <div class="list-item">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:grid;place-items:center;font-weight:700;font-size:13px;color:white;flex-shrink:0">${initials(c.name)}</div>
        <div><b>${c.name}</b><br><small><a href="mailto:${c.email}" style="color:var(--accent-2)">${c.email}</a></small></div>
      </div>
    </div>
  `).join("") : '<p style="color:var(--text-3);font-size:14px">No contacts yet.</p>';
}

/* ── Analytics ── */
function renderAnalytics() {
  const stats = JSON.parse(localStorage.getItem("cn-stats") || '{"meetings":0,"totalSec":0,"msgs":0}');
  const history = JSON.parse(localStorage.getItem("cn-history") || "[]");
  if ($("statTotalMeetings")) $("statTotalMeetings").textContent = stats.meetings || 0;
  if ($("statTotalTime")) $("statTotalTime").textContent = Math.round((stats.totalSec || 0) / 3600 * 10) / 10 + "h";
  const avgSec = history.length ? history.reduce((a,b) => a+(b.duration||0), 0) / history.length : 0;
  if ($("statAvgDur")) $("statAvgDur").textContent = Math.round(avgSec / 60) + "m";
  if ($("statMsgSent")) $("statMsgSent").textContent = stats.msgs || 0;
  if ($("meetingHistory")) {
    $("meetingHistory").innerHTML = history.length ? history.map(h => `
      <div class="list-item">
        <b>${h.roomId}</b> <small>${h.date}</small><br>
        <small>Duration: ${Math.floor((h.duration||0)/60)}m ${(h.duration||0)%60}s</small>
        <a href="?room=${h.roomId}" class="btn-ghost" style="font-size:12px;padding:4px 10px;margin-left:8px">Rejoin</a>
      </div>
    `).join("") : '<p style="color:var(--text-3);font-size:14px">No meeting history yet.</p>';
  }
}

/* ── Init ── */
loadUser();
const existingRoom = urlRoom();
if (existingRoom && $("roomInput")) $("roomInput").value = existingRoom;

// Preferences
const prefs = JSON.parse(localStorage.getItem("cn-prefs") || "{}");
if (prefs.mirror) isMirrored = true;
if (prefs.sounds === false) soundsEnabled = false;
