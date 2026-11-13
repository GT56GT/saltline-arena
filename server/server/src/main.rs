use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

fn env(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter(env("RUST_LOG", "info")).init();
    let port: u16 = env("PORT", "8790").parse().expect("PORT");
    let min_players: usize = env("MIN_PLAYERS", &server::DEFAULT_MIN_PLAYERS.to_string()).parse().expect("MIN_PLAYERS");
    let db = server::db::connect(&env("DATABASE_URL", "sqlite://arena.db")).await.expect("database");
    let chain_id: u64 = env("CHAIN_ID", "84532").parse().expect("CHAIN_ID"); // Base Sepolia
    let registry = env("REGISTRY_ADDRESS", "0x0000000000000000000000000000000000000000").parse().expect("REGISTRY_ADDRESS");
    let signer = Arc::new(server::sign::ArenaSigner::new(&env("SIGNER_KEY", ""), chain_id, registry));
    if std::env::var("SIGNER_KEY").is_err() {
        tracing::warn!("SIGNER_KEY not set: using a throwaway signing key {:#x} (development only)", signer.address());
    }
    let contracts: serde_json::Value = serde_json::from_str(&env("CONTRACTS_JSON", "{}")).unwrap_or_default();
    let allowed_domains = env("ALLOWED_DOMAINS", "").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let map: fn() -> game_core::Map = if env("MAP", "harbour") == "yard" { game_core::Map::yard } else { game_core::Map::harbour };
    let mut lobby = server::Lobby::new(map, min_players);
    lobby.kill_target = env("KILL_TARGET", "30").parse().expect("KILL_TARGET");
    // SPAWN_RULE=nearest: spawn close to other players (practice servers, browser tests).
    lobby.spawn_near = env("SPAWN_RULE", "farthest") == "nearest";
    lobby.match_ticks = env("MATCH_SECONDS", "480").parse::<u32>().expect("MATCH_SECONDS") * game_core::TICK_HZ;
    let lobby = Arc::new(Mutex::new(lobby));
    let state = server::AppState { lobby, db, signer, allowed_domains, contracts };

    match server::settle::SettleConfig::from_env() {
        Some(cfg) => {
            tracing::info!("on-chain settlement every {:?} to registry {:#x}", cfg.every, cfg.registry);
            server::settle::spawn_settler(state.clone(), cfg);
        }
        None => tracing::info!("on-chain settlement off (set RPC_URL, RELAYER_KEY, REGISTRY_ADDRESS to enable)"),
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    tracing::info!("saltline arena server on ws://{addr}/ws (signer {:#x})", state.signer.address());
    server::serve(listener, state).await;
}
