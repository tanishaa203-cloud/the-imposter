const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
const TURN_MS = 45000;
const VOTE_MS = 60000;
const GUESS_MS = 30000;

const CATEGORIES = {
  food: ["Biryani", "Hilsa", "Mango", "Pizza", "Khichuri", "Burger", "Tea", "Coffee"],
  jobs: ["Doctor", "Nurse", "Teacher", "Engineer", "Pilot", "Farmer"],
  transport: ["Rickshaw", "CNG", "Train", "Bus", "Boat", "Bicycle"],
  sports: ["Cricket", "Football", "Badminton", "Tennis", "Kabaddi"],
  nature: ["Moon", "Sun", "River", "Mountain", "Rain", "Sea"],
  animals: ["Tiger", "Elephant", "Parrot", "Crocodile", "Cow", "Cat"],
};

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += letters[Math.floor(Math.random() * letters.length)];
  }
  return code;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const nameOf = (room, id) => (room.players.find((p) => p.id === id) || {}).name || "Player";

function sendLobby(code) {
  const r = rooms[code];
  io.to(code).emit("lobby", { code, host: r.host, players: r.players });
}

function startTurn(code) {
  const r = rooms[code];
  if (!r) return;
  const n = r.order.length;

  if (r.turn >= 3 * n) {
    startVote(code);
    return;
  }

  const round = Math.floor(r.turn / n) + 1;
  const id = r.order[r.turn % n];
  r.ends = Date.now() + TURN_MS;

  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    r.hints.push({ round, id, name: nameOf(r, id), text: "(no hint)" });
    r.turn++;
    startTurn(code);
  }, TURN_MS);

  io.to(code).emit("turn", {
    round,
    currentId: id,
    currentName: nameOf(r, id),
    ends: r.ends,
    hints: r.hints,
  });
}

function startVote(code) {
  const r = rooms[code];
  if (!r) return;
  r.phase = "vote";
  r.votes = {};
  r.ends = Date.now() + VOTE_MS;

  clearTimeout(r.timer);
  r.timer = setTimeout(() => revealVotes(code), VOTE_MS);

  io.to(code).emit("voteStart", {
    players: r.players.map((p) => ({ id: p.id, name: p.name })),
    ends: r.ends,
    hints: r.hints,
  });
}

function revealVotes(code) {
  const r = rooms[code];
  if (!r || r.phase !== "vote") return;
  r.phase = "voteDone";
  clearTimeout(r.timer);

  const counts = {};
  Object.values(r.votes).forEach((t) => {
    counts[t] = (counts[t] || 0) + 1;
  });

  const tally = r.players
    .map((p) => ({ id: p.id, name: p.name, votes: counts[p.id] || 0 }))
    .sort((a, b) => b.votes - a.votes);

  let suspect = null;
  if (tally[0].votes > 0 && (tally.length < 2 || tally[0].votes > tally[1].votes)) {
    suspect = tally[0].id;
  }
  r.suspect = suspect;

  io.to(code).emit("voteResult", {
    tally,
    suspectName: suspect ? nameOf(r, suspect) : null,
  });

  r.timer = setTimeout(() => startGuess(code), 5000);
}

function startGuess(code) {
  const r = rooms[code];
  if (!r || r.phase !== "voteDone") return;
  r.phase = "guess";
  r.guess = null;
  r.ends = Date.now() + GUESS_MS;

  clearTimeout(r.timer);
  r.timer = setTimeout(() => finishGame(code), GUESS_MS);

  io.to(code).emit("guessStart", { ends: r.ends });
  io.to(r.impostor).emit("guessPrompt");
}

function finishGame(code) {
  const r = rooms[code];
  if (!r || r.phase !== "guess") return;
  r.phase = "results";
  clearTimeout(r.timer);

  const imp = r.impostor;
  const correct = !!r.guess && norm(r.guess) === norm(r.mainWord);
  const caught = r.suspect === imp;

  const gained = {};
  r.players.forEach((p) => (gained[p.id] = 0));
  Object.entries(r.votes).forEach(([voter, target]) => {
    if (target === imp) gained[voter] += 20;
  });
  if (!caught) gained[imp] += 30;
  if (correct) gained[imp] += 15;

  r.totals = r.totals || {};
  r.players.forEach((p) => {
    r.totals[p.id] = (r.totals[p.id] || 0) + gained[p.id];
  });

  const board = r.players
    .map((p) => ({ name: p.name, gained: gained[p.id], total: r.totals[p.id] }))
    .sort((a, b) => b.total - a.total);

  io.to(code).emit("results", {
    impostorName: nameOf(r, imp),
    mainWord: r.mainWord,
    impostorWord: r.words[imp],
    guess: r.guess,
    correct,
    caught,
    suspectName: r.suspect ? nameOf(r, r.suspect) : null,
    votes: Object.entries(r.votes).map(([v, t]) => ({
      voter: nameOf(r, v),
      target: nameOf(r, t),
    })),
    board,
    hints: r.hints,
  });
}

io.on("connection", (socket) => {
  socket.on("createRoom", (name) => {
    const code = makeCode();
    rooms[code] = { host: socket.id, players: [{ id: socket.id, name }], started: false };
    socket.join(code);
    socket.data.code = code;
    sendLobby(code);
  });

  socket.on("joinRoom", ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit("problem", "Room not found.");
    if (room.started) return socket.emit("problem", "Game already started.");
    if (room.players.length >= 6) return socket.emit("problem", "Room is full.");
    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.data.code = code;
    sendLobby(code);
  });

  socket.on("startGame", () => {
    const room = rooms[socket.data.code];
    if (!room || room.host !== socket.id || room.started) return;
    if (room.players.length < 4) {
      return socket.emit("problem", "Need at least 4 players.");
    }

    room.started = true;

    // two different categories: one for everyone, one for the Impostor
    const cats = shuffle(Object.keys(CATEGORIES));
    const pick = (cat) => CATEGORIES[cat][Math.floor(Math.random() * CATEGORIES[cat].length)];
    const mainWord = pick(cats[0]);
    const impostorWord = pick(cats[1]);
    const impostor = room.players[Math.floor(Math.random() * room.players.length)].id;

    room.impostor = impostor;
    room.mainWord = mainWord;
    room.words = {};
    room.players.forEach((p) => {
      room.words[p.id] = p.id === impostor ? impostorWord : mainWord;
      io.to(p.id).emit("yourWord", { word: room.words[p.id], impostor: p.id === impostor });
    });

    room.order = shuffle(room.players.map((p) => p.id));
    room.turn = 0;
    room.hints = [];
    room.votes = {};
    room.guess = null;
    room.suspect = null;
    room.phase = "hints";

    io.to(socket.data.code).emit("gameStarted");
    startTurn(socket.data.code);
  });

  socket.on("sendHint", (text) => {
    const code = socket.data.code;
    const r = rooms[code];
    if (!r || r.phase !== "hints") return;
    const n = r.order.length;
    if (r.turn >= 3 * n || r.order[r.turn % n] !== socket.id) return;

    text = String(text || "").trim().slice(0, 60);
    if (!text) return;
    if (norm(text).includes(norm(r.words[socket.id]))) {
      return socket.emit("problem", "Do not say your own word!");
    }

    r.hints.push({
      round: Math.floor(r.turn / n) + 1,
      id: socket.id,
      name: nameOf(r, socket.id),
      text,
    });
    clearTimeout(r.timer);
    r.turn++;
    startTurn(code);
  });

  socket.on("vote", (targetId) => {
    const code = socket.data.code;
    const r = rooms[code];
    if (!r || r.phase !== "vote") return;
    if (r.votes[socket.id]) return;
    if (targetId === socket.id) {
      return socket.emit("problem", "You cannot vote for yourself.");
    }
    if (!r.players.some((p) => p.id === targetId)) return;

    r.votes[socket.id] = targetId;
    socket.emit("voteLocked");

    const count = Object.keys(r.votes).length;
    io.to(code).emit("voteCount", { count, total: r.players.length });
    if (count >= r.players.length) revealVotes(code);
  });

  socket.on("guess", (text) => {
    const r = rooms[socket.data.code];
    if (!r || r.phase !== "guess" || socket.id !== r.impostor) return;
    text = String(text || "").trim().slice(0, 40);
    if (!text) return;
    r.guess = text;
    finishGame(socket.data.code);
  });

  socket.on("playAgain", () => {
    const code = socket.data.code;
    const r = rooms[code];
    if (!r || r.host !== socket.id || r.phase !== "results") return;
    clearTimeout(r.timer);
    r.started = false;
    r.phase = "lobby";
    io.to(code).emit("backToLobby");
    sendLobby(code);
  });
});

server.listen(3000, () => console.log("Running on http://localhost:3000"));