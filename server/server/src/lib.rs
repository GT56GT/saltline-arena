//! Hushline match server.
//!
//! - `room`  — one authoritative match (simulation, hit validation, lag compensation)
//! - `bot`   — server-side bots that play through the same input path as humans
//! - `lobby` — matchmaker: rooms of 8, bot top-up, room lifecycle
//! - `sight` — fog of war: who may know where an opponent is
//! - `net`   — HTTP + WebSocket endpoints

pub mod api;
pub mod auth;
pub mod bot;
pub mod cosmetics;
pub mod db;
pub mod lobby;
pub mod net;
pub mod rating;
pub mod records;
pub mod room;
pub mod settle;
pub mod sight;
pub mod sign;

use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use lobby::Lobby;
pub use net::{router, AppState};
pub use room::{Room, MAX_REWIND_TICKS};

pub type SharedLobby = Arc<Mutex<Lobby>>;

/// Default rooms are topped up with bots to this many players.
pub const DEFAULT_MIN_PLAYERS: usize = 4;

/// Run the 30 Hz simulation for every room.
pub fn spawn_ticker(lobby: SharedLobby) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs_f32(game_core::DT));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            iv.tick().await;
            lobby.lock().unwrap().step();
        }
    });
}

/// Record finished matches (ratings, history, achievements, signatures) off the game loop.
pub fn spawn_recorder(state: AppState) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_millis(500));
        loop {
            iv.tick().await;
            let done: Vec<_> = std::mem::take(&mut state.lobby.lock().unwrap().finished);
            for m in done {
                match records::save(&state.db, &state.signer, &m).await {
                    Ok(Some(r)) => {
                        tracing::info!("recorded match {} ({} rated)", r.match_id, r.deltas.len())
                    }
                    Ok(None) => {}
                    Err(e) => tracing::error!("recording match failed: {e}"),
                }
            }
        }
    });
}

/// Serve on `listener` until the process ends.
pub async fn serve(listener: tokio::net::TcpListener, state: AppState) {
    spawn_ticker(state.lobby.clone());
    spawn_recorder(state.clone());
    axum::serve(listener, router(state)).await.expect("server");
}

/// A complete in-memory server state (fresh database, throwaway signer). For tests and local tools.
pub async fn test_state(min_players: usize) -> AppState {
    let db = db::connect("sqlite::memory:").await.expect("in-memory db");
    let signer = Arc::new(sign::ArenaSigner::new(
        "",
        84532,
        alloy_primitives::Address::repeat_byte(0x42),
    ));
    AppState {
        lobby: Arc::new(Mutex::new(Lobby::new(game_core::Map::yard, min_players))),
        db,
        signer,
        allowed_domains: vec![],
        contracts: serde_json::json!({}),
    }
}
