//! Hushline shared game rules.
//!
//! Everything here is deterministic and allocation-light so the exact same code can run
//! on the match server (native) and in the browser (WebAssembly) for movement prediction.
//! Coordinates: metres, Y up, a player's yaw 0 looks toward -Z (same as Three.js).

use glam::Vec3;
use serde::{Deserialize, Serialize};

pub mod map;
pub mod weapon;

pub use map::{Aabb, Landmark, Map};
pub use weapon::{Weapon, RIFLE};

/// Simulation rate. Every input and every server step covers exactly one tick.
pub const TICK_HZ: u32 = 30;
pub const DT: f32 = 1.0 / TICK_HZ as f32;

// Movement tuning matches the original Saltline player controller, so the client's
// first-person camera (which predicts with this exact code) feels like the original game.
pub const PLAYER_RADIUS: f32 = 0.32;
pub const PLAYER_HEIGHT: f32 = 1.8;
pub const CROUCH_HEIGHT: f32 = 1.15;
pub const EYE_HEIGHT: f32 = 1.68;
pub const CROUCH_EYE: f32 = 1.05;
pub const HEAD_RADIUS: f32 = 0.14;

pub const WALK_SPEED: f32 = 3.8;
pub const SPRINT_SPEED: f32 = 6.4;
pub const CROUCH_SPEED: f32 = 1.9;
pub const GROUND_ACCEL: f32 = 34.0;
pub const GROUND_DECEL: f32 = 26.0;
pub const AIR_ACCEL: f32 = 9.0;
/// With no movement input in the air, momentum is almost kept.
pub const AIR_DRAG: f32 = 0.6;
pub const GRAVITY: f32 = 21.0;
/// Jump apex of 1 m: sqrt(2 * GRAVITY * 1.0).
pub const JUMP_SPEED: f32 = 6.480_741;
pub const MAX_PITCH: f32 = 1.5;
pub const MAX_HEALTH: f32 = 100.0;

/// Climbing (mantling): jump facing a ledge whose top is this far above the feet...
pub const MANTLE_MIN: f32 = 0.6;
/// ...up to one shipping container (2.6 m) with a little slack. Double stacks are too tall.
pub const MANTLE_MAX: f32 = 2.75;
/// How far ahead to look for the ledge, beyond the body radius.
pub const MANTLE_REACH: f32 = 0.5;

/// An active climb: rise at `from`'s spot to the ledge height, then pull forward onto `to`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mantle {
    pub from: Vec3,
    pub to: Vec3,
    /// Seconds into the climb, and its total length.
    pub t: f32,
    pub dur: f32,
}

impl Mantle {
    /// Position along the climb at time `t` (first lift, then over the edge).
    pub fn at(&self, t: f32) -> Vec3 {
        let k = (t / self.dur).clamp(0.0, 1.0);
        let lift = 0.72;
        if k < lift {
            let u = k / lift;
            let e = 1.0 - (1.0 - u) * (1.0 - u); // fast start, slows at the top
            Vec3::new(
                self.from.x,
                self.from.y + (self.to.y + 0.04 - self.from.y) * e,
                self.from.z,
            )
        } else {
            let u = (k - lift) / (1.0 - lift);
            let e = u * u * (3.0 - 2.0 * u);
            let top = self.to.y + 0.04 * (1.0 - e);
            Vec3::new(
                self.from.x + (self.to.x - self.from.x) * e,
                top,
                self.from.z + (self.to.z - self.from.z) * e,
            )
        }
    }
}
/// Kerbs, steps and low ledges up to this height are climbed automatically.
pub const STEP_HEIGHT: f32 = 0.45;

/// What a client is allowed to tell the server: intentions, never outcomes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Input {
    /// Monotonic per client; the server ignores anything not newer than the last applied.
    pub seq: u32,
    /// Strafe (-1 left .. 1 right) and forward (-1 back .. 1 forward). Clamped to unit length.
    pub mx: f32,
    pub mz: f32,
    pub yaw: f32,
    pub pitch: f32,
    #[serde(default)]
    pub jump: bool,
    #[serde(default)]
    pub sprint: bool,
    #[serde(default)]
    pub crouch: bool,
    #[serde(default)]
    pub fire: bool,
    #[serde(default)]
    pub reload: bool,
    /// The server tick the client was looking at when it produced this input (for lag compensation).
    #[serde(default)]
    pub view_tick: u32,
}

impl Input {
    /// Make an untrusted input safe to simulate: finite numbers, unit-length movement, pitch in range.
    pub fn sanitized(mut self) -> Self {
        let fix = |v: f32| if v.is_finite() { v } else { 0.0 };
        self.mx = fix(self.mx).clamp(-1.0, 1.0);
        self.mz = fix(self.mz).clamp(-1.0, 1.0);
        let len = (self.mx * self.mx + self.mz * self.mz).sqrt();
        if len > 1.0 {
            self.mx /= len;
            self.mz /= len;
        }
        self.yaw = fix(self.yaw).rem_euclid(std::f32::consts::TAU);
        self.pitch = fix(self.pitch).clamp(-MAX_PITCH, MAX_PITCH);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerState {
    pub pos: Vec3,
    pub vel: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub on_ground: bool,
    pub crouching: bool,
    pub health: f32,
    pub alive: bool,
    pub ammo: u32,
    /// Seconds until the weapon may fire again.
    pub fire_cd: f32,
    /// Seconds left on an active reload (0 = not reloading).
    pub reload_t: f32,
    /// Climbing over a ledge (movement and shooting are locked meanwhile).
    #[serde(default)]
    pub mantle: Option<Mantle>,
}

impl PlayerState {
    pub fn spawn(pos: Vec3, yaw: f32) -> Self {
        Self {
            pos,
            vel: Vec3::ZERO,
            yaw,
            pitch: 0.0,
            on_ground: true,
            crouching: false,
            health: MAX_HEALTH,
            alive: true,
            ammo: RIFLE.mag,
            fire_cd: 0.0,
            reload_t: 0.0,
            mantle: None,
        }
    }

    pub fn height(&self) -> f32 {
        if self.crouching {
            CROUCH_HEIGHT
        } else {
            PLAYER_HEIGHT
        }
    }

    pub fn eye(&self) -> Vec3 {
        self.pos
            + Vec3::Y
                * if self.crouching {
                    CROUCH_EYE
                } else {
                    EYE_HEIGHT
                }
    }

    pub fn head(&self) -> Vec3 {
        self.pos + Vec3::Y * (self.height() - HEAD_RADIUS)
    }
}

/// Direction a yaw/pitch pair looks at (yaw 0 = -Z, positive pitch = up).
pub fn look_dir(yaw: f32, pitch: f32) -> Vec3 {
    let (sy, cy) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    Vec3::new(-sy * cp, sp, -cy * cp)
}

/// Advance one player by exactly one tick. Pure function of (state, input, map):
/// the server and the browser get identical results for identical inputs.
pub fn step_player(s: &mut PlayerState, input: &Input, map: &Map) {
    if !s.alive {
        return;
    }
    let inp = input.sanitized();
    s.yaw = inp.yaw;
    s.pitch = inp.pitch;

    // Mid-climb: follow the climb path; nothing else moves the player.
    if let Some(mut m) = s.mantle {
        m.t += DT;
        s.crouching = false;
        if m.t >= m.dur {
            s.pos = m.to;
            let fwd = Vec3::new(m.to.x - m.from.x, 0.0, m.to.z - m.from.z).normalize_or_zero();
            s.vel = fwd * 1.5;
            s.on_ground = true;
            s.mantle = None;
        } else {
            s.pos = m.at(m.t);
            s.vel = Vec3::ZERO;
            s.on_ground = false;
            s.mantle = Some(m);
        }
        weapon_timers(s, &inp);
        return;
    }
    s.crouching = inp.crouch;

    // Wish direction on the ground plane, relative to where the player faces.
    let fwd = Vec3::new(-s.yaw.sin(), 0.0, -s.yaw.cos());
    let right = Vec3::new(-fwd.z, 0.0, fwd.x);
    let wish = fwd * inp.mz + right * inp.mx;
    let moving = inp.mx * inp.mx + inp.mz * inp.mz > 0.01;
    // Sprint only when running mostly forward and not shooting (as in the original game).
    let sprinting = inp.sprint && inp.mz > 0.55 && inp.mx.abs() < 0.6 && !s.crouching && !inp.fire;
    let mut max_speed = if s.crouching {
        CROUCH_SPEED
    } else if sprinting {
        SPRINT_SPEED
    } else {
        WALK_SPEED
    };
    if inp.mz < 0.0 {
        // Backpedalling is a little slower.
        max_speed *= 1.0 + (0.82 - 1.0) * (-inp.mz);
    }
    let target = wish * max_speed;
    let accel = match (s.on_ground, moving) {
        (true, true) => GROUND_ACCEL,
        (true, false) => GROUND_DECEL,
        (false, true) => AIR_ACCEL,
        (false, false) => AIR_DRAG,
    };
    let mut horiz = Vec3::new(s.vel.x, 0.0, s.vel.z);
    let delta = target - horiz;
    let step = accel * DT;
    horiz += if delta.length() > step {
        delta.normalize() * step
    } else {
        delta
    };
    s.vel.x = horiz.x;
    s.vel.z = horiz.z;

    // Jump facing a ledge: climb it. Otherwise an ordinary jump (from the ground only).
    if inp.jump && !s.crouching && s.vel.y > -4.0 {
        if let Some(m) = find_mantle(s.pos, fwd, map) {
            s.mantle = Some(m);
            s.vel = Vec3::ZERO;
            s.on_ground = false;
            weapon_timers(s, &inp);
            return;
        }
    }
    if inp.jump && s.on_ground && !s.crouching {
        s.vel.y = JUMP_SPEED;
        s.on_ground = false;
    }
    s.vel.y -= GRAVITY * DT;

    // Move one axis at a time and resolve against the map's boxes.
    let h = s.height();
    let mut p = s.pos;
    // Horizontal moves, one axis at a time; a blocked move may step up onto a low ledge.
    let try_axis = |p: &mut Vec3, delta: Vec3, on_ground: bool| -> bool {
        let moved = *p + delta;
        if !map.overlaps(moved, PLAYER_RADIUS, h) {
            *p = moved;
            return true;
        }
        if on_ground {
            let up = moved + Vec3::Y * STEP_HEIGHT;
            if !map.overlaps(up, PLAYER_RADIUS, h) {
                if let Some(floor) = map.floor_below(up, PLAYER_RADIUS) {
                    let stepped = Vec3::new(moved.x, floor.max(p.y), moved.z);
                    if floor - p.y <= STEP_HEIGHT + 1e-3 && !map.overlaps(stepped, PLAYER_RADIUS, h)
                    {
                        *p = stepped;
                        return true;
                    }
                }
            }
        }
        false
    };
    if !try_axis(&mut p, Vec3::new(s.vel.x * DT, 0.0, 0.0), s.on_ground) {
        s.vel.x = 0.0;
    }
    if !try_axis(&mut p, Vec3::new(0.0, 0.0, s.vel.z * DT), s.on_ground) {
        s.vel.z = 0.0;
    }
    let prev_y = p.y;
    p.y += s.vel.y * DT;
    s.on_ground = false;
    // Standing on a box top: stay on it while it is under our feet.
    if s.vel.y <= 0.0 && p.y > 0.0 {
        if let Some(top) = map.floor_below(Vec3::new(p.x, prev_y, p.z), PLAYER_RADIUS) {
            if p.y <= top && prev_y >= top - 1e-3 {
                p.y = top;
                s.vel.y = 0.0;
                s.on_ground = true;
            }
        }
    }
    if s.on_ground {
        // landed on a box top above
    } else if p.y <= 0.0 {
        p.y = 0.0;
        s.vel.y = 0.0;
        s.on_ground = true;
    } else if map.overlaps(p, PLAYER_RADIUS, h) {
        if s.vel.y < 0.0 {
            // Landed on top of a box: snap to its top surface.
            p.y = map
                .floor_below(Vec3::new(p.x, prev_y, p.z), PLAYER_RADIUS)
                .unwrap_or(prev_y);
            s.on_ground = true;
        } else {
            p.y = prev_y;
        }
        s.vel.y = 0.0;
    }
    p.x =
        p.x.clamp(map.min.x + PLAYER_RADIUS, map.max.x - PLAYER_RADIUS);
    p.z =
        p.z.clamp(map.min.z + PLAYER_RADIUS, map.max.z - PLAYER_RADIUS);
    s.pos = p;
    weapon_timers(s, &inp);
}

/// A ledge in front of `pos` that the player can climb onto, if any.
pub fn find_mantle(pos: Vec3, fwd: Vec3, map: &Map) -> Option<Mantle> {
    if fwd.length_squared() < 1e-6 {
        return None;
    }
    let fwd = fwd.normalize();
    // The highest box top just ahead, within climbing height.
    let probe = pos + fwd * (PLAYER_RADIUS + MANTLE_REACH);
    let top = map.floor_below(Vec3::new(probe.x, pos.y + MANTLE_MAX, probe.z), 0.08)?;
    let rise = top - pos.y;
    if !(MANTLE_MIN..=MANTLE_MAX + 0.05).contains(&rise) {
        return None;
    }
    // Standing spot on the ledge: fully on its top, with room to stand (no stacked box above).
    let reach = PLAYER_RADIUS + MANTLE_REACH + 0.1;
    let to = Vec3::new(pos.x + fwd.x * reach, top, pos.z + fwd.z * reach);
    let support = map.floor_below(to + Vec3::Y * 0.01, PLAYER_RADIUS * 0.5)?;
    if (support - top).abs() > 0.02
        || map.overlaps(to + Vec3::Y * 0.01, PLAYER_RADIUS, PLAYER_HEIGHT)
    {
        return None;
    }
    // Room to rise straight up where we stand (no overhang or ceiling).
    if map.overlaps(
        Vec3::new(pos.x, top + 0.05, pos.z),
        PLAYER_RADIUS * 0.9,
        PLAYER_HEIGHT,
    ) {
        return None;
    }
    let dur = 0.32 + 0.13 * rise;
    Some(Mantle {
        from: pos,
        to,
        t: 0.0,
        dur,
    })
}

fn weapon_timers(s: &mut PlayerState, inp: &Input) {
    // Fire cooldown may run one tick negative so a 720 rpm rifle averages 12 shots a second
    // on a 30 Hz server (shots land 3, 2, 3, 2... ticks apart) instead of rounding down to 10.
    s.fire_cd = (s.fire_cd - DT).max(-DT);
    if s.reload_t > 0.0 {
        s.reload_t = (s.reload_t - DT).max(0.0);
        if s.reload_t == 0.0 {
            s.ammo = RIFLE.mag;
        }
    } else if inp.reload && s.ammo < RIFLE.mag {
        s.reload_t = RIFLE.reload_time(s.ammo);
    }
}

/// Where a ray first touches a player standing in pose `p`: returns (distance, headshot).
/// The body is a vertical capsule; the head is a sphere on top (checked first).
pub fn ray_vs_player(origin: Vec3, dir: Vec3, max: f32, p: &PlayerState) -> Option<(f32, bool)> {
    if !p.alive {
        return None;
    }
    if let Some(t) = ray_sphere(origin, dir, p.head(), HEAD_RADIUS) {
        if t <= max {
            return Some((t, true));
        }
    }
    let a = p.pos + Vec3::Y * PLAYER_RADIUS;
    let b = p.pos + Vec3::Y * (p.height() - HEAD_RADIUS * 2.0);
    ray_capsule(origin, dir, a, b, PLAYER_RADIUS)
        .filter(|t| *t <= max)
        .map(|t| (t, false))
}

fn ray_sphere(o: Vec3, d: Vec3, c: Vec3, r: f32) -> Option<f32> {
    let m = o - c;
    let b = m.dot(d);
    let cc = m.dot(m) - r * r;
    if cc > 0.0 && b > 0.0 {
        return None;
    }
    let disc = b * b - cc;
    if disc < 0.0 {
        return None;
    }
    Some((-b - disc.sqrt()).max(0.0))
}

/// Ray vs capsule (segment a-b, radius r), by closest approach between the ray and the segment.
fn ray_capsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: f32) -> Option<f32> {
    let ab = b - a;
    let ao = o - a;
    let ab_len2 = ab.dot(ab);
    // Closest points between the ray o + t d (t >= 0) and the segment a + s ab (0..1).
    let d_ab = d.dot(ab);
    let denom = ab_len2 - d_ab * d_ab;
    let mut s = if denom.abs() > 1e-6 {
        (ab.dot(ao) - d_ab * d.dot(ao)) / denom
    } else {
        0.0
    };
    s = s.clamp(0.0, 1.0);
    let seg_pt = a + ab * s;
    // Then the sphere at that segment point gives the entry distance.
    ray_sphere(o, d, seg_pt, r).or_else(|| {
        // Re-check against the end caps for grazing shots.
        ray_sphere(o, d, a, r).or_else(|| ray_sphere(o, d, b, r))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_map() -> Map {
        Map {
            min: Vec3::new(-50.0, 0.0, -50.0),
            max: Vec3::new(50.0, 20.0, 50.0),
            boxes: vec![],
            spawns: vec![],
            name: String::new(),
            sea_x: None,
            landmarks: vec![],
        }
    }

    #[test]
    fn walks_forward_at_walk_speed() {
        let map = open_map();
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        let inp = Input {
            mz: 1.0,
            ..Default::default()
        };
        for _ in 0..TICK_HZ * 2 {
            step_player(&mut s, &inp, &map);
        }
        // Facing -Z; after 2 s near walk speed (small accel ramp).
        let full = WALK_SPEED * 2.0;
        assert!(
            s.pos.z < -(full - 0.4) && s.pos.z > -(full + 0.05),
            "z = {}",
            s.pos.z
        );
        assert!(s.pos.x.abs() < 1e-3);
    }

    #[test]
    fn oversized_input_is_clamped() {
        let map = open_map();
        let mut cheat = PlayerState::spawn(Vec3::ZERO, 0.0);
        let mut fair = PlayerState::spawn(Vec3::ZERO, 0.0);
        for _ in 0..TICK_HZ {
            step_player(
                &mut cheat,
                &Input {
                    mz: 50.0,
                    mx: 50.0,
                    ..Default::default()
                },
                &map,
            );
            step_player(
                &mut fair,
                &Input {
                    mz: 1.0,
                    ..Default::default()
                },
                &map,
            );
        }
        assert!(cheat.pos.length() <= fair.pos.length() + 1e-3);
    }

    #[test]
    fn walls_block_movement() {
        let mut map = open_map();
        map.boxes.push(Aabb::new(
            Vec3::new(-5.0, 0.0, -3.0),
            Vec3::new(5.0, 3.0, -2.0),
        ));
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        for _ in 0..TICK_HZ * 2 {
            step_player(
                &mut s,
                &Input {
                    mz: 1.0,
                    ..Default::default()
                },
                &map,
            );
        }
        assert!(
            s.pos.z >= -2.0 + PLAYER_RADIUS - 1e-3,
            "went through wall: z = {}",
            s.pos.z
        );
    }

    #[test]
    fn steps_up_kerbs_but_not_walls() {
        let mut map = open_map();
        map.boxes.push(Aabb::new(
            Vec3::new(-5.0, 0.0, -3.0),
            Vec3::new(5.0, 0.3, -2.0),
        )); // kerb
        map.boxes.push(Aabb::new(
            Vec3::new(-5.0, 0.0, -8.0),
            Vec3::new(5.0, 1.2, -7.0),
        )); // wall
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        for _ in 0..TICK_HZ * 2 {
            step_player(
                &mut s,
                &Input {
                    mz: 1.0,
                    ..Default::default()
                },
                &map,
            );
        }
        assert!(s.pos.z < -3.0, "climbed the kerb: z = {}", s.pos.z);
        assert!(
            s.pos.z > -7.0 + PLAYER_RADIUS - 0.01,
            "stopped by the wall: z = {}",
            s.pos.z
        );
    }

    #[test]
    fn jump_and_land() {
        let map = open_map();
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        step_player(
            &mut s,
            &Input {
                jump: true,
                ..Default::default()
            },
            &map,
        );
        assert!(s.pos.y > 0.0 && !s.on_ground);
        for _ in 0..TICK_HZ {
            step_player(&mut s, &Input::default(), &map);
        }
        assert!(s.on_ground && s.pos.y == 0.0);
    }

    #[test]
    fn headshot_and_body_shot() {
        let target = PlayerState::spawn(Vec3::new(0.0, 0.0, -10.0), 0.0);
        let eye = Vec3::new(0.0, target.head().y, 0.0);
        let (t, head) = ray_vs_player(eye, Vec3::NEG_Z, 100.0, &target).unwrap();
        assert!(head && (t - (10.0 - HEAD_RADIUS)).abs() < 0.05);
        let chest = Vec3::new(0.0, 1.0, 0.0);
        let (t, head) = ray_vs_player(chest, Vec3::NEG_Z, 100.0, &target).unwrap();
        assert!(!head && (t - (10.0 - PLAYER_RADIUS)).abs() < 0.05);
        assert!(ray_vs_player(chest, Vec3::X, 100.0, &target).is_none());
    }
}

#[cfg(test)]
mod mantle_tests {
    use super::*;
    use crate::map::Aabb;

    fn map_with(boxes: Vec<Aabb>) -> Map {
        let mut m = Map::yard();
        m.boxes = boxes;
        m
    }
    /// A 2.4 x 6 m container footprint, `h` tall, starting 1 m in front of the origin (toward -Z).
    macro_rules! fat_container {
        () => {
            fn container(h: f32, stacked: bool) -> Vec<Aabb> {
                let mut v = vec![Aabb::new(
                    Vec3::new(-1.2, 0.0, -7.0),
                    Vec3::new(1.2, h, -1.0),
                )];
                if stacked {
                    v.push(Aabb::new(
                        Vec3::new(-1.2, h, -7.0),
                        Vec3::new(1.2, h * 2.0, -1.0),
                    ));
                }
                v
            }
        };
    }
    fat_container!();

    fn run(map: &Map, mut s: PlayerState, ticks: u32, jump_at: u32) -> PlayerState {
        for i in 0..ticks {
            let inp = Input {
                seq: i + 1,
                mz: 1.0,
                jump: i == jump_at,
                ..Default::default()
            };
            step_player(&mut s, &inp, map);
        }
        s
    }

    #[test]
    fn climbs_onto_a_container() {
        let map = map_with(container(2.6, false));
        let s = PlayerState::spawn(Vec3::new(0.0, 0.0, 0.0), 0.0);
        // Walk up to the side, jump: the climb starts and ends standing on top.
        let s = run(&map, s, 50, 20);
        assert!((s.pos.y - 2.6).abs() < 1e-3, "on top, y = {}", s.pos.y);
        assert!(s.pos.z < -1.0, "over the edge, z = {}", s.pos.z);
        assert!(s.on_ground && s.mantle.is_none());
    }

    #[test]
    fn cannot_climb_double_stacks_or_without_jumping() {
        let map = map_with(container(2.6, true));
        let s = run(&map, PlayerState::spawn(Vec3::ZERO, 0.0), 40, 20);
        assert!(s.pos.y < 1.2, "a 5.2 m stack is a wall, y = {}", s.pos.y);
        let map = map_with(container(2.6, false));
        let s = run(&map, PlayerState::spawn(Vec3::ZERO, 0.0), 40, 999);
        assert_eq!(s.pos.y, 0.0, "walking into it does not climb");
    }

    #[test]
    fn climb_is_deterministic_and_replayable() {
        // Same inputs, same result: what the browser predicts is what the server computes.
        let map = map_with(container(2.6, false));
        let a = run(&map, PlayerState::spawn(Vec3::ZERO, 0.0), 30, 20);
        let b = run(&map, PlayerState::spawn(Vec3::ZERO, 0.0), 30, 20);
        assert_eq!(a.pos, b.pos);
        assert!(
            a.mantle.is_some(),
            "still mid-climb 10 ticks after the jump"
        );
    }

    #[test]
    fn harbour_containers_are_climbable() {
        // At least a few of the real map's single containers can be climbed from the ground.
        let map = Map::harbour();
        let mut found = 0;
        for b in map
            .boxes
            .iter()
            .filter(|b| b.min.y < 0.05 && (b.max.y - 2.6).abs() < 0.15)
        {
            let c = (b.min + b.max) * 0.5;
            // Stand just outside the long +X side, face -X.
            let start = Vec3::new(b.max.x + PLAYER_RADIUS + 0.05, 0.0, c.z);
            if map.overlaps(start, PLAYER_RADIUS, PLAYER_HEIGHT) {
                continue;
            }
            if find_mantle(start, Vec3::new(-1.0, 0.0, 0.0), &map).is_some() {
                found += 1;
            }
        }
        assert!(found >= 3, "climbable harbour containers: {found}");
    }
}
