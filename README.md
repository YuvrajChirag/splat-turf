# Splat Turf

A real-time multiplayer paint-the-board party game. 2-8 players join from their own phones or laptops with a 4-letter room code. No login, no install.

## How to play

1. Tap a tile to paint it your color. Each tap costs 1 energy (you hold up to 5, it refills over time).
2. Paint over other colors to steal tiles. Fresh paint is protected for about 1.2 seconds.
3. Glowing tiles hold power-ups: Splat (paint 3x3), Freeze (everyone else can't paint for 3s), Rush (free taps for 5s), Swap (trade colors with the leader).
4. Last 10 seconds = Frenzy: energy refills twice as fast and more power-ups drop.
5. Most tiles when the clock hits zero wins.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000 in two browser tabs (one normal, one incognito)
```

Automated test (3 bot players check energy, locks, every power-up, rematch, reconnect):

```bash
npm test
```

## How it works

- `server.js`: Node HTTP server (serves `public/`) + WebSocket server (`ws`). The server is the single source of truth: it owns the grid, each player's energy, power-up spawns and the match clock (10 Hz loop). Clients only send intents (`paint`, `start`, ...) and the server validates and broadcasts the new state to everyone, which keeps every screen in sync.
- `public/index.html`: the whole client (HTML/CSS/JS). Renders whatever state the server sends, interpolates the energy bar and clock between updates, plays small synthesized sounds, and vibrates on power-ups on phones.
- Reconnect: a session token in `localStorage` puts you back in the same room after a refresh or network drop.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. On https://render.com choose New > Web Service and connect the repo.
3. Build command `npm install`, start command `npm start` (render.yaml has these).
4. Open the `https://<name>.onrender.com` URL and share it.

Free Render services sleep when idle, so the first load can take 30-50 seconds. Open the link once before sharing it.
