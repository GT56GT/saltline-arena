//! Settlement: every few minutes, send newly signed match results to the ArenaRegistry
//! contract in one batch. Runs only when an RPC endpoint and a relayer key are configured.
//! The relayer only pays gas; it cannot alter results, because the contract checks the
//! game server's signature on each one.

use std::time::Duration;

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, Bytes, B256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use sqlx::Row;

use crate::net::AppState;

sol! {
    #[sol(rpc)]
    contract ArenaRegistry {
        struct MatchResult { bytes32 matchId; uint64 endedAt; bytes32 resultsHash; }
        function submitResults(MatchResult[] calldata batch, bytes[] calldata sigs) external returns (uint256 settled);
        function isSettled(bytes32 matchId) external view returns (bool);
    }
}

#[derive(Clone)]
pub struct SettleConfig {
    pub rpc_url: String,
    pub relayer_key: String,
    pub registry: Address,
    pub every: Duration,
    pub batch: i64,
}

impl SettleConfig {
    pub fn from_env() -> Option<Self> {
        let rpc_url = std::env::var("RPC_URL").ok()?;
        let relayer_key = std::env::var("RELAYER_KEY").ok()?;
        let registry = std::env::var("REGISTRY_ADDRESS").ok()?.parse().ok()?;
        let every = Duration::from_secs(std::env::var("SETTLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600));
        Some(Self { rpc_url, relayer_key, registry, every, batch: 50 })
    }
}

/// Settle one batch. Returns how many matches were sent.
pub async fn settle_once(state: &AppState, cfg: &SettleConfig) -> Result<usize, String> {
    let rows = sqlx::query("SELECT id, ended_at, results_hash, signature FROM matches WHERE settled_tx IS NULL ORDER BY ended_at LIMIT ?")
        .bind(cfg.batch)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut ids = Vec::new();
    let mut batch = Vec::new();
    let mut sigs = Vec::new();
    for r in &rows {
        let id: String = r.get(0);
        let match_id: B256 = id.parse().map_err(|_| "bad match id")?;
        let results_hash: B256 = r.get::<String, _>(2).parse().map_err(|_| "bad results hash")?;
        let sig: Bytes = r.get::<String, _>(3).parse().map_err(|_| "bad signature")?;
        batch.push(ArenaRegistry::MatchResult { matchId: match_id, endedAt: r.get::<i64, _>(1) as u64, resultsHash: results_hash });
        sigs.push(sig);
        ids.push(id);
    }
    let key: PrivateKeySigner = cfg.relayer_key.parse().map_err(|_| "RELAYER_KEY is not a private key")?;
    let provider = ProviderBuilder::new().wallet(EthereumWallet::from(key)).connect_http(cfg.rpc_url.parse().map_err(|_| "bad RPC_URL")?);
    let registry = ArenaRegistry::new(cfg.registry, &provider);
    let pending = registry.submitResults(batch, sigs).send().await.map_err(|e| format!("send: {e}"))?;
    let receipt = tokio::time::timeout(Duration::from_secs(120), pending.get_receipt())
        .await
        .map_err(|_| "timed out waiting for the receipt")?
        .map_err(|e| format!("receipt: {e}"))?;
    if !receipt.status() {
        return Err(format!("settlement transaction reverted: {:#x}", receipt.transaction_hash));
    }
    let tx = format!("{:#x}", receipt.transaction_hash);
    for id in &ids {
        sqlx::query("UPDATE matches SET settled_tx = ? WHERE id = ?").bind(&tx).bind(id).execute(&state.db).await.map_err(|e| e.to_string())?;
    }
    Ok(ids.len())
}

/// Check on-chain whether a match is settled (for tests and the match page).
pub async fn is_settled(cfg: &SettleConfig, match_id: B256) -> Result<bool, String> {
    let provider = ProviderBuilder::new().connect_http(cfg.rpc_url.parse().map_err(|_| "bad RPC_URL")?);
    ArenaRegistry::new(cfg.registry, &provider).isSettled(match_id).call().await.map_err(|e| e.to_string())
}

pub fn spawn_settler(state: AppState, cfg: SettleConfig) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(cfg.every);
        loop {
            iv.tick().await;
            match settle_once(&state, &cfg).await {
                Ok(0) => {}
                Ok(n) => tracing::info!("settled {n} matches on-chain"),
                Err(e) => tracing::warn!("settlement failed (will retry): {e}"),
            }
        }
    });
}
