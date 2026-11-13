# Deploying Saltline Arena

Three independent pieces. Everything runs on free tiers.

## 1. Match server (Rust) — Render
1. `render login` (opens the browser once).
2. In Render: **New → Blueprint**, pick this repo; it reads `render.yaml`.
3. Set the secret env vars in the dashboard:
   - `SIGNER_KEY` — a fresh private key used only to sign results (`cast wallet new`). Its address goes into the contracts.
   - Leave `RPC_URL`/`RELAYER_KEY`/`REGISTRY_ADDRESS` empty until step 3.
4. Health check: `https://<service>.onrender.com/health` → `saltline arena ok`.

Free-tier limits: sleeps after ~15 min idle; no persistent disk (stats reset on redeploy).
For lasting stats, run the same Docker image on a free VM (e.g. Oracle Cloud Always Free) with a volume at `/data`.

## 2. Web client — Vercel
Project root `apps/web`, env `VITE_SERVER_URL=wss://<service>.onrender.com/ws`. Every push to `main` redeploys.

## 3. Contracts — Base Sepolia (testnet, free)
1. Get test ETH for a deployer wallet from a Base Sepolia faucet.
2. Deploy:
   ```sh
   cd contracts
   SIGNER_ADDRESS=<address of SIGNER_KEY> forge script script/Deploy.s.sol \
     --rpc-url https://sepolia.base.org --private-key <deployer key> --broadcast
   ```
3. On the server set `REGISTRY_ADDRESS`, `RPC_URL=https://sepolia.base.org`, `RELAYER_KEY` (a wallet with a little test ETH; it only pays gas),
   and `CONTRACTS_JSON={"registry":"0x…","cosmetics":"0x…","achievements":"0x…","ranks":"0x…"}`.
   Results then settle every 10 minutes and the Mint buttons appear in the client.

## Local development
```sh
cd server && cargo run --release --bin arena-server          # ws://localhost:8790/ws  (MAP=yard for the small test map,
                                                              #  SPAWN_RULE=nearest for practice/tests)
cd apps/web && npm install && npm run dev                      # http://localhost:5173
./scripts/test-chain.sh                                        # Anvil + contracts + settlement test
```
