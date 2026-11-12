//! Phase-1 gate: two players fight a full exchange over real WebSockets with no
//! client-trusted state, and a tampered client cannot score, teleport or speed up.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use glam::Vec3;
use protocol::ServerMsg;
use serde_json::{json, Value};
use server::{router, spawn_ticker, test_state, SharedLobby};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start() -> (SharedLobby, String) {
    // No bots in these tests: only the players we control.
    let state = test_state(0).await;
    let room: SharedLobby = state.lobby.clone();
    spawn_ticker(room.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(state);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (room, format!("ws://{addr}/ws"))
}

async fn join(url: &str, name: &str) -> (Ws, u32) {
    let (mut ws, _) = connect_async(url).await.unwrap();
    ws.send(Message::Text(json!({"t":"hello","name":name}).to_string().into())).await.unwrap();
    loop {
        let m = next_msg(&mut ws).await;
        if let ServerMsg::Welcome { id, .. } = m {
            return (ws, id);
        }
    }
}

async fn next_msg(ws: &mut Ws) -> ServerMsg {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timeout").unwrap().unwrap();
        if let Message::Text(t) = m {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}

/// Drain everything currently buffered, returning it.
async fn drain(ws: &mut Ws) -> Vec<ServerMsg> {
    let mut out = vec![];
    while let Ok(Some(Ok(Message::Text(t)))) = tokio::time::timeout(Duration::from_millis(5), ws.next()).await {
        out.push(serde_json::from_str(t.as_str()).unwrap());
    }
    out
}

async fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn fair_fight_ends_in_a_server_decided_kill() {
    let (room, url) = start().await;
    let (mut a, ida) = join(&url, "Atul").await;
    let (mut b, idb) = join(&url, "Clover").await;
    {
        let mut g = room.lock().unwrap();
        let r = g.room_mut(1).unwrap();
        r.teleport(ida, Vec3::new(0.0, 0.0, 10.0), 0.0); // looking toward -Z
        r.teleport(idb, Vec3::new(0.0, 0.0, 0.0), std::f32::consts::PI);
    }
    // Aim at B's chest: eye height 1.6 -> chest 1.0 over 10 m.
    let pitch = ((1.0_f32 - 1.6) / 10.0).atan();
    let mut seq = 0u32;
    let mut view_tick = 0u32;
    let mut killed = None;
    let mut hits = 0;
    for _ in 0..90 {
        seq += 1;
        send(&mut a, json!({"t":"input","inputs":[{"seq":seq,"mx":0,"mz":0,"yaw":0.0,"pitch":pitch,"fire":true,"view_tick":view_tick}]})).await;
        tokio::time::sleep(Duration::from_millis(33)).await;
        for m in drain(&mut a).await {
            match m {
                ServerMsg::Snapshot { tick, .. } => view_tick = tick,
                ServerMsg::Hit { shooter, target, .. } if shooter == ida && target == idb => hits += 1,
                ServerMsg::Kill { killer, victim, .. } => killed = Some((killer, victim)),
                _ => {}
            }
        }
        if killed.is_some() {
            break;
        }
    }
    assert_eq!(killed, Some((ida, idb)), "A should kill B");
    assert_eq!(hits, 4, "4 body shots x 25 damage = 100");
    // B's client heard about it too, from the server.
    let b_msgs = drain(&mut b).await;
    assert!(b_msgs.iter().any(|m| matches!(m, ServerMsg::Kill { killer, victim, .. } if *killer == ida && *victim == idb)));
}

#[tokio::test(flavor = "multi_thread")]
async fn tampered_client_cannot_claim_kills_hits_or_positions() {
    let (room, url) = start().await;
    let (mut cheat, idc) = join(&url, "Cheater").await;
    let (_victim_ws, idv) = join(&url, "Victim").await;
    room.lock().unwrap().room_mut(1).unwrap().teleport(idc, Vec3::new(20.0, 0.0, 0.0), 0.0);
    let before = room.lock().unwrap().room_mut(1).unwrap().state_of(idc).unwrap().pos;

    // Messages a hacked client might try. None of them exist in the protocol.
    send(&mut cheat, json!({"t":"kill","killer":idc,"victim":idv})).await;
    send(&mut cheat, json!({"t":"hit","shooter":idc,"target":idv,"damage":999})).await;
    send(&mut cheat, json!({"t":"set_health","id":idv,"hp":0})).await;
    // Extra fields claiming a position are ignored; only the intent fields are read.
    send(&mut cheat, json!({"t":"input","inputs":[{"seq":1,"mx":0,"mz":0,"yaw":0,"pitch":0,"pos":[0,0,0],"hp":1000}]})).await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    let msgs = drain(&mut cheat).await;
    let errors = msgs.iter().filter(|m| matches!(m, ServerMsg::Error { .. })).count();
    assert_eq!(errors, 3, "each forged message is rejected");
    assert!(!msgs.iter().any(|m| matches!(m, ServerMsg::Kill { .. } | ServerMsg::Hit { .. })));
    let mut g = room.lock().unwrap();
    let r = g.room_mut(1).unwrap();
    assert_eq!(r.state_of(idv).unwrap().health, 100.0, "victim untouched");
    let after = r.state_of(idc).unwrap();
    assert!(after.pos.distance(before) < 0.01, "no teleport: {:?} -> {:?}", before, after.pos);
    assert_eq!(after.health, 100.0, "no self-heal beyond max");
}

#[tokio::test(flavor = "multi_thread")]
async fn speed_hacks_and_input_floods_gain_nothing() {
    let (room, url) = start().await;
    let (mut cheat, idc) = join(&url, "Speedy").await;
    let (mut fair, idf) = join(&url, "Fair").await;
    {
        let mut g = room.lock().unwrap();
        let r = g.room_mut(1).unwrap();
        r.teleport(idc, Vec3::new(-25.0, 0.0, 25.0), 0.0);
        r.teleport(idf, Vec3::new(25.0, 0.0, 25.0), 0.0);
    }
    let c0 = room.lock().unwrap().room_mut(1).unwrap().state_of(idc).unwrap().pos;
    let f0 = room.lock().unwrap().room_mut(1).unwrap().state_of(idf).unwrap().pos;
    let started = std::time::Instant::now();

    // Cheater: 200 inputs per message with a huge movement vector, every tick.
    // Fair player: one normal input per tick.
    let mut cseq = 0u32;
    for i in 0..30u32 {
        let flood: Vec<Value> = (0..200)
            .map(|_| {
                cseq += 1;
                json!({"seq":cseq,"mx":0,"mz":100.0,"yaw":0,"pitch":0,"sprint":true})
            })
            .collect();
        send(&mut cheat, json!({"t":"input","inputs":flood})).await;
        send(&mut fair, json!({"t":"input","inputs":[{"seq":i + 1,"mx":0,"mz":1,"yaw":0,"pitch":0,"sprint":true}]})).await;
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (c1, f1) = {
        let mut g = room.lock().unwrap();
    let r = g.room_mut(1).unwrap();
        (r.state_of(idc).unwrap().pos, r.state_of(idf).unwrap().pos)
    };
    let cheat_dist = (c1 - c0).length();
    let fair_dist = (f1 - f0).length();
    // One input per tick, clamped: the cheater moves no faster than an honest sprinter.
    assert!(cheat_dist <= fair_dist + 0.6, "cheater {cheat_dist:.2} m vs fair {fair_dist:.2} m");
    let max_legal = game_core::SPRINT_SPEED * started.elapsed().as_secs_f32() + 0.5;
    assert!(cheat_dist <= max_legal, "cheater moved {cheat_dist:.2} m, sprint limit {max_legal:.2} m");
}
