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
