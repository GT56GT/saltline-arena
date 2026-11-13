//! Lag compensation: a shot is judged against where the target was when the shooter saw it,
//! but never further back than the 200 ms window.

use game_core::{Input, Map};
use glam::Vec3;
use protocol::ServerMsg;
use server::{Room, MAX_REWIND_TICKS};
use tokio::sync::mpsc;

fn room_with_two() -> (Room, u32, u32, mpsc::UnboundedReceiver<String>) {
    let mut room = Room::new(1, Map::yard());
    let (tx_a, rx_a) = mpsc::unbounded_channel();
    let (tx_b, _rx_b) = mpsc::unbounded_channel();
    std::mem::forget(_rx_b);
    let a = room.join("A".into(), tx_a).unwrap();
    let b = room.join("B".into(), tx_b).unwrap();
    room.teleport(a, Vec3::new(0.0, 0.0, 10.0), 0.0);
    room.teleport(b, Vec3::new(0.0, 0.0, 0.0), 0.0);
    (room, a, b, rx_a)
}

fn hits(rx: &mut mpsc::UnboundedReceiver<String>) -> usize {
    let mut n = 0;
    while let Ok(s) = rx.try_recv() {
        if let Ok(ServerMsg::Hit { .. }) = serde_json::from_str::<ServerMsg>(&s) {
            n += 1;
        }
    }
    n
}

/// B strafes right for `ticks` ticks while A holds still, recording the tick A "saw".
fn strafe(room: &mut Room, b: u32, ticks: u32, seq0: u32) {
    for i in 0..ticks {
        room.push_inputs(b, vec![Input { seq: seq0 + i, mx: 1.0, yaw: 0.0, ..Default::default() }]);
        room.step();
    }
}

#[test]
fn shot_at_where_target_was_seen_hits() {
    let (mut room, a, b, mut rx) = room_with_two();
    room.step();
    let seen = room.tick; // A sees B at x = 0 on this tick
    strafe(&mut room, b, 6, 1); // B moves ~0.6 m right (200 ms of lag)
    assert!(room.state_of(b).unwrap().pos.x > 0.4);
    let _ = hits(&mut rx);
    let pitch = ((1.0_f32 - game_core::EYE_HEIGHT) / 10.0).atan();
    room.push_inputs(a, vec![Input { seq: 1, yaw: 0.0, pitch, fire: true, view_tick: seen, ..Default::default() }]);
    room.step();
    assert_eq!(hits(&mut rx), 1, "aimed where B was 6 ticks ago: rewound hit counts");
}

#[test]
fn rewind_is_capped_at_200ms() {
    let (mut room, a, b, mut rx) = room_with_two();
    room.step();
    let seen = room.tick;
    strafe(&mut room, b, MAX_REWIND_TICKS + 10, 1); // far longer than the window, B moves ~2 m
    let _ = hits(&mut rx);
    let pitch = ((1.0_f32 - game_core::EYE_HEIGHT) / 10.0).atan();
    room.push_inputs(a, vec![Input { seq: 1, yaw: 0.0, pitch, fire: true, view_tick: seen, ..Default::default() }]);
    room.step();
    assert_eq!(hits(&mut rx), 0, "claiming a very old view tick cannot reach back past the window");
}
