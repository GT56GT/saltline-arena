# Saltline Arena

Free-to-play, wallet-native PvP shooter. The server referees every match; the chain stores only signed results.

| Folder | What | Status |
| --- | --- | --- |
| `server/` | Rust workspace: `game-core` (shared rules), `protocol` (wire messages), `server` (match server) | Phase 1 prototype ✅ |
| `apps/web/` | React + react-three-fiber frontend | Next |
| `contracts/` | Solidity + Foundry | Phase 3 |

## Run the match server
```sh
cd server
cargo test          # rules, anti-cheat gate, lag compensation
cargo run --release --bin arena-server   # ws://localhost:8790/ws
```

## Trust model
Clients send only inputs (movement, aim, fire). The server simulates everyone at 30 ticks/s with
`game-core`, judges every shot with lag compensation (max 200 ms rewind), and broadcasts results.
There is no message a client can send that claims a position, a hit or a kill.
