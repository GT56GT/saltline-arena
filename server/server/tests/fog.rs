//! Fog of war: opponents are only sent to players who can see or hear them.

use game_core::{Aabb, Input, Map};
use glam::Vec3;
use protocol::{PlayerSnap, RoomConfig, ServerMsg};
use server::Room;
use tokio::sync::mpsc;

type Rx = mpsc::UnboundedReceiver<String>;

/// Open ground with one long, tall wall along x = 0.
fn walled() -> Map {
    let mut m = Map::yard();
    m.boxes = vec![Aabb::new(
        Vec3::new(-0.5, 0.0, -25.0),
        Vec3::new(0.5, 4.0, 25.0),
    )];
    m
}

fn join(r: &mut Room, name: &str) -> (u32, Rx) {
    let (tx, rx) = mpsc::unbounded_channel();
    let id = r.join(name.into(), tx).unwrap();
    (id, rx)
}

fn drain(rx: &mut Rx) -> Vec<ServerMsg> {
    let mut v = Vec::new();
    while let Ok(s) = rx.try_recv() {
        if let Ok(m) = serde_json::from_str::<ServerMsg>(&s) {
            v.push(m);
        }
    }
    v
}

/// Everyone in the last snapshot this player got.
fn last(rx: &mut Rx) -> Vec<PlayerSnap> {
    drain(rx)
        .into_iter()
        .rev()
        .find_map(|m| if let ServerMsg::Snapshot { players, .. } = m { Some(players) } else { None })
        .expect("a snapshot")
}

fn of(v: &[PlayerSnap], id: u32) -> PlayerSnap {
    v.iter().find(|p| p.id == id).cloned().expect("that player")
}

/// What the last snapshot told this player about `id`.
fn view(rx: &mut Rx, id: u32) -> PlayerSnap {
    drain(rx)
        .into_iter()
        .rev()
        .find_map(|m| {
            if let ServerMsg::Snapshot { players, .. } = m {
                players.into_iter().find(|p| p.id == id)
            } else {
                None
            }
        })
        .expect("a snapshot with that player")
}

fn shots(rx: &mut Rx) -> usize {
    drain(rx)
        .iter()
        .filter(|m| matches!(m, ServerMsg::Shot { .. }))
        .count()
}

/// Run `n` ticks with `id` holding this input.
fn hold(r: &mut Room, id: u32, n: u32, inp: Input) {
    for _ in 0..n {
        let seq = r.tick + 10_000;
        r.push_inputs(id, vec![Input { seq, ..inp }]);
        r.step();
    }
}

fn idle(r: &mut Room, n: u32) {
    for _ in 0..n {
        r.step();
    }
}

/// A at (-5, 0, 0) and B at (5, 0, 0), the wall between them: 10 m apart.
fn behind_wall() -> (Room, u32, u32, Rx, Rx) {
    let mut r = Room::new(1, walled());
    let (a, ra) = join(&mut r, "A");
    let (b, rb) = join(&mut r, "B");
    r.teleport(a, Vec3::new(-5.0, 0.0, 0.0), -std::f32::consts::FRAC_PI_2);
    r.teleport(b, Vec3::new(5.0, 0.0, 0.0), std::f32::consts::FRAC_PI_2);
    idle(&mut r, 40); // past the one-second hold from spawning
    (r, a, b, ra, rb)
}

#[test]
fn still_player_behind_a_wall_is_hidden() {
    let (_r, a, b, mut ra, mut rb) = behind_wall();
    let snap = last(&mut ra);
    let seen = of(&snap, b);
    assert!(seen.hidden, "A must not get B's position");
    assert_eq!(seen.pos, [0.0; 3]);
    assert_eq!(
        (seen.name.as_str(), seen.kills, seen.deaths),
        ("B", 0, 0),
        "scoreboard fields still arrive"
    );
    assert!(view(&mut rb, a).hidden, "and the other way round");
    assert!(!of(&snap, a).hidden, "you always get yourself");
}

#[test]
fn walking_within_earshot_reveals() {
    let (mut r, _a, b, mut ra, _rb) = behind_wall();
    // walk along the wall (still behind it), 10 m from A: walking carries 18 m
    hold(
        &mut r,
        b,
        3,
        Input {
            mz: 1.0,
            ..Default::default()
        },
    );
    let seen = view(&mut ra, b);
    assert!(!seen.hidden, "walking 10 m away is audible");
    assert!(
        (seen.pos[0] - 5.0).abs() < 0.01,
        "real position sent: {:?}",
        seen.pos
    );
}

#[test]
fn crouch_walking_stays_hidden() {
    let (mut r, _a, b, mut ra, _rb) = behind_wall();
    hold(
        &mut r,
        b,
        20,
        Input {
            mz: 1.0,
            crouch: true,
            ..Default::default()
        },
    );
    assert!(
        view(&mut ra, b).hidden,
        "crouch-walking is heard only within 5 m (+3 m margin)"
    );
}

#[test]
fn stays_known_for_a_second_then_hides_again() {
    let (mut r, _a, b, mut ra, _rb) = behind_wall();
    hold(
        &mut r,
        b,
        3,
        Input {
            mz: 1.0,
            ..Default::default()
        },
    );
    hold(&mut r, b, 10, Input::default()); // stops; the server still has a little glide to brake
    assert!(
        !view(&mut ra, b).hidden,
        "held for a moment after the last sound"
    );
    idle(&mut r, 40);
    assert!(view(&mut ra, b).hidden, "hidden again once silent");
}

#[test]
fn shooting_reveals_the_shooter_and_their_shots() {
    let (mut r, a, b, mut ra, mut rb) = behind_wall();
    drain(&mut ra);
    drain(&mut rb);
    hold(
        &mut r,
        b,
        1,
        Input {
            fire: true,
            yaw: std::f32::consts::FRAC_PI_2,
            ..Default::default()
        },
    );
    let msgs = drain(&mut ra);
    assert_eq!(
        msgs.iter()
            .filter(|m| matches!(m, ServerMsg::Shot { .. }))
            .count(),
        1,
        "A hears the shot"
    );
    let seen = msgs
        .into_iter()
        .rev()
        .find_map(|m| {
            if let ServerMsg::Snapshot { players, .. } = m {
                players.into_iter().find(|p| p.id == b)
            } else {
                None
            }
        })
        .unwrap();
    assert!(!seen.hidden, "and learns where it came from");
    assert_eq!(shots(&mut rb), 1, "the shooter gets their own shot");
    let _ = a;
}

#[test]
fn open_ground_is_visible() {
    let mut r = Room::new(1, walled());
    let (_a, mut ra) = join(&mut r, "A");
    let (b, _rb) = join(&mut r, "B");
    r.teleport(_a, Vec3::new(-20.0, 0.0, 0.0), 0.0);
    r.teleport(b, Vec3::new(-20.0, 0.0, -40.0), 0.0); // 40 m away, nothing between, standing still
    idle(&mut r, 40);
    assert!(!view(&mut ra, b).hidden, "line of sight");
}

#[test]
fn peeking_out_is_sent_before_it_is_on_screen() {
    // B sprints out from behind the wall's end (z = 25): A gets B a quarter-second early.
    let mut r = Room::new(1, walled());
    let (a, mut ra) = join(&mut r, "A");
    let (b, _rb) = join(&mut r, "B");
    r.teleport(a, Vec3::new(-40.0, 0.0, 0.0), 0.0);
    r.teleport(b, Vec3::new(3.0, 0.0, 22.0), std::f32::consts::PI); // facing +z
    idle(&mut r, 40);
    assert!(
        view(&mut ra, b).hidden,
        "hidden behind the wall, 43 m away and still"
    );
    // sprint toward +z until the server lets A see B, and check B was still behind the wall then
    let mut revealed_at = None;
    for i in 0..60 {
        hold(
            &mut r,
            b,
            1,
            Input {
                mz: 1.0,
                sprint: true,
                yaw: std::f32::consts::PI,
                ..Default::default()
            },
        );
        if !view(&mut ra, b).hidden {
            revealed_at = Some((i, r.state_of(b).unwrap().pos));
            break;
        }
    }
    let (_, pos) = revealed_at.expect("B becomes visible");
    // the true line from A's eye to B's chest is still blocked at that moment
    let grid = server::sight::SightGrid::new(&walled());
    let eye = r.state_of(a).unwrap().eye();
    assert!(
        grid.blocked(eye, pos + Vec3::Y * 1.1),
        "sent while B's chest was still behind the wall: {pos:?}"
    );
}

#[test]
fn teammates_always_see_each_other() {
    let mut r = Room::new_custom(
        1,
        walled(),
        "ABCD".into(),
        RoomConfig {
            teams: true,
            ..Default::default()
        },
    );
    let (a, mut ra) = join(&mut r, "A"); // team 0
    let (_x, _rx) = join(&mut r, "X"); // team 1
    let (c, _rc) = join(&mut r, "C"); // team 0
    r.teleport(a, Vec3::new(-5.0, 0.0, 0.0), 0.0);
    r.teleport(c, Vec3::new(5.0, 0.0, 0.0), 0.0);
    r.teleport(_x, Vec3::new(5.0, 0.0, 10.0), 0.0);
    idle(&mut r, 40);
    let snap = last(&mut ra);
    assert!(!of(&snap, c).hidden, "teammate behind a wall");
    assert!(of(&snap, _x).hidden, "opponent behind the same wall");
}

#[test]
fn fog_can_be_switched_off() {
    let (mut r, _a, b, mut ra, _rb) = behind_wall();
    r.fog = false;
    idle(&mut r, 1);
    assert!(!view(&mut ra, b).hidden);
}
