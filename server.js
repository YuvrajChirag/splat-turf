// Splat Turf - real-time multiplayer paint-territory game server
// Plain Node HTTP server (static files) + WebSocket (ws). Server is authoritative:
// it owns the grid, energy, power-ups and the clock, and broadcasts state to everyone.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TEST_MODE = process.env.TEST_MODE === "1";

// ---- Game constants ----
const MAX_PLAYERS = 8;
const ENERGY_MAX = 5;
const REGEN_MS = 650;          // one energy back every 0.65s
const FRENZY_REGEN_MS = 330;   // double speed during frenzy
const FRENZY_MS = 10000;       // last 10 seconds
const LOCK_MS = 1200;          // fresh paint is locked against steals for 1.2s
const FREEZE_MS = 3000;
const RUSH_MS = 5000;
const COUNTDOWN_MS = 3500;
const SPAWN_MS = 5000;
const FRENZY_SPAWN_MS = 2200;
const DURATIONS = (process.env.TEST_DURATIONS || "45,60,90").split(",").map(Number);
const POWERS = [["splat", 35], ["freeze", 25], ["rush", 25], ["swap", 15]];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// ---- helpers ----
function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let t = 0; t < 50; t++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error("no room code");
}
function cleanName(raw) {
  return String(raw || "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 14);
}
function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const c = `${name.slice(0, 11)} ${i}`;
    if (!taken.has(c.toLowerCase())) return c;
  }
  return name;
}
function pickWeighted() {
  const total = POWERS.reduce((s, [, w]) => s + w, 0);
  let r = crypto.randomInt(total);
  for (const [k, w] of POWERS) { if ((r -= w) < 0) return k; }
  return "splat";
}
function gridSizeFor(n) { return n <= 3 ? 6 : n <= 5 ? 7 : 8; }

function createRoom() {
  const room = {
    code: makeCode(),
    phase: "lobby", // lobby | countdown | playing | final
    players: new Map(),
    hostId: null,
    durationSec: 60,
    size: 6,
    grid: [],
    pickups: new Map(),
    startsAt: 0,
    endsAt: 0,
    nextSpawn: 0,
    dirty: false,
    lastBroadcast: 0,
    feed: [],
    feedId: 0,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name, ws) {
  const used = new Set([...room.players.values()].map((p) => p.idx));
  let idx = 0;
  while (used.has(idx)) idx++;
  const id = crypto.randomBytes(4).toString("hex");
  const p = {
    id, idx, name, token: crypto.randomBytes(16).toString("hex"), ws, connected: true, dropTimer: null,
    energy: ENERGY_MAX, energyAt: Date.now(), frozenUntil: 0, rushUntil: 0, grabs: 0, steals: 0,
  };
  room.players.set(id, p);
  if (!room.hostId) room.hostId = id;
  return p;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function inFrenzy(room, now) { return room.phase === "playing" && now >= room.endsAt - FRENZY_MS; }

function refreshEnergy(room, p, now) {
  const regen = inFrenzy(room, now) ? FRENZY_REGEN_MS : REGEN_MS;
  p.energy = Math.min(ENERGY_MAX, p.energy + (now - p.energyAt) / regen);
  p.energyAt = now;
}

function counts(room) {
  const c = new Map();
  for (const t of room.grid) if (t.o >= 0) c.set(t.o, (c.get(t.o) || 0) + 1);
  return c;
}

function addFeed(room, text, idx) {
  room.feed.push({ id: ++room.feedId, text, idx });
  if (room.feed.length > 6) room.feed.shift();
}

function stateFor(room, me, now) {
  const c = counts(room);
  const regen = inFrenzy(room, now) ? FRENZY_REGEN_MS : REGEN_MS;
  const locks = {};
  room.grid.forEach((t, i) => { if (t.lock > now) locks[i] = t.lock; });
  const players = [...room.players.values()].map((p) => ({
    id: p.id, idx: p.idx, name: p.name, connected: p.connected,
    tiles: c.get(p.idx) || 0, frozenUntil: p.frozenUntil, rushUntil: p.rushUntil,
    grabs: p.grabs, steals: p.steals,
  }));
  if (me && room.phase === "playing") refreshEnergy(room, me, now);
  return {
    type: "state", now, code: room.code, phase: room.phase, you: me ? me.id : null, youIdx: me ? me.idx : -1,
    hostId: room.hostId, durationSec: room.durationSec, size: room.size, players,
    startsAt: room.startsAt, endsAt: room.endsAt, frenzyMs: FRENZY_MS,
    grid: room.grid.map((t) => (t.o < 0 ? "." : String.fromCharCode(48 + t.o))).join(""),
    locks, pickups: Object.fromEntries(room.pickups),
    energy: me ? me.energy : 0, energyMax: ENERGY_MAX, regenMs: regen,
    feed: room.feed,
    total: room.grid.length,
  };
}

function broadcast(room) {
  const now = Date.now();
  room.lastBroadcast = now;
  room.dirty = false;
  for (const p of room.players.values()) if (p.connected) send(p.ws, stateFor(room, p, now));
}

// ---- game flow ----
function startCountdown(room) {
  room.size = gridSizeFor(room.players.size);
  room.grid = Array.from({ length: room.size * room.size }, () => ({ o: -1, lock: 0 }));
  room.pickups = new Map();
  room.feed = [];
  const now = Date.now();
  for (const p of room.players.values()) {
    p.energy = ENERGY_MAX; p.energyAt = now; p.frozenUntil = 0; p.rushUntil = 0; p.grabs = 0; p.steals = 0;
  }
  room.phase = "countdown";
  room.startsAt = now + COUNTDOWN_MS;
  room.endsAt = room.startsAt + room.durationSec * 1000;
  room.nextSpawn = room.startsAt + 2500;
  broadcast(room);
}

function spawnPickup(room, kind) {
  const free = [];
  room.grid.forEach((_, i) => { if (!room.pickups.has(i)) free.push(i); });
  if (!free.length) return;
  room.pickups.set(free[crypto.randomInt(free.length)], kind || pickWeighted());
  room.dirty = true;
}

function applyPower(room, p, i, kind, now) {
  const n = room.size;
  const label = { splat: "💥 SPLAT", freeze: "🧊 FREEZE", rush: "⚡ RUSH", swap: "🔀 SWAP" };
  p.grabs += 1;
  if (kind === "swap") {
    const c = counts(room);
    let leader = null, best = -1;
    for (const q of room.players.values()) {
      if (q.id === p.id) continue;
      const v = c.get(q.idx) || 0;
      if (v > best) { best = v; leader = q; }
    }
    const mine = c.get(p.idx) || 0;
    if (!leader || mine >= best) kind = "splat"; // leader grabbing swap gets a splat instead
    else {
      for (const t of room.grid) {
        if (t.o === p.idx) t.o = leader.idx;
        else if (t.o === leader.idx) t.o = p.idx;
      }
      addFeed(room, `${p.name} 🔀 SWAPPED with ${leader.name}!`, p.idx);
      return;
    }
  }
  if (kind === "splat") {
    const x = i % n, y = Math.floor(i / n);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (room.grid[j].o >= 0 && room.grid[j].o !== p.idx) p.steals += 1;
      room.grid[j].o = p.idx;
      room.grid[j].lock = now + LOCK_MS;
    }
  } else if (kind === "freeze") {
    for (const q of room.players.values()) if (q.id !== p.id) q.frozenUntil = now + FREEZE_MS;
  } else if (kind === "rush") {
    p.rushUntil = now + RUSH_MS;
  }
  addFeed(room, `${p.name} ${label[kind]}!`, p.idx);
}

function tryPaint(room, p, i, now) {
  if (room.phase !== "playing" || now < room.startsAt || now >= room.endsAt) return "not_playing";
  if (!Number.isInteger(i) || i < 0 || i >= room.grid.length) return "bad_tile";
  if (now < p.frozenUntil) return "frozen";
  const t = room.grid[i];
  if (t.o === p.idx) return "own";
  if (t.lock > now) return "locked";
  const rush = now < p.rushUntil;
  if (!rush) {
    refreshEnergy(room, p, now);
    if (p.energy < 1) return "no_energy";
    p.energy -= 1;
  }
  if (t.o >= 0) p.steals += 1;
  t.o = p.idx;
  t.lock = now + LOCK_MS;
  const kind = room.pickups.get(i);
  if (kind) {
    room.pickups.delete(i);
    applyPower(room, p, i, kind, now);
  }
  room.dirty = true;
  return null;
}

function finish(room) {
  room.phase = "final";
  const now = Date.now();
  for (const p of room.players.values()) { p.frozenUntil = 0; p.rushUntil = 0; }
  const c = counts(room);
  const ranked = [...room.players.values()].sort((a, b) => (c.get(b.idx) || 0) - (c.get(a.idx) || 0));
  if (ranked[0]) addFeed(room, `${ranked[0].name} wins!`, ranked[0].idx);
  room.dirty = true;
  broadcast(room);
}

// global game loop (10 Hz)
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "countdown" && now >= room.startsAt) {
      room.phase = "playing";
      for (const p of room.players.values()) { p.energy = ENERGY_MAX; p.energyAt = now; }
      room.dirty = true;
    }
    if (room.phase === "playing") {
      if (now >= room.endsAt) { finish(room); continue; }
      const maxPickups = room.players.size <= 3 ? 2 : 3;
      if (now >= room.nextSpawn) {
        if (room.pickups.size < maxPickups) spawnPickup(room);
        room.nextSpawn = now + (inFrenzy(room, now) ? FRENZY_SPAWN_MS : SPAWN_MS);
      }
    }
    if (room.phase === "playing" || room.phase === "countdown") {
      if (room.dirty || now - room.lastBroadcast > 1000) broadcast(room);
    }
  }
}, 100);

// ---- membership ----
function reassignHost(room) {
  const h = room.players.get(room.hostId);
  if (h && h.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  if (next) room.hostId = next.id;
}
function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  if (p.dropTimer) clearTimeout(p.dropTimer);
  room.players.delete(id);
  // free their tiles when they leave for good
  for (const t of room.grid) if (t.o === p.idx) t.o = -1;
  reassignHost(room);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  room.dirty = true;
  broadcast(room);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.ctx = null;
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg && typeof msg.type === "string") handle(ws, msg);
  });
  ws.on("close", () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    const p = room && room.players.get(ctx.id);
    if (!p || p.ws !== ws) return;
    p.connected = false;
    reassignHost(room);
    p.dropTimer = setTimeout(() => removePlayer(room, p.id), room.phase === "lobby" ? 20000 : 90000);
    broadcast(room);
  });
});

function handle(ws, msg) {
  const ctx = ws.ctx;
  const room = ctx ? rooms.get(ctx.code) : null;
  const me = room ? room.players.get(ctx.id) : null;

  switch (msg.type) {
    case "create": {
      if (ctx) return;
      const name = cleanName(msg.name);
      if (!name) return send(ws, { type: "error", message: "Enter a name first." });
      const r = createRoom();
      const p = addPlayer(r, name, ws);
      ws.ctx = { code: r.code, id: p.id };
      send(ws, { type: "joined", code: r.code, token: p.token, id: p.id });
      broadcast(r);
      return;
    }
    case "join": {
      if (ctx) return;
      const code = String(msg.code || "").toUpperCase().trim();
      const r = rooms.get(code);
      if (!r) return send(ws, { type: "error", message: `Room ${code || "?"} not found.` });
      if (r.phase !== "lobby") return send(ws, { type: "error", message: "That match already started. Ask the host for a rematch!" });
      if (r.players.size >= MAX_PLAYERS) return send(ws, { type: "error", message: "Room is full (max 8 players)." });
      const base = cleanName(msg.name);
      if (!base) return send(ws, { type: "error", message: "Enter a name first." });
      const p = addPlayer(r, uniqueName(r, base), ws);
      ws.ctx = { code: r.code, id: p.id };
      send(ws, { type: "joined", code: r.code, token: p.token, id: p.id });
      broadcast(r);
      return;
    }
    case "rejoin": {
      if (ctx) return;
      const r = rooms.get(String(msg.code || "").toUpperCase());
      const p = r && [...r.players.values()].find((x) => x.token === msg.token);
      if (!p) return send(ws, { type: "rejoin_failed" });
      if (p.dropTimer) clearTimeout(p.dropTimer);
      p.dropTimer = null;
      if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
      p.ws = ws;
      p.connected = true;
      ws.ctx = { code: r.code, id: p.id };
      send(ws, { type: "joined", code: r.code, token: p.token, id: p.id });
      reassignHost(r);
      broadcast(r);
      return;
    }
    case "settings": {
      if (!me || room.phase !== "lobby" || room.hostId !== me.id) return;
      const d = Number(msg.duration);
      if (DURATIONS.includes(d)) room.durationSec = d;
      broadcast(room);
      return;
    }
    case "start": {
      if (!me || room.hostId !== me.id || room.phase !== "lobby") return;
      if ([...room.players.values()].filter((p) => p.connected).length < 2)
        return send(ws, { type: "error", message: "Need at least 2 players to start." });
      startCountdown(room);
      return;
    }
    case "paint": {
      if (!me) return;
      const err = tryPaint(room, me, Number(msg.i), Date.now());
      if (err && err !== "not_playing") send(ws, { type: "denied", reason: err, i: Number(msg.i) });
      return;
    }
    case "again": {
      if (!me || room.hostId !== me.id || room.phase !== "final") return;
      room.phase = "lobby";
      room.grid = [];
      room.pickups = new Map();
      room.feed = [];
      room.startsAt = room.endsAt = 0;
      broadcast(room);
      return;
    }
    case "leave": {
      if (!me) return;
      ws.ctx = null;
      removePlayer(room, me.id);
      send(ws, { type: "left" });
      return;
    }
    case "debug_pickup": { // tests only
      if (!TEST_MODE || !room) return;
      room.pickups.set(Number(msg.i), String(msg.kind));
      room.dirty = true;
      return;
    }
  }
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (anyone) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > 10 * 60 * 1000) rooms.delete(code);
  }
}, 60000);

server.listen(PORT, () => console.log(`Splat Turf running on http://localhost:${PORT}`));
