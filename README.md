# Saltline Arena

Free-to-play, wallet-native PvP shooter. The server referees every match; the chain stores only signed results.

| Folder | What | Status |
| --- | --- | --- |
| `server/` | Rust workspace: `game-core` (shared rules), `protocol`, `server` (match server), `game-wasm` (rules for the browser) | Phase 1 ✅ |
| `apps/web/` | React + react-three-fiber client | Playable prototype ✅ |
| `contracts/` | Solidity + Foundry | Phase 3 |

## Play locally
```sh
# terminal 1 — the authoritative match server
cd server && cargo run --release --bin arena-server     # ws://localhost:8790/ws

# terminal 2 — the client
cd apps/web && npm install && npm run dev                # http://localhost:5173
```
Open the page in two browser windows (or on two machines on the same network, using
`http://<your-ip>:5173` and server `ws://<your-ip>:8790/ws`) and fight.

Controls: WASD move · mouse aim · LMB fire · Shift sprint · Space jump · C crouch · R reload · Tab scores.

## Tests
```sh
cd server && cargo test                  # rules, anti-cheat gate, lag compensation, prediction
cd apps/web && node e2e/play.cjs         # browser vs bot on a running server (needs Playwright)
```

## How it fits together
- Clients send only inputs (movement, aim, fire). The server simulates everyone at 30 ticks/s with
  `game-core`, judges every shot with lag compensation (max 200 ms rewind), and broadcasts results.
- The browser runs the same `game-core` compiled to WebAssembly to predict its own movement instantly,
  then reconciles with each server snapshot. Other players are drawn 100 ms in the past, smoothly.
- Rebuild the WASM after changing `game-core`: `cd apps/web && npm run wasm` (needs `wasm-pack`).
