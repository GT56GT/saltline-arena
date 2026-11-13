//! Fog of war: who may know where an opponent is.
//!
//! The server only sends an opponent's position to a player who can hear or see them (Valorant's
//! "Fog of War" idea). A wallhack can't show what the client never received. The rules:
//!   - teammates always see each other,
//!   - audible: within the opponent's current hearing distance (same table the client uses for
//!     footsteps: sprint 32 m, walk 18 m, crouch 5 m, in the air 24 m, climbing 12 m; a shot is
//!     heard 150 m for a second), plus a margin,
//!   - visible: any of a handful of rays from the viewer's eye to the opponent's head, chest and
//!     knees (and a little to each side) is clear of level boxes. Both players are also looked at
//!     where they will be a quarter-second from now, so a player rounding a corner arrives on the
//!     client before they are on screen,
//!   - once relevant, a player stays relevant for a second, so they don't flicker at edges.
//! Being generous is the safe side: a false "visible" only sends data a cheat could use; a false
//! "hidden" would make an opponent invisible, so every test errs toward visible.

use game_core::{Map, PlayerState};
use glam::Vec3;

/// Look-ahead (seconds) for both viewer and target: covers ping and the client's interpolation delay.
pub const LOOKAHEAD: f32 = 0.25;
/// How long an opponent stays relevant after the last check that found them (ticks at 30 Hz).
pub const HOLD_TICKS: u32 = 30;
/// Extra metres on top of a hearing distance.
pub const HEAR_MARGIN: f32 = 3.0;
/// A shot is heard this far, for SHOT_TICKS after it.
pub const SHOT_RANGE: f32 = 150.0;
pub const SHOT_TICKS: u32 = 30;

/// How far an opponent's movement can be heard right now (metres; 0 = silent).
/// Mirrors apps/web/src/game/footsteps.ts HEAR.
pub fn hear_range(s: &PlayerState) -> f32 {
    if !s.alive {
        return 0.0;
    }
    if s.mantle.is_some() {
        return 12.0;
    }
    if !s.on_ground {
        return 24.0; // the landing to come
    }
    let speed = Vec3::new(s.vel.x, 0.0, s.vel.z).length();
    if speed < 0.8 {
        0.0
    } else if s.crouching {
        5.0
    } else if speed > 5.0 {
        32.0
    } else {
        18.0
    }
}

/// Uniform XZ grid over the map's boxes, so a sight line only tests the boxes along its path.
pub struct SightGrid {
    min_x: f32,
    min_z: f32,
    cell: f32,
    nx: i32,
    nz: i32,
    cells: Vec<Vec<u16>>,
    boxes: Vec<(Vec3, Vec3)>,
}

impl SightGrid {
    pub fn new(map: &Map) -> Self {
        let cell = 4.0;
        let boxes: Vec<(Vec3, Vec3)> = map
            .boxes
            .iter()
            .filter(|b| !b.player_only)
            .map(|b| (b.min, b.max))
            .collect();
        // Cover the map and every box (some props sit outside the playable bounds).
        let (mut lo, mut hi) = (map.min, map.max);
        for (a, b) in &boxes {
            lo = lo.min(*a);
            hi = hi.max(*b);
        }
        let nx = (((hi.x - lo.x) / cell).ceil() as i32).max(1);
        let nz = (((hi.z - lo.z) / cell).ceil() as i32).max(1);
        let mut cells = vec![Vec::new(); (nx * nz) as usize];
        for (i, (a, b)) in boxes.iter().enumerate() {
            let (x0, x1) = (
                ((a.x - lo.x) / cell).floor() as i32,
                ((b.x - lo.x) / cell).floor() as i32,
            );
            let (z0, z1) = (
                ((a.z - lo.z) / cell).floor() as i32,
                ((b.z - lo.z) / cell).floor() as i32,
            );
            for z in z0.clamp(0, nz - 1)..=z1.clamp(0, nz - 1) {
                for x in x0.clamp(0, nx - 1)..=x1.clamp(0, nx - 1) {
                    cells[(z * nx + x) as usize].push(i as u16);
                }
            }
        }
        SightGrid {
            min_x: lo.x,
            min_z: lo.z,
            cell,
            nx,
            nz,
            cells,
            boxes,
        }
    }

    /// Does any box cut the segment a -> b (ends excluded by a few cm)?
    pub fn blocked(&self, a: Vec3, b: Vec3) -> bool {
        let d = b - a;
        let len = d.length();
        if len < 0.05 {
            return false;
        }
        let inv = Vec3::new(1.0 / d.x, 1.0 / d.y, 1.0 / d.z);
        let hit = |i: u16| {
            let (lo, hi) = self.boxes[i as usize];
            let t1 = (lo - a) * inv;
            let t2 = (hi - a) * inv;
            let tmin = t1.min(t2).max_element();
            let tmax = t1.max(t2).min_element();
            // in segment parameter units (0..1); skip the last few cm so a target touching a wall counts
            tmax >= tmin.max(0.0) && tmin <= 1.0 - 0.03 / len && tmax > 0.0
        };
        // 2D DDA through the grid cells the segment crosses (Amanatides & Woo).
        let c = self.cell;
        let fx = (a.x - self.min_x) / c;
        let fz = (a.z - self.min_z) / c;
        let mut x = fx.floor() as i32;
        let mut z = fz.floor() as i32;
        let ex = ((b.x - self.min_x) / c).floor() as i32;
        let ez = ((b.z - self.min_z) / c).floor() as i32;
        let (sx, sz) = (d.x.signum() as i32, d.z.signum() as i32);
        let tdx = if d.x != 0.0 {
            (c / d.x).abs() / 1.0
        } else {
            f32::INFINITY
        };
        let tdz = if d.z != 0.0 {
            (c / d.z).abs() / 1.0
        } else {
            f32::INFINITY
        };
        // t here is in world units of the x/z component per unit of segment parameter
        let mut tx = if d.x > 0.0 {
            ((x + 1) as f32 - fx) * c / d.x
        } else if d.x < 0.0 {
            (fx - x as f32) * c / -d.x
        } else {
            f32::INFINITY
        };
        let mut tz = if d.z > 0.0 {
            ((z + 1) as f32 - fz) * c / d.z
        } else if d.z < 0.0 {
            (fz - z as f32) * c / -d.z
        } else {
            f32::INFINITY
        };
        let steps = (ex - x).abs() + (ez - z).abs() + 1;
        for _ in 0..=steps {
            if x >= 0
                && z >= 0
                && x < self.nx
                && z < self.nz
                && self.cells[(z * self.nx + x) as usize]
                    .iter()
                    .any(|&i| hit(i))
            {
                return true;
            }
            if x == ex && z == ez {
                break;
            }
            if tx < tz {
                x += sx;
                tx += tdx;
            } else {
                z += sz;
                tz += tdz;
            }
        }
        false
    }

    /// Can a viewer with this eye and velocity see any part of the target, now or a moment from now?
    pub fn can_see(&self, eye: Vec3, eye_vel: Vec3, t: &PlayerState) -> bool {
        let flat = |v: Vec3| Vec3::new(v.x, 0.0, v.z);
        let mut origins = vec![eye];
        let ev = flat(eye_vel);
        if ev.length() > 0.5 {
            origins.push(eye + ev * LOOKAHEAD);
        }
        let mut bases = vec![t.pos];
        let tv = flat(t.vel);
        if tv.length() > 0.5 {
            bases.push(t.pos + tv * LOOKAHEAD);
        }
        let to = flat(t.pos - eye);
        let side = if to.length() > 1e-3 {
            Vec3::new(-to.z, 0.0, to.x).normalize()
        } else {
            Vec3::X
        };
        let heights: [f32; 3] = if t.crouching {
            [1.05, 0.7, 0.3]
        } else {
            [1.6, 1.1, 0.35]
        };
        for o in &origins {
            for b in &bases {
                for h in heights {
                    for l in [0.0, -0.45, 0.45] {
                        if !self.blocked(*o, *b + Vec3::Y * h + side * l) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::map::Aabb;

    fn wall_map() -> Map {
        let mut m = Map::yard();
        // a 6 m wide, 3 m high wall across x = 0
        m.boxes = vec![Aabb::new(
            Vec3::new(-0.5, 0.0, -3.0),
            Vec3::new(0.5, 3.0, 3.0),
        )];
        m
    }

    fn at(x: f32, z: f32) -> PlayerState {
        PlayerState::spawn(Vec3::new(x, 0.0, z), 0.0)
    }

    #[test]
    fn wall_hides_and_open_ground_shows() {
        let g = SightGrid::new(&wall_map());
        let eye = Vec3::new(-5.0, game_core::EYE_HEIGHT, 0.0);
        assert!(
            !g.can_see(eye, Vec3::ZERO, &at(5.0, 0.0)),
            "straight behind the wall"
        );
        assert!(
            g.can_see(eye, Vec3::ZERO, &at(5.0, 8.0)),
            "well off to the side"
        );
        assert!(
            g.can_see(eye, Vec3::ZERO, &at(-2.0, 1.0)),
            "same side of the wall"
        );
    }

    #[test]
    fn looks_ahead_around_corners() {
        let g = SightGrid::new(&wall_map());
        let eye = Vec3::new(-5.0, game_core::EYE_HEIGHT, 0.0);
        // just hidden behind the wall's end, sprinting out from behind it
        let mut t = at(2.0, 3.6);
        assert!(!g.can_see(eye, Vec3::ZERO, &t), "hidden while still");
        t.vel = Vec3::new(0.0, 0.0, 6.5);
        assert!(
            g.can_see(eye, Vec3::ZERO, &t),
            "seen a quarter-second before stepping out"
        );
    }

    #[test]
    fn grid_agrees_with_brute_force_on_the_harbour() {
        let m = Map::harbour();
        let g = SightGrid::new(&m);
        let mut seed = 7u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            (seed % 10_000) as f32 / 10_000.0
        };
        let mut differ = 0;
        for _ in 0..4000 {
            let p = |r: &mut dyn FnMut() -> f32| {
                Vec3::new(
                    m.min.x + r() * (m.max.x - m.min.x),
                    0.2 + r() * 4.0,
                    m.min.z + r() * (m.max.z - m.min.z),
                )
            };
            let (a, b) = (p(&mut rnd), p(&mut rnd));
            let len = (b - a).length();
            let brute = m.boxes.iter().filter(|x| !x.player_only).any(|x| {
                let d = (b - a) / len;
                let inv = Vec3::new(1.0 / d.x, 1.0 / d.y, 1.0 / d.z);
                let t1 = (x.min - a) * inv;
                let t2 = (x.max - a) * inv;
                let tmin = t1.min(t2).max_element();
                let tmax = t1.max(t2).min_element();
                tmax >= tmin.max(0.0) && tmin <= len - 0.03 && tmax > 0.0
            });
            if brute != g.blocked(a, b) {
                differ += 1;
            }
        }
        assert_eq!(differ, 0, "grid traversal must match testing every box");
    }

    #[test]
    fn hearing_table() {
        let mut s = at(0.0, 0.0);
        assert_eq!(hear_range(&s), 0.0);
        s.vel = Vec3::new(3.8, 0.0, 0.0);
        assert_eq!(hear_range(&s), 18.0);
        s.vel = Vec3::new(6.4, 0.0, 0.0);
        assert_eq!(hear_range(&s), 32.0);
        s.crouching = true;
        assert_eq!(hear_range(&s), 5.0);
        s.crouching = false;
        s.on_ground = false;
        assert_eq!(hear_range(&s), 24.0);
    }

    #[test]
    fn fast_enough_for_a_full_room() {
        // Worst case: 8 viewers x 7 opponents, everyone hidden (all rays tested), 10 checks a second.
        let m = Map::harbour();
        let g = SightGrid::new(&m);
        let spawns: Vec<Vec3> = m.spawns.iter().map(|s| s.pos).collect();
        let t0 = std::time::Instant::now();
        let mut n = 0;
        for _ in 0..10 {
            for a in spawns.iter().take(8) {
                for b in spawns.iter().take(8) {
                    if a != b {
                        let mut t = PlayerState::spawn(*b, 0.0);
                        t.vel = Vec3::new(4.0, 0.0, 0.0);
                        g.can_see(
                            *a + Vec3::Y * game_core::EYE_HEIGHT,
                            Vec3::new(0.0, 0.0, 4.0),
                            &t,
                        );
                        n += 1;
                    }
                }
            }
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        eprintln!("fog: {n} checks in {ms:.2} ms (one second of a full room)");
        assert!(ms < 200.0, "{ms} ms");
    }
}
