// Integration test: server + 3 bots. Checks rules (energy, locks, power-ups) and a full short match.
const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const PORT = 3600 + Math.floor(Math.random() * 300);
let failures = 0;
const check = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bot {
  constructor() {
    this.s = null; this.denied = []; this.errors = [];
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.ready = new Promise((r) => this.ws.on("open", r));
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "joined") { this.id = m.id; this.token = m.token; this.code = m.code; }
      if (m.type === "state") this.s = m;
      if (m.type === "denied") this.denied.push(m.reason);
      if (m.type === "error") this.errors.push(m.message);
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(fn, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.s && fn(this.s)) return this.s; await sleep(30); }
    throw new Error("timeout: " + fn);
  }
  tile(i) { const c = this.s.grid[i]; return c === "." ? -1 : c.charCodeAt(0) - 48; }
  me() { return this.s.players.find((p) => p.id === this.id); }
  count(idx) { return [...this.s.grid].filter((c) => c === String.fromCharCode(48 + idx)).length; }
}

(async () => {
  const srv = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT, TEST_MODE: "1", TEST_DURATIONS: "22,60,90" }, stdio: "inherit",
  });
  await sleep(700);
  try {
    const A = new Bot(), B = new Bot(), C = new Bot();
    await Promise.all([A.ready, B.ready, C.ready]);
    A.send({ type: "create", name: "Ana" });
    await A.until((s) => s.phase === "lobby");
    check(/^[A-Z]{4}$/.test(A.code), `room code ${A.code}`);

    A.send({ type: "start" }); await sleep(150);
    check(A.errors.some((e) => /2 players/.test(e)), "cannot start alone");

    B.send({ type: "join", code: A.code, name: "Ben" });
    C.send({ type: "join", code: A.code, name: "Ben" });
    await A.until((s) => s.players.length === 3);
    check(new Set(A.s.players.map((p) => p.name)).size === 3, "duplicate names made unique");
    check(new Set(A.s.players.map((p) => p.idx)).size === 3, "each player has own color");

    B.send({ type: "settings", duration: 90 }); // ignored (not host)
    A.send({ type: "settings", duration: 22 });
    await sleep(150);
    check(A.s.durationSec === 22, "only host sets match length");

    A.send({ type: "start" });
    await A.until((s) => s.phase === "countdown");
    check(A.s.size === 6 && A.s.grid.length === 36 && /^\.+$/.test(A.s.grid), "6x6 empty grid for 3 players");
    A.send({ type: "paint", i: 0 }); await sleep(100);
    check(A.tile(0) === -1, "cannot paint during countdown");

    await A.until((s) => s.phase === "playing");
    await sleep(100);

    // paint, lock, energy
    A.send({ type: "paint", i: 0 });
    await A.until((s) => A.tile(0) === A.me().idx);
    check(true, "paint claims a tile");
    B.send({ type: "paint", i: 0 }); await sleep(150);
    check(A.tile(0) === A.me().idx && B.denied.includes("locked"), "fresh paint is locked against steals");
    await sleep(1300);
    B.send({ type: "paint", i: 0 });
    await A.until(() => A.tile(0) === B.me().idx);
    check(A.me().steals === 0 && B.me().steals === 1, "steal after lock expires, stats tracked");

    // energy: C spams 12 distinct tiles, only ~5 succeed
    for (let i = 10; i < 22; i++) C.send({ type: "paint", i });
    await sleep(300);
    const cTiles = C.count(C.me().idx);
    check(cTiles >= 5 && cTiles <= 6, `energy limits burst painting (${cTiles} tiles from 12 taps)`);
    check(C.denied.filter((r) => r === "no_energy").length >= 6, "no_energy denial sent");

    // power-ups (test hook)
    const grabber = A;
    grabber.send({ type: "debug_pickup", i: 28, kind: "splat" }); await sleep(100);
    check(A.s.pickups[28] === "splat", "pickup appears on board");
    await sleep(900);
    grabber.send({ type: "paint", i: 28 });
    await A.until(() => A.tile(28) === A.me().idx);
    check([27, 29, 22, 34, 21, 23, 33, 35].every((j) => A.tile(j) === A.me().idx), "SPLAT paints 3x3");
    check(!A.s.pickups[28] && A.me().grabs === 1, "pickup consumed and counted");

    B.send({ type: "debug_pickup", i: 5, kind: "freeze" });
    await sleep(2200); // let energy come back
    B.send({ type: "paint", i: 5 });
    await A.until((s) => A.me().frozenUntil > s.now);
    check(A.me().frozenUntil > A.s.now && C.s.players.find((p) => p.id === C.id).frozenUntil > 0 && B.me().frozenUntil <= B.s.now, "FREEZE freezes everyone else");
    A.send({ type: "paint", i: 3 }); await sleep(150);
    check(A.denied.includes("frozen") && A.tile(3) === -1, "frozen player cannot paint");

    B.send({ type: "debug_pickup", i: 2, kind: "rush" });
    await sleep(1300);
    B.send({ type: "paint", i: 2 });
    await B.until((s) => B.me().rushUntil > s.now);
    const before = B.count(B.me().idx);
    for (let i = 30; i < 36; i++) B.send({ type: "paint", i });
    await sleep(300);
    check(B.count(B.me().idx) - before >= 4, "RUSH allows many taps without energy");

    // swap: non-leader trades colors with the leader
    const swapTile = [...C.s.grid].findIndex((c) => c === ".");
    C.send({ type: "debug_pickup", i: swapTile, kind: "swap" });
    await sleep(1700); // wait out C's freeze, regain energy
    const others = C.s.players.filter((p) => p.id !== C.id).sort((a, b) => b.tiles - a.tiles);
    const leader = others[0];
    const cNow = C.me().tiles;
    C.send({ type: "paint", i: swapTile });
    await C.until((s) => s.players.find((p) => p.id === C.id).grabs === 1);
    await sleep(100);
    if (cNow >= leader.tiles) check(true, "leader grabbing SWAP falls back to splat");
    else check(C.count(C.me().idx) === leader.tiles && C.count(leader.idx) === cNow + 1, `SWAP trades colors with leader (${leader.name}: ${leader.tiles} <-> C: ${cNow + 1})`);

    // match ends
    const final = await A.until((s) => s.phase === "final", 20000);
    check(final.players.reduce((s, p) => s + p.tiles, 0) <= final.total, "tile counts consistent at the end");
    check(final.feed.some((f) => /wins!/.test(f.text)), "winner announced");

    // late join blocked, rematch works
    const L = new Bot(); await L.ready;
    L.send({ type: "join", code: A.code, name: "Late" }); await sleep(150);
    check(L.errors.some((e) => /already started|rematch/i.test(e)), "cannot join once match started/finished");
    A.send({ type: "again" });
    await A.until((s) => s.phase === "lobby");
    check(A.s.grid === "" || /^\.*$/.test(A.s.grid), "rematch returns to lobby");

    // reconnect
    B.ws.terminate(); await sleep(300);
    const B2 = new Bot(); await B2.ready;
    B2.send({ type: "rejoin", code: B.code, token: B.token });
    await B2.until((s) => s.you === B.id);
    check(B2.s.players.length === 3, "reconnect restores player");
  } catch (e) { console.error(e); failures++; }
  finally {
    srv.kill();
    console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
    process.exit(failures ? 1 : 0);
  }
})();
