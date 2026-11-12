//! Static level geometry as axis-aligned boxes (containers, walls, crates).

use glam::Vec3;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spawn {
    pub pos: Vec3,
    pub yaw: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Map {
    pub min: Vec3,
    pub max: Vec3,
    pub boxes: Vec<Aabb>,
    pub spawns: Vec<Spawn>,
}

impl Map {
    /// Does a standing player cylinder (feet at `p`, given radius/height) intersect any box?
    pub fn overlaps(&self, p: Vec3, r: f32, h: f32) -> bool {
        self.boxes.iter().any(|b| {
            p.x + r > b.min.x && p.x - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z
                && p.y + h > b.min.y && p.y < b.max.y
        })
    }

    /// Highest box top under a player's footprint at or below `p.y` (for landing on boxes).
    pub fn floor_below(&self, p: Vec3, r: f32) -> Option<f32> {
        self.boxes
            .iter()
            .filter(|b| p.x + r > b.min.x && p.x - r < b.max.x && p.z + r > b.min.z && p.z - r < b.max.z)
            .map(|b| b.max.y)
            .filter(|top| *top <= p.y + 0.05)
            .reduce(f32::max)
    }

    /// Distance along `dir` (unit) to the first box hit, if any within `max`.
    pub fn raycast(&self, o: Vec3, dir: Vec3, max: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        let inv = Vec3::new(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
        for b in &self.boxes {
            let t1 = (b.min - o) * inv;
            let t2 = (b.max - o) * inv;
            let tmin = t1.min(t2).max_element().max(0.0);
            let tmax = t1.max(t2).min_element();
            if tmax >= tmin && tmin <= max && best.is_none_or(|bt| tmin < bt) {
                best = Some(tmin);
            }
        }
        // The ground plane counts as geometry too.
        if dir.y < 0.0 {
            let tg = -o.y / dir.y;
            if tg >= 0.0 && tg <= max && best.is_none_or(|bt| tg < bt) {
                best = Some(tg);
            }
        }
        best
    }

    /// Is the straight line between two points free of boxes?
    pub fn line_of_sight(&self, a: Vec3, b: Vec3) -> bool {
        let d = b - a;
        let len = d.length();
        if len < 1e-4 {
            return true;
        }
        self.raycast(a, d / len, len).is_none_or(|t| t >= len - 1e-3)
    }

    /// "Yard": a 60 x 60 m container yard used by the phase-1 prototype.
    pub fn yard() -> Self {
        let c = |x: f32, z: f32, w: f32, d: f32, h: f32| Aabb {
            min: Vec3::new(x - w / 2.0, 0.0, z - d / 2.0),
            max: Vec3::new(x + w / 2.0, h, z + d / 2.0),
        };
        Map {
            min: Vec3::new(-30.0, 0.0, -30.0),
            max: Vec3::new(30.0, 30.0, 30.0),
            boxes: vec![
                // Shipping containers (12.2 x 2.4 x 2.6 m), some stacked.
                c(-12.0, -10.0, 12.2, 2.4, 2.6),
                c(-12.0, -10.0, 12.2, 2.4, 5.2),
                c(12.0, 10.0, 12.2, 2.4, 2.6),
                c(0.0, -18.0, 2.4, 12.2, 2.6),
                c(0.0, 18.0, 2.4, 12.2, 2.6),
                c(18.0, -12.0, 2.4, 6.0, 2.6),
                c(-18.0, 12.0, 2.4, 6.0, 2.6),
                // Low crates to vault over / crouch behind.
                c(-4.0, 4.0, 1.2, 1.2, 1.0),
                c(5.0, -4.0, 1.2, 1.2, 1.0),
            ],
            spawns: vec![
                Spawn { pos: Vec3::new(0.0, 0.0, 10.0), yaw: 0.0 },
                Spawn { pos: Vec3::new(0.0, 0.0, -8.0), yaw: std::f32::consts::PI },
                Spawn { pos: Vec3::new(-24.0, 0.0, -24.0), yaw: -2.356 },
                Spawn { pos: Vec3::new(24.0, 0.0, 24.0), yaw: 0.785 },
                Spawn { pos: Vec3::new(24.0, 0.0, -24.0), yaw: 2.356 },
                Spawn { pos: Vec3::new(-24.0, 0.0, 24.0), yaw: -0.785 },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raycast_hits_box_and_ground() {
        let m = Map::yard();
        let t = m.raycast(Vec3::new(-12.0, 1.0, 0.0), Vec3::NEG_Z, 100.0).unwrap();
        assert!((t - 8.8).abs() < 1e-3, "t = {t}");
        let down = m.raycast(Vec3::new(25.0, 2.0, 0.0), Vec3::NEG_Y, 100.0).unwrap();
        assert!((down - 2.0).abs() < 1e-3);
        assert!(!m.line_of_sight(Vec3::new(-12.0, 1.0, 0.0), Vec3::new(-12.0, 1.0, -20.0)));
        assert!(m.line_of_sight(Vec3::new(25.0, 1.0, 0.0), Vec3::new(25.0, 1.0, -5.0)));
    }
}
