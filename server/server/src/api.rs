//! REST API: sign-in, profile, leaderboard, match history, cosmetics, chain info.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::db::{self, Account, SEASON};
use crate::net::{clean_name, AppState};
use crate::{auth, cosmetics, records};

type ApiResult = Result<Json<Value>, Response>;

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}
fn internal(e: impl std::fmt::Display) -> Response {
    tracing::error!("api: {e}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong")
}

pub fn bearer(h: &HeaderMap) -> Option<String> {
    h.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

async fn require(s: &AppState, h: &HeaderMap) -> Result<Account, Response> {
    let token = bearer(h).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Sign in first"))?;
    db::account_by_token(&s.db, &token).await.map_err(internal)?.ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Session expired"))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/nonce", get(nonce))
        .route("/auth/verify", post(verify))
        .route("/auth/logout", post(logout))
        .route("/me", get(me))
        .route("/me/callsign", post(callsign))
        .route("/leaderboard", get(leaderboard))
        .route("/matches", get(matches))
        .route("/matches/{id}", get(match_detail))
        .route("/cosmetics", get(catalogue))
        .route("/cosmetics/claim", post(claim))
        .route("/cosmetics/equip", post(equip))
        .route("/chain", get(chain))
}

async fn nonce(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!({ "nonce": auth::issue_nonce(&s.db).await.map_err(internal)? })))
}

#[derive(Deserialize)]
struct VerifyBody {
    message: String,
    signature: String,
}

async fn verify(State(s): State<AppState>, Json(b): Json<VerifyBody>) -> ApiResult {
    let (account, token) = auth::verify(&s.db, &b.message, &b.signature, &s.allowed_domains).await.map_err(|e| err(StatusCode::UNAUTHORIZED, e))?;
    Ok(Json(json!({ "token": token, "account": account })))
}

async fn logout(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    if let Some(t) = bearer(&h) {
        auth::logout(&s.db, &t).await;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn me(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let a = require(&s, &h).await?;
    let stats = db::stat_line(&s.db, a.id).await.map_err(internal)?;
    let achievements: Vec<Value> = sqlx::query("SELECT code, awarded_at FROM achievements WHERE account_id = ? ORDER BY awarded_at")
        .bind(a.id)
        .fetch_all(&s.db)
        .await
        .map_err(internal)?
        .iter()
        .map(|r| {
            let code: String = r.get(0);
            let info = records::ACHIEVEMENTS.iter().find(|x| x.0 == code);
            json!({ "code": code, "id": info.map(|x| x.1), "title": info.map(|x| x.2), "awarded_at": r.get::<i64, _>(1),
                    "voucher": s.signer.sign_achievement(a.wallet.parse().unwrap_or_default(), info.map(|x| x.1).unwrap_or(0)) })
        })
        .collect();
    let recent = recent_for(&s, Some(a.id), 10).await?;
    Ok(Json(json!({ "account": a, "stats": stats, "achievements": achievements, "recent": recent, "season": SEASON })))
}

#[derive(Deserialize)]
struct CallsignBody {
    callsign: String,
}

async fn callsign(State(s): State<AppState>, h: HeaderMap, Json(b): Json<CallsignBody>) -> ApiResult {
    let a = require(&s, &h).await?;
    let c = clean_name(&b.callsign);
    if c.chars().count() < 3 {
        return Err(err(StatusCode::BAD_REQUEST, "Callsigns need at least 3 letters or digits"));
    }
    db::set_callsign(&s.db, a.id, &c).await.map_err(|e| err(StatusCode::CONFLICT, e))?;
    Ok(Json(json!({ "callsign": c })))
}

async fn leaderboard(State(s): State<AppState>) -> ApiResult {
    let rows = sqlx::query(
        "SELECT a.id, a.wallet, a.callsign, a.cosmetic, r.rating, r.rd, r.matches, r.wins, r.kills, r.deaths
         FROM ratings r JOIN accounts a ON a.id = r.account_id
         WHERE r.season = ? AND a.banned = 0 AND r.matches > 0 ORDER BY r.rating DESC LIMIT 50",
    )
    .bind(SEASON)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let list: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({ "rank": i + 1, "id": r.get::<i64,_>(0), "wallet": r.get::<String,_>(1), "callsign": r.get::<Option<String>,_>(2),
                    "cosmetic": r.get::<Option<String>,_>(3), "rating": r.get::<f64,_>(4).round(), "rd": r.get::<f64,_>(5).round(),
                    "matches": r.get::<i64,_>(6), "wins": r.get::<i64,_>(7), "kills": r.get::<i64,_>(8), "deaths": r.get::<i64,_>(9) })
        })
        .collect();
    Ok(Json(json!({ "season": SEASON, "players": list })))
}

async fn recent_for(s: &AppState, account: Option<i64>, limit: i64) -> Result<Vec<Value>, Response> {
    let rows = match account {
        Some(acc) => sqlx::query(
            "SELECT m.id, m.ended_at, m.duration_s, mp.kills, mp.deaths, mp.placing, mp.rating_before, mp.rating_after,
                    (SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS n
             FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.account_id = ? ORDER BY m.ended_at DESC LIMIT ?",
        )
        .bind(acc)
        .bind(limit)
        .fetch_all(&s.db)
        .await,
        None => sqlx::query(
            "SELECT m.id, m.ended_at, m.duration_s, NULL, NULL, NULL, NULL, NULL,
                    (SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS n
             FROM matches m ORDER BY m.ended_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&s.db)
        .await,
    }
    .map_err(internal)?;
    Ok(rows
        .iter()
        .map(|r| {
            let before: Option<f64> = r.get(6);
            let after: Option<f64> = r.get(7);
            json!({ "id": r.get::<String,_>(0), "ended_at": r.get::<i64,_>(1), "duration_s": r.get::<i64,_>(2),
                    "kills": r.get::<Option<i64>,_>(3), "deaths": r.get::<Option<i64>,_>(4), "placing": r.get::<Option<i64>,_>(5),
                    "rating_delta": before.zip(after).map(|(b, a)| (a - b).round()), "players": r.get::<i64,_>(8) })
        })
        .collect())
}

#[derive(Deserialize)]
struct MatchesQuery {
    limit: Option<i64>,
}

async fn matches(State(s): State<AppState>, Query(q): Query<MatchesQuery>) -> ApiResult {
    Ok(Json(json!({ "matches": recent_for(&s, None, q.limit.unwrap_or(20).clamp(1, 100)).await? })))
}

async fn match_detail(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let m = sqlx::query("SELECT * FROM matches WHERE id = ?").bind(&id).fetch_optional(&s.db).await.map_err(internal)?;
    let Some(m) = m else { return Err(err(StatusCode::NOT_FOUND, "No such match")) };
    let players: Vec<Value> = sqlx::query("SELECT * FROM match_players WHERE match_id = ? ORDER BY placing, slot")
        .bind(&id)
        .fetch_all(&s.db)
        .await
        .map_err(internal)?
        .iter()
        .map(|r| {
            json!({ "name": r.get::<String,_>("name"), "wallet": r.get::<Option<String>,_>("wallet"), "bot": r.get::<i64,_>("is_bot") != 0,
                    "kills": r.get::<i64,_>("kills"), "deaths": r.get::<i64,_>("deaths"), "headshots": r.get::<i64,_>("headshots"),
                    "placing": r.get::<i64,_>("placing"), "rating_before": r.get::<Option<f64>,_>("rating_before"), "rating_after": r.get::<Option<f64>,_>("rating_after") })
        })
        .collect();
    Ok(Json(json!({
        "id": id, "ended_at": m.get::<i64,_>("ended_at"), "duration_s": m.get::<i64,_>("duration_s"),
        "results_hash": m.get::<String,_>("results_hash"), "signature": m.get::<String,_>("signature"),
        "settled_tx": m.get::<Option<String>,_>("settled_tx"), "signer": format!("{:#x}", s.signer.address()), "players": players,
    })))
}

async fn catalogue(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let acc = match bearer(&h) {
        Some(t) => db::account_by_token(&s.db, &t).await.map_err(internal)?,
        None => None,
    };
    let owned = match &acc {
        Some(a) => cosmetics::owned(&s.db, a.id).await.map_err(internal)?,
        None => vec![],
    };
    let mut items = vec![];
    for it in &cosmetics::CATALOGUE {
        let eligible = match &acc {
            Some(a) => cosmetics::eligible(&s.db, a.id, it).await.map_err(internal)?,
            None => false,
        };
        items.push(json!({ "id": it.id, "token_id": it.token_id, "name": it.name, "slot": it.slot, "color": it.color, "how": it.how,
                           "owned": owned.iter().any(|o| o == it.id), "eligible": eligible }));
    }
    Ok(Json(json!({ "items": items, "equipped": acc.and_then(|a| a.cosmetic) })))
}

#[derive(Deserialize)]
struct ItemBody {
    item: Option<String>,
}

async fn claim(State(s): State<AppState>, h: HeaderMap, Json(b): Json<ItemBody>) -> ApiResult {
    let a = require(&s, &h).await?;
    let it = b.item.as_deref().and_then(cosmetics::item).ok_or_else(|| err(StatusCode::NOT_FOUND, "No such item"))?;
    if !cosmetics::eligible(&s.db, a.id, it).await.map_err(internal)? {
        return Err(err(StatusCode::FORBIDDEN, format!("Not unlocked yet: {}", it.how)));
    }
    cosmetics::record_claim(&s.db, a.id, it.id).await.map_err(internal)?;
    // A signed voucher lets the player mint the NFT themselves; the server never holds it.
    let voucher = s.signer.sign_cosmetic(a.wallet.parse().unwrap_or_default(), it.token_id);
    Ok(Json(json!({ "item": it.id, "token_id": it.token_id, "to": a.wallet, "voucher": voucher })))
}

async fn equip(State(s): State<AppState>, h: HeaderMap, Json(b): Json<ItemBody>) -> ApiResult {
    let a = require(&s, &h).await?;
    if let Some(id) = &b.item {
        let owned = cosmetics::owned(&s.db, a.id).await.map_err(internal)?;
        if !owned.iter().any(|o| o == id) {
            return Err(err(StatusCode::FORBIDDEN, "Claim it first"));
        }
    }
    sqlx::query("UPDATE accounts SET cosmetic = ? WHERE id = ?").bind(&b.item).bind(a.id).execute(&s.db).await.map_err(internal)?;
    Ok(Json(json!({ "equipped": b.item })))
}

async fn chain(State(s): State<AppState>) -> ApiResult {
    Ok(Json(json!({
        "chain_id": s.signer.chain_id, "signer": format!("{:#x}", s.signer.address()),
        "contracts": s.contracts, "season": SEASON,
    })))
}
