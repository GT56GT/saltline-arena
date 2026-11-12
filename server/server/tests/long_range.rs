use game_core::{Input, Map};
use glam::Vec3;
use protocol::ServerMsg;
use server::Room;
use tokio::sync::mpsc;

#[test]
fn diagonal_long_shot_hits() {
    let mut room = Room::new(1, Map::yard());
    let (ta, mut ra) = mpsc::unbounded_channel();
    let (tb, rb) = mpsc::unbounded_channel();
    std::mem::forget(rb);
    let a = room.join("A".into(), ta).unwrap();
    let b = room.join("B".into(), tb).unwrap();
    room.teleport(a, Vec3::new(-24.0, 0.0, 24.0), 0.0);
    room.teleport(b, Vec3::new(24.0, 0.0, -24.0), 0.0);
    room.step();
    let (dx, dz, dy) = (48.0f32, -48.0f32, 1.0f32 - 1.6);
    let yaw = (-dx).atan2(-dz);
    let pitch = dy.atan2((dx * dx + dz * dz).sqrt());
    for seq in 1..=12 {
        room.push_inputs(a, vec![Input { seq, yaw, pitch, fire: true, view_tick: room.tick, ..Default::default() }]);
        room.step();
    }
    let mut hits = 0; let mut shots = vec![];
    while let Ok(s) = ra.try_recv() {
        match serde_json::from_str::<ServerMsg>(&s) { Ok(ServerMsg::Hit { .. }) => hits += 1, Ok(ServerMsg::Shot { to, .. }) => shots.push(to), _ => {} }
    }
    println!("yaw {yaw} pitch {pitch} hits {hits} shots {:?}", &shots[..shots.len().min(2)]);
    println!("A {:?}", room.state_of(a).unwrap().pos);
    assert!(hits >= 3);
}
