//! Wallet sign-in, sessions, match recording, Glicko-2 ratings, achievements, cosmetics and
//! EIP-712 result signatures, through the real HTTP router.

use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use server::room::{Identity, MatchSummary};
use server::{records, router, test_state, AppState};
use tower::ServiceExt;

async fn call(state: &AppState, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let req = req.body(body.map(|b| Body::from(b.to_string())).unwrap_or_else(Body::empty)).unwrap();
    let res = router(state.clone()).oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn siwe(addr: &str, nonce: &str) -> String {
    format!("saltline.example wants you to sign in with your Ethereum account:\n{addr}\n\nSign in to Saltline Arena.\n\nURI: https://saltline.example\nVersion: 1\nChain ID: 84532\nNonce: {nonce}\nIssued At: 2026-11-13T00:00:00Z")
}

async fn sign_in(state: &AppState, key: &PrivateKeySigner) -> String {
    let (_, n) = call(state, "GET", "/auth/nonce", None, None).await;
    let msg = siwe(&key.address().to_checksum(None), n["nonce"].as_str().unwrap());
    let sig = key.sign_message_sync(msg.as_bytes()).unwrap();
    let (st, v) = call(state, "POST", "/auth/verify", None, Some(json!({ "message": msg, "signature": format!("0x{}", hex::encode(sig.as_bytes())) }))).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    v["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn wallet_sign_in_and_replay_protection() {
    let state = test_state(0).await;
    let key = PrivateKeySigner::random();
    let token = sign_in(&state, &key).await;
    let (st, me) = call(&state, "GET", "/me", Some(&token), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(me["account"]["wallet"], format!("{:#x}", key.address()));
    assert_eq!(me["stats"]["rating"], 1500);

    // Replaying the same signed message fails: its nonce is spent.
    let (_, n) = call(&state, "GET", "/auth/nonce", None, None).await;
    let msg = siwe(&key.address().to_checksum(None), n["nonce"].as_str().unwrap());
    let sig = format!("0x{}", hex::encode(key.sign_message_sync(msg.as_bytes()).unwrap().as_bytes()));
    let body = json!({ "message": msg, "signature": sig });
    assert_eq!(call(&state, "POST", "/auth/verify", None, Some(body.clone())).await.0, StatusCode::OK);
    assert_eq!(call(&state, "POST", "/auth/verify", None, Some(body)).await.0, StatusCode::UNAUTHORIZED);

    // Someone else's signature over my address is rejected.
    let other = PrivateKeySigner::random();
    let (_, n) = call(&state, "GET", "/auth/nonce", None, None).await;
    let msg = siwe(&key.address().to_checksum(None), n["nonce"].as_str().unwrap());
    let forged = format!("0x{}", hex::encode(other.sign_message_sync(msg.as_bytes()).unwrap().as_bytes()));
    assert_eq!(call(&state, "POST", "/auth/verify", None, Some(json!({ "message": msg, "signature": forged }))).await.0, StatusCode::UNAUTHORIZED);

    // No token, no profile.
    assert_eq!(call(&state, "GET", "/me", None, None).await.0, StatusCode::UNAUTHORIZED);
    // Callsigns: set, then unique.
    assert_eq!(call(&state, "POST", "/me/callsign", Some(&token), Some(json!({ "callsign": "clover" }))).await.0, StatusCode::OK);
    let t2 = sign_in(&state, &other).await;
    assert_eq!(call(&state, "POST", "/me/callsign", Some(&t2), Some(json!({ "callsign": "clover" }))).await.0, StatusCode::CONFLICT);
}

#[tokio::test]
async fn matches_update_ratings_award_badges_and_are_signed() {
    let state = test_state(0).await;
    let (ka, kb) = (PrivateKeySigner::random(), PrivateKeySigner::random());
    let (ta, tb) = (sign_in(&state, &ka).await, sign_in(&state, &kb).await);
    let acc = |t: &str| {
        let s = state.clone();
        let t = t.to_string();
        async move { server::db::account_by_token(&s.db, &t).await.unwrap().unwrap() }
    };
    let (a, b) = (acc(&ta).await, acc(&tb).await);
    let ident = |x: &server::db::Account| Identity { account: Some(x.id), wallet: Some(x.wallet.clone()), cosmetic: None };
    let summary = MatchSummary {
        room: 1,
        started_tick: 0,
        ended_tick: 30 * 240,
        players: vec![
            (1, "A".into(), ident(&a), 12, 3, 6, 6, false),
            (2, "B".into(), ident(&b), 3, 12, 0, 1, false),
            (3, "Gull-07".into(), Identity::default(), 5, 5, 1, 2, true),
            (4, "guest".into(), Identity::default(), 1, 1, 0, 1, false),
        ],
    };
    let rec = records::save(&state.db, &state.signer, &summary).await.unwrap().unwrap();
    assert_eq!(rec.deltas.len(), 2);
    assert!(rec.deltas.iter().find(|d| d.0 == 1).unwrap().1 > 0, "winner gains");
    assert!(rec.deltas.iter().find(|d| d.0 == 2).unwrap().1 < 0, "last place loses");

    let (_, me) = call(&state, "GET", "/me", Some(&ta), None).await;
    assert!(me["stats"]["rating"].as_f64().unwrap() > 1500.0);
    let codes: Vec<&str> = me["achievements"].as_array().unwrap().iter().map(|x| x["code"].as_str().unwrap()).collect();
    for c in ["first-blood", "double-digits", "sharpshooter", "streak-5", "victor"] {
        assert!(codes.contains(&c), "missing {c} in {codes:?}");
    }

    // Leaderboard: A above B.
    let (_, lb) = call(&state, "GET", "/leaderboard", None, None).await;
    assert_eq!(lb["players"][0]["wallet"], a.wallet);
    assert_eq!(lb["players"][1]["wallet"], b.wallet);

    // The match result is signed by the server key (EIP-712), and anyone can check it.
    let (_, m) = call(&state, "GET", &format!("/matches/{}", rec.match_id), None, None).await;
    let id = records::parse_b256(m["id"].as_str().unwrap()).unwrap();
    let hash = records::parse_b256(m["results_hash"].as_str().unwrap()).unwrap();
    let who = state.signer.recover_match(id, m["ended_at"].as_u64().unwrap(), hash, m["signature"].as_str().unwrap()).unwrap();
    assert_eq!(who, state.signer.address());
    assert_eq!(m["players"].as_array().unwrap().len(), 4);

    // Cosmetics: founders visor is claimable by anyone signed in; chrome needs 1600 (A passed it after
    // a dominant first match, B did not); equipping needs ownership.
    assert_eq!(call(&state, "POST", "/cosmetics/equip", Some(&ta), Some(json!({ "item": "founders-visor" }))).await.0, StatusCode::FORBIDDEN);
    let (st, c) = call(&state, "POST", "/cosmetics/claim", Some(&ta), Some(json!({ "item": "founders-visor" }))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(c["voucher"].as_str().unwrap().len(), 132, "{c}");
    assert_eq!(call(&state, "POST", "/cosmetics/claim", Some(&tb), Some(json!({ "item": "chrome-visor" }))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&state, "POST", "/cosmetics/equip", Some(&ta), Some(json!({ "item": "founders-visor" }))).await.0, StatusCode::OK);
    let (_, cat) = call(&state, "GET", "/cosmetics", Some(&ta), None).await;
    assert_eq!(cat["equipped"], "founders-visor");
}
