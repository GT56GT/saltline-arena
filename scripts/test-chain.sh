#!/usr/bin/env bash
# Start a local chain (Anvil), deploy the Arena contracts, and run the Rust settlement test
# against them. Uses Anvil's public test keys only.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${ANVIL_PORT:-8545}
anvil --port "$PORT" --silent &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT
sleep 1.5
RPC="http://127.0.0.1:$PORT"
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0
SIGNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                            # anvil #1 address
OUT=$(cd contracts && SIGNER_ADDRESS=$SIGNER forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key $DEPLOYER --broadcast 2>&1)
REGISTRY=$(echo "$OUT" | awk '/ArenaRegistry/ {print $2; exit}')
echo "registry deployed at $REGISTRY"
cd server && ANVIL_RPC=$RPC ANVIL_REGISTRY=$REGISTRY cargo test --test settle_anvil -- --nocapture
