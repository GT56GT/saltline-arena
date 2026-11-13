# Saltline Arena

Free-to-play, wallet-native PvP shooter. The server referees every match; the chain stores only signed results.

| Folder | What | Status |
| --- | --- | --- |
| `server/` | Rust: `game-core` (rules + Saltline harbour map), `protocol`, `server` (matches, bots, accounts, ratings, signing, settlement), `game-wasm` | ✅ |
| `apps/web/` | React lobby (wallet sign-in, profile, leaderboard, cosmetics) + the **original Saltline Three.js renderer** for matches | ✅ |
| `contracts/` | Solidity + Foundry: ArenaRegistry, Achievements, SeasonRanks, Cosmetics | ✅ (testnet deploy pending) |

See [DEPLOY.md](DEPLOY.md) to put it online.

## Play locally
```sh
# terminal 1 — the authoritative match server
cd server && cargo run --release --bin arena-server     # ws://localhost:8790/ws

# terminal 2 — the client
cd apps/web && npm install && npm run dev                # http://localhost:5173
```
Open the page in two browser windows (or on two machines on the same network, using
`http://<your-ip>:5173` and server `ws://<your-ip>:8790/ws`) and fight.

Controls: WASD move · mouse aim · LMB fire · RMB aim down sights · Shift sprint · Space jump · C crouch ·
R reload · Tab scores. Touch and gamepad work too (the original game's input system).
Renderer quality: add `?q=low|medium|high` to the page URL.

## Tests
```sh
cd server && cargo test                  # rules, anti-cheat gate, lag compensation, prediction
# browser vs scripted bot, through the original renderer (needs Playwright):
cd server && PORT=8791 MIN_PLAYERS=0 SPAWN_RULE=nearest cargo run --bin arena-server
cd apps/web && npm run build && npx vite preview --port 4173 & node e2e/play.cjs
node e2e/visual.cjs <dir>                # screenshots (server on 8790 with bots)
```

## How it fits together
- Clients send only inputs (movement, aim, fire). The server simulates everyone at 30 ticks/s with
  `game-core`, judges every shot with lag compensation (max 200 ms rewind), and broadcasts results.
- The browser runs the same `game-core` compiled to WebAssembly to predict its own movement instantly,
  then reconciles with each server snapshot. Other players are drawn 100 ms in the past, smoothly.
- Rebuild the WASM after changing `game-core`: `cd apps/web && npm run wasm` (needs `wasm-pack`).

## What you see in a match
- `apps/web/game/saltline.min.js` is the original Saltline game, unmodified. `game/build.mjs` (runs before
  `dev`/`build`) applies six exact-text hooks and writes `public/saltline/play.html`: the level, props,
  PBR materials, lighting, weather, post-processing, effects, audio, first-person PAC-9 and HUD are all the
  original. The hooks swap the single-player mission for Arena: no title menu or machines, the camera sits
  on the server-checked prediction, and only the server decides health and death.
- `src/game/bridge.ts` connects the two: the game's own input feeds the network client; server shots,
  hits, kills, reloads and respawns play through the game's own tracers, sparks, sounds, hit markers,
  damage arcs and kill feed.
- Other players are the contractor model (`public/models/operator.glb`, see `game/models/README.md`),
  skinned on a Mixamo skeleton and driven from server state: aim, stride, strafe, crouch, sprint, death.
  Its materials come from the game's own library; cosmetics recolour plates/helmet or light the goggles.
