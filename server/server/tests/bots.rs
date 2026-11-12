//! Bots fight each other through the normal rules, and the lobby keeps rooms topped up.

use game_core::{Map, TICK_HZ};
use server::{Lobby, Room};
use tokio::sync::mpsc;

#[test]
fn bots_find_and_kill_each_other() {
    let mut room = Room::new(1, Map::yard());
    for (i, skill) in [0.4, 0.6, 0.8, 0.5].iter().enumerate() {
        room.add_bot(format!("bot{i}"), *skill).unwrap();
    }
    for _ in 0..(90 * TICK_HZ) {
        room.step();
    }
    let kills: u32 = room.players.values().map(|p| p.kills).sum();
    let finished: u32 = room.finished.iter().flat_map(|m| m.players.iter().map(|p| p.3)).sum();
    assert!(kills + finished >= 3, "bots should score in 90 s, got {}", kills + finished);
    // Every bot is alive or waiting to respawn, nobody is stuck outside the map.
    for p in room.players.values() {
        assert!(p.state.pos.x.abs() <= 30.0 && p.state.pos.z.abs() <= 30.0);
    }
}

#[test]
fn lobby_tops_up_with_bots_and_makes_room_for_humans() {
    let mut lobby = Lobby::new(Map::yard, 4);
    let (tx1, _rx1) = mpsc::unbounded_channel();
    let (r1, _) = lobby.join("Atul".into(), Default::default(), tx1).unwrap();
    lobby.step();
    assert_eq!(lobby.rooms[&r1].players.len(), 4);
    assert_eq!(lobby.rooms[&r1].bots(), 3);
    let (tx2, _rx2) = mpsc::unbounded_channel();
    let (r2, _) = lobby.join("Clover".into(), Default::default(), tx2).unwrap();
    assert_eq!(r1, r2, "second human joins the same room");
    lobby.step();
    assert_eq!(lobby.rooms[&r1].humans(), 2);
    assert_eq!(lobby.rooms[&r1].bots(), 2, "a bot made way");
}

#[test]
fn ninth_human_gets_a_new_room_and_empty_rooms_close() {
    let mut lobby = Lobby::new(Map::yard, 4);
    let mut keep = vec![];
    let mut ids = vec![];
    for i in 0..9 {
        let (tx, rx) = mpsc::unbounded_channel();
        keep.push(rx);
        ids.push(lobby.join(format!("p{i}"), Default::default(), tx).unwrap());
        lobby.step();
    }
    assert_eq!(lobby.rooms.len(), 2);
    let (room, pid) = ids[8];
    lobby.leave(room, pid);
    assert_eq!(lobby.rooms.len(), 1, "room with no humans closes");
}

#[test]
fn announced_winner_matches_recorded_first_place_on_ties() {
    use protocol::ServerMsg;
    let mut room = Room::new(1, Map::yard());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let a = room.join("A".into(), tx).unwrap();
    let b = room.add_bot("B".into(), 0.5).unwrap();
    // Tie on kills; A has fewer deaths, so A must be announced and recorded first.
    room.players.get_mut(&a).unwrap().kills = 6;
    room.players.get_mut(&a).unwrap().deaths = 1;
    room.players.get_mut(&b).unwrap().kills = 6;
    room.players.get_mut(&b).unwrap().deaths = 4;
    room.force_end();
    room.step();
    let mut winner = None;
    while let Ok(s) = rx.try_recv() {
        if let Ok(ServerMsg::MatchEnd { winner: w, .. }) = serde_json::from_str::<ServerMsg>(&s) {
            winner = w;
        }
    }
    assert_eq!(winner, Some(a));
    let m = &room.finished[0];
    let places = server::records::placings(&m.players.iter().map(|p| (p.3, p.4)).collect::<Vec<_>>());
    let first = m.players[places.iter().position(|p| *p == 0).unwrap()].0;
    assert_eq!(first, a);
}

#[test]
fn bots_fight_on_the_harbour_map() {
    let mut room = Room::new(1, Map::harbour());
    for (i, skill) in [0.5, 0.7, 0.6, 0.8, 0.4, 0.6].iter().enumerate() {
        room.add_bot(format!("bot{i}"), *skill).unwrap();
    }
    let mut moved = 0.0;
    let mut last: Vec<_> = room.players.values().map(|p| p.state.pos).collect();
    for t in 0..(120 * TICK_HZ) {
        room.step();
        if t % TICK_HZ == 0 {
            let now: Vec<_> = room.players.values().map(|p| p.state.pos).collect();
            moved += now.iter().zip(&last).map(|(a, b)| a.distance(*b)).sum::<f32>();
            last = now;
        }
    }
    let kills: u32 = room.players.values().map(|p| p.kills).sum::<u32>() + room.finished.iter().flat_map(|m| m.players.iter().map(|p| p.3)).sum::<u32>();
    assert!(kills >= 5, "bots should fight in the harbour: {kills} kills in 2 min");
    assert!(moved > 300.0, "bots should roam, not stand stuck: {moved:.0} m total");
    for p in room.players.values() {
        assert!(p.state.pos.x >= -39.5 && p.state.pos.x <= 31.0, "out of bounds {:?}", p.state.pos);
    }
}
