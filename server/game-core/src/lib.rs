//! Saltline Arena shared game rules.
//!
//! Everything here is deterministic and allocation-light so the exact same code can run
//! on the match server (native) and in the browser (WebAssembly) for movement prediction.
//! Coordinates: metres, Y up, a player's yaw 0 looks toward -Z (same as Three.js).

use glam::Vec3;
use serde::{Deserialize, Serialize};

pub mod map;
pub mod weapon;

pub use map::{Aabb, Map};
pub use weapon::{Weapon, RIFLE};

/// Simulation rate. Every input and every server step covers exactly one tick.
pub const TICK_HZ: u32 = 30;
pub const DT: f32 = 1.0 / TICK_HZ as f32;

pub const PLAYER_RADIUS: f32 = 0.35;
pub const PLAYER_HEIGHT: f32 = 1.8;
pub const CROUCH_HEIGHT: f32 = 1.2;
pub const EYE_HEIGHT: f32 = 1.6;
pub const CROUCH_EYE: f32 = 1.05;
pub const HEAD_RADIUS: f32 = 0.14;

pub const WALK_SPEED: f32 = 5.0;
pub const SPRINT_SPEED: f32 = 7.5;
pub const CROUCH_SPEED: f32 = 2.6;
pub const GROUND_ACCEL: f32 = 60.0;
pub const AIR_ACCEL: f32 = 12.0;
pub const GRAVITY: f32 = 22.0;
pub const JUMP_SPEED: f32 = 7.2;
pub const MAX_PITCH: f32 = 1.5;
pub const MAX_HEALTH: f32 = 100.0;

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
        }
    }

    pub fn height(&self) -> f32 {
        if self.crouching { CROUCH_HEIGHT } else { PLAYER_HEIGHT }
    }

    pub fn eye(&self) -> Vec3 {
        self.pos + Vec3::Y * if self.crouching { CROUCH_EYE } else { EYE_HEIGHT }
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
    s.crouching = inp.crouch;

    // Wish direction on the ground plane, relative to where the player faces.
    let fwd = Vec3::new(-s.yaw.sin(), 0.0, -s.yaw.cos());
    let right = Vec3::new(-fwd.z, 0.0, fwd.x);
    let wish = fwd * inp.mz + right * inp.mx;
    let max_speed = if s.crouching {
        CROUCH_SPEED
    } else if inp.sprint && inp.mz > 0.5 {
        SPRINT_SPEED
    } else {
        WALK_SPEED
    };
    let target = wish * max_speed;
    let accel = if s.on_ground { GROUND_ACCEL } else { AIR_ACCEL };
    let mut horiz = Vec3::new(s.vel.x, 0.0, s.vel.z);
    let delta = target - horiz;
    let step = accel * DT;
    horiz += if delta.length() > step { delta.normalize() * step } else { delta };
    s.vel.x = horiz.x;
    s.vel.z = horiz.z;

    if inp.jump && s.on_ground && !s.crouching {
        s.vel.y = JUMP_SPEED;
        s.on_ground = false;
    }
    s.vel.y -= GRAVITY * DT;

    // Move one axis at a time and resolve against the map's boxes.
    let h = s.height();
    let mut p = s.pos;
    p.x += s.vel.x * DT;
    if map.overlaps(p, PLAYER_RADIUS, h) {
        p.x = s.pos.x;
        s.vel.x = 0.0;
    }
    p.z += s.vel.z * DT;
    if map.overlaps(p, PLAYER_RADIUS, h) {
        p.z = s.pos.z;
        s.vel.z = 0.0;
    }
    let prev_y = p.y;
    p.y += s.vel.y * DT;
    s.on_ground = false;
    if p.y <= 0.0 {
        p.y = 0.0;
        s.vel.y = 0.0;
        s.on_ground = true;
    } else if map.overlaps(p, PLAYER_RADIUS, h) {
        if s.vel.y < 0.0 {
            // Landed on top of a box: snap to its top surface.
            p.y = map.floor_below(Vec3::new(p.x, prev_y, p.z), PLAYER_RADIUS).unwrap_or(prev_y);
            s.on_ground = true;
        } else {
            p.y = prev_y;
        }
        s.vel.y = 0.0;
    }
    p.x = p.x.clamp(map.min.x + PLAYER_RADIUS, map.max.x - PLAYER_RADIUS);
    p.z = p.z.clamp(map.min.z + PLAYER_RADIUS, map.max.z - PLAYER_RADIUS);
    s.pos = p;

    // Weapon timers.
    s.fire_cd = (s.fire_cd - DT).max(0.0);
    if s.reload_t > 0.0 {
        s.reload_t = (s.reload_t - DT).max(0.0);
        if s.reload_t == 0.0 {
            s.ammo = RIFLE.mag;
        }
    } else if inp.reload && s.ammo < RIFLE.mag {
        s.reload_t = RIFLE.reload_secs;
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
    ray_capsule(origin, dir, a, b, PLAYER_RADIUS).filter(|t| *t <= max).map(|t| (t, false))
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
    let mut s = if denom.abs() > 1e-6 { (ab.dot(ao) - d_ab * d.dot(ao)) / denom } else { 0.0 };
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
        Map { min: Vec3::new(-50.0, 0.0, -50.0), max: Vec3::new(50.0, 20.0, 50.0), boxes: vec![], spawns: vec![] }
    }

    #[test]
    fn walks_forward_at_walk_speed() {
        let map = open_map();
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        let inp = Input { mz: 1.0, ..Default::default() };
        for _ in 0..TICK_HZ * 2 {
            step_player(&mut s, &inp, &map);
        }
        // Facing -Z; after 2 s near walk speed (small accel ramp).
        assert!(s.pos.z < -9.0 && s.pos.z > -10.1, "z = {}", s.pos.z);
        assert!(s.pos.x.abs() < 1e-3);
    }

    #[test]
    fn oversized_input_is_clamped() {
        let map = open_map();
        let mut cheat = PlayerState::spawn(Vec3::ZERO, 0.0);
        let mut fair = PlayerState::spawn(Vec3::ZERO, 0.0);
        for _ in 0..TICK_HZ {
            step_player(&mut cheat, &Input { mz: 50.0, mx: 50.0, ..Default::default() }, &map);
            step_player(&mut fair, &Input { mz: 1.0, ..Default::default() }, &map);
        }
        assert!(cheat.pos.length() <= fair.pos.length() + 1e-3);
    }

    #[test]
    fn walls_block_movement() {
        let mut map = open_map();
        map.boxes.push(Aabb { min: Vec3::new(-5.0, 0.0, -3.0), max: Vec3::new(5.0, 3.0, -2.0) });
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        for _ in 0..TICK_HZ * 2 {
            step_player(&mut s, &Input { mz: 1.0, ..Default::default() }, &map);
        }
        assert!(s.pos.z >= -2.0 + PLAYER_RADIUS - 1e-3, "went through wall: z = {}", s.pos.z);
    }

    #[test]
    fn jump_and_land() {
        let map = open_map();
        let mut s = PlayerState::spawn(Vec3::ZERO, 0.0);
        step_player(&mut s, &Input { jump: true, ..Default::default() }, &map);
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
