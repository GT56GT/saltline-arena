//! Writes real server signatures to contracts/test/fixtures so the Solidity tests can prove the
//! contracts accept exactly what this Rust server signs (same EIP-712 domain, types, encoding).

use alloy_primitives::{address, b256, Address};
use serde_json::json;
use server::sign::ArenaSigner;

/// Anvil's first default key (public test key, never used for real funds).
const TEST_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/// Where Foundry deploys the first contract created by the default test contract.
const REGISTRY: Address = address!("5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f");

#[test]
fn export_signature_fixtures() {
    let s = ArenaSigner::new(TEST_KEY, 31337, REGISTRY);
    let players = vec![address!("00000000000000000000000000000000000000aa"), address!("00000000000000000000000000000000000000bb"), Address::ZERO];
    let placings = vec![0u32, 1, 2];
    let deltas = vec![42i32, -42, 0];
    let results_hash = ArenaSigner::results_hash(&players, &placings, &deltas);
    let match_id = b256!("1111111111111111111111111111111111111111111111111111111111111111");
    let ended_at = 1_794_500_000u64;
    let player: Address = address!("00000000000000000000000000000000000000aa");
    let fixture = json!({
        "signer": format!("{:#x}", s.address()),
        "matchId": format!("{match_id:#x}"),
        "endedAt": ended_at,
        "resultsHash": format!("{results_hash:#x}"),
        "matchSig": s.sign_match(match_id, ended_at, results_hash),
        "player": format!("{player:#x}"),
        "cosmeticItem": 1,
        "cosmeticSig": s.sign_cosmetic(player, 1),
        "achievementId": 4,
        "achievementSig": s.sign_achievement(player, 4),
    });
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/test/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("server_sigs.json"), serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
    assert_eq!(format!("{:#x}", s.address()), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
}
