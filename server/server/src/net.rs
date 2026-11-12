//! HTTP + WebSocket endpoints.

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientMsg, ServerMsg};
use serde_json::json;
use tokio::sync::mpsc;

use crate::room::Identity;
use crate::sign::ArenaSigner;
use crate::{db, SharedLobby};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

const MAX_BAD_MESSAGES: u32 = 20;

#[derive(Clone)]
pub struct AppState {
    pub lobby: SharedLobby,
    pub db: sqlx::SqlitePool,
    pub signer: Arc<ArenaSigner>,
    /// Domains accepted in Sign-In With Ethereum messages (empty = any, for development).
    pub allowed_domains: Vec<String>,
    /// Deployed contract addresses, as published by /chain.
    pub contracts: serde_json::Value,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "saltline arena ok" }))
        .route("/stats", get(stats))
        .route("/ws", get(ws_upgrade))
        .merge(crate::api::routes())
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .with_state(state)
}

async fn stats(State(s): State<AppState>) -> impl IntoResponse {
    let (rooms, humans, bots) = s.lobby.lock().unwrap().stats();
    Json(json!({ "rooms": rooms, "players": humans, "bots": bots }))
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.max_message_size(16 * 1024).on_upgrade(move |socket| client(socket, state))
}

pub fn clean_name(raw: &str) -> String {
    let s: String = raw.chars().filter(|c| c.is_alphanumeric() || " _.-".contains(*c)).take(16).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "Breacher".into() } else { s }
}

async fn client(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();

    // The first message must be a Hello, within 5 seconds.
    let hello = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
    let (mut name, token) = match hello {
        Ok(Some(Ok(Message::Text(t)))) => match ClientMsg::parse(t.as_str()) {
            Some(ClientMsg::Hello { name, token }) => (clean_name(&name), token),
            _ => return,
        },
        _ => return,
    };
    // Signed-in players play under their account (callsign, rating, cosmetic); others are guests.
    let mut ident = Identity::default();
    if let Some(t) = token {
        if let Ok(Some(a)) = db::account_by_token(&state.db, &t).await {
            if a.banned {
                let _ = sink.send(Message::Text(ServerMsg::Error { msg: "account suspended".into() }.to_json().into())).await;
                return;
            }
            if let Some(c) = &a.callsign {
                name = c.clone();
            }
            ident = Identity { account: Some(a.id), wallet: Some(a.wallet.clone()), cosmetic: a.cosmetic.clone() };
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let joined = state.lobby.lock().unwrap().join(name, ident, tx.clone());
    let (room_id, id) = match joined {
        Ok(v) => v,
        Err(e) => {
            let _ = sink.send(Message::Text(ServerMsg::Error { msg: e }.to_json().into())).await;
            return;
        }
    };

    let writer = tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if sink.send(Message::Text(s.into())).await.is_err() {
                break;
            }
        }
    });

    let mut bad = 0u32;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        match ClientMsg::parse(text.as_str()) {
            Some(ClientMsg::Input { inputs }) => state.lobby.lock().unwrap().push_inputs(room_id, id, inputs),
            Some(ClientMsg::Ping { c }) => {
                let _ = tx.send(ServerMsg::Pong { c }.to_json());
            }
            Some(ClientMsg::Hello { .. }) | None => {
                bad += 1;
                let _ = tx.send(ServerMsg::Error { msg: "unexpected message".into() }.to_json());
                if bad > MAX_BAD_MESSAGES {
                    break;
                }
            }
        }
    }
    state.lobby.lock().unwrap().leave(room_id, id);
    writer.abort();
}
