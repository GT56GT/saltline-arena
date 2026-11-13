# Hushline

A free tactical shooter in the browser: squads and free-for-all in the Saltline container terminal, where footsteps give you away. Play at https://hushline-game.vercel.app (formerly Saltline Arena; the harbour map and the original renderer keep the Saltline name).

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

Controls: WASD move · mouse aim · LMB fire · RMB aim down sights · Shift sprint · Space jump (facing a
ledge up to one container high: climb) · C crouch · R reload · Tab scores · Esc menu and settings. Touch and gamepad work too (the original game's input system).
Renderer quality: add `?q=low|medium|high` to the page URL.

## Tests
```sh
cd server && cargo test                  # rules, anti-cheat gate, lag compensation, prediction
# browser vs scripted bot, through the original renderer (needs Playwright):
cd server && PORT=8791 MIN_PLAYERS=0 SPAWN_RULE=nearest cargo run --bin arena-server
cd apps/web && npm run build && npx vite preview --port 4173 & node e2e/play.cjs
node e2e/room.cjs                        # host a private room, friend joins by code, 1 v 1 start
node e2e/visual.cjs <dir>                # screenshots (server on 8790 with bots)
```

## How it fits together
- Clients send only inputs (movement, aim, fire). The server simulates everyone at 30 ticks/s with
  `game-core`, judges every shot with lag compensation (max 200 ms rewind), and broadcasts results.
- The browser runs the same `game-core` compiled to WebAssembly to predict its own movement instantly,
  then reconciles with each server snapshot. Other players are drawn 100 ms in the past, smoothly.
- Rebuild the WASM after changing `game-core`: `cd apps/web && npm run wasm` (needs `wasm-pack`).

## Combat rules (server-side, `game-core`)
- PAC-9: 18 damage, ×1.75 to the head, full damage to 25 m then down to 65% at 60 m — six body
  shots or four headshots up close. Hosts can scale damage (60–125%) in private rooms.
- Health regenerates (25/s) after 4 s without taking damage. Bots react slower and aim looser.
- Climbing: jump facing a ledge 0.6–2.75 m above your feet with room on top (single containers,
  not double stacks). ~0.5 s, no shooting meanwhile; deterministic, so prediction matches the server.

## Settings
Esc → Settings (or the lobby's Settings): sensitivity, invert, FOV, quality, master/effects/ambience
volume, and music in matches (off by default so footsteps are clear). Saved per device.

## Playing with friends (private rooms)
- **Create room** in the lobby: you are the host and get a 5-letter code; the address bar (`?room=CODE`)
  is the invite link. Friends paste the code or open the link.
- Before the match is a **warm-up**: everyone runs and shoots in the map, nobody can be hurt. Players
  pick **Harbour** or **Rust**; the host picks teams or free-for-all, kills to win and the time limit.
- **Bots join only if the host turns them on**: "fill the smaller team with bots when I start"
  (teams), a bot count (free-for-all), and "a bot takes over if someone leaves". Uneven teams such as
  1 v 2 are allowed; a team must not be empty. Friendly fire is off unless the host enables it.
- Only the host can change settings or start; if the host leaves, the next player takes over. After a
  match the room returns to warm-up for a rematch. Private rooms are casual: no rating change.
- Quick play is the public, ranked free-for-all with automatic bots.

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
