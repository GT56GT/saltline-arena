//! On-chain settlement against a real local chain. Skipped unless ANVIL_RPC and
//! ANVIL_REGISTRY are set (scripts/test-chain.sh starts Anvil, deploys, and sets them).

use alloy_primitives::B256;
use server::room::{Identity, MatchSummary};
use server::settle::{is_settled, settle_once, SettleConfig};
use std::time::Duration;

#[tokio::test]
async fn signed_results_settle_on_anvil() {
    let (Ok(rpc), Ok(registry)) = (std::env::var("ANVIL_RPC"), std::env::var("ANVIL_REGISTRY")) else {
        eprintln!("skipped: set ANVIL_RPC and ANVIL_REGISTRY (see scripts/test-chain.sh)");
        return;
    };
    let registry = registry.parse().unwrap();
    let mut state = server::test_state(0).await;
    // Server signs with Anvil key #1; the registry was deployed with that address as signer.
    state.signer = std::sync::Arc::new(server::sign::ArenaSigner::new(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        31337,
        registry,
    ));
    let summary = MatchSummary {
        room: 7,
        started_tick: 0,
        ended_tick: 30 * 60,
        players: vec![
            (1, "A".into(), Identity::default(), 5, 1, 1, 3, false),
            (2, "Gull-07".into(), Identity::default(), 1, 5, 0, 1, true),
        ],
    };
    let rec = server::records::save(&state.db, &state.signer, &summary).await.unwrap().unwrap();
    let cfg = SettleConfig {
        rpc_url: rpc,
        // Anvil key #2 relays: it only pays gas, it is not the signer.
        relayer_key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a".into(),
        registry,
        every: Duration::from_secs(1),
        batch: 50,
    };
    let id: B256 = rec.match_id.parse().unwrap();
    assert!(!is_settled(&cfg, id).await.unwrap());
    assert_eq!(settle_once(&state, &cfg).await.unwrap(), 1);
    assert!(is_settled(&cfg, id).await.unwrap(), "registry accepted the server-signed result");
    assert_eq!(settle_once(&state, &cfg).await.unwrap(), 0, "nothing left to settle");
}
