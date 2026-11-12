//! Static level geometry as axis-aligned boxes (containers, walls, crates).

use glam::Vec3;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
    /// Blocks players but not bullets (invisible walls, railings).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub player_only: bool,
    /// Visual surface, for the client.
    #[serde(default)]
    pub surface: Surface,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    #[default]
    Concrete,
    Metal,
    Wood,
    Rubber,
    Dirt,
}

impl Aabb {
    pub const fn new(min: Vec3, max: Vec3) -> Self {
        Aabb { min, max, player_only: false, surface: Surface::Concrete }
    }
}

/// A named place drawn by the client (relays, the boat). No gameplay effect.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Landmark {
    pub name: String,
    pub kind: String,
    pub pos: Vec3,
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
    #[serde(default)]
    pub name: String,
    /// Where open water begins beyond the quay (x), if any — drawn by the client.
    #[serde(default)]
    pub sea_x: Option<f32>,
    #[serde(default)]
    pub landmarks: Vec<Landmark>,
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
        for b in self.boxes.iter().filter(|b| !b.player_only) {
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
        let c = |x: f32, z: f32, w: f32, d: f32, h: f32| Aabb::new(Vec3::new(x - w / 2.0, 0.0, z - d / 2.0), Vec3::new(x + w / 2.0, h, z + d / 2.0));
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
            name: "Yard".into(),
            sea_x: None,
            landmarks: vec![],
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

#[derive(Deserialize)]
struct HarbourDump {
    boxes: Vec<DumpBox>,
    #[serde(rename = "playerStart")]
    player_start: DumpSpawn,
    spawns: Vec<DumpSpawn>,
    objectives: Vec<DumpObjective>,
    extraction: Option<DumpSpawn>,
}
#[derive(Deserialize)]
struct DumpBox {
    min: [f32; 3],
    max: [f32; 3],
    surface: String,
    #[serde(rename = "playerOnly", default)]
    player_only: bool,
    #[serde(rename = "bulletOnly", default)]
    bullet_only: bool,
}
#[derive(Deserialize)]
struct DumpSpawn {
    pos: [f32; 3],
    #[serde(rename = "type", default)]
    kind: Option<String>,
}
#[derive(Deserialize)]
struct DumpObjective {
    pos: [f32; 3],
    label: String,
}

impl Map {
    /// "Saltline Terminal": the original game's harbour, collision taken from its level
    /// (557 boxes), with its ground spawns, relays and quay.
    pub fn harbour() -> Self {
        let d: HarbourDump = serde_json::from_str(include_str!("harbour.json")).expect("harbour.json");
        let (min, max) = (Vec3::new(-39.0, 0.0, -29.5), Vec3::new(30.6, 30.0, 29.5));
        let boxes: Vec<Aabb> = d
            .boxes
            .iter()
            .filter(|b| !b.bullet_only)
            .map(|b| Aabb {
                min: Vec3::from(b.min),
                max: Vec3::from(b.max),
                player_only: b.player_only,
                surface: match b.surface.as_str() {
                    "metal" => Surface::Metal,
                    "wood" => Surface::Wood,
                    "rubber" => Surface::Rubber,
                    "dirt" => Surface::Dirt,
                    _ => Surface::Concrete,
                },
            })
            .collect();
        let mut map = Map { min, max, boxes, spawns: vec![], name: "Saltline Terminal".into(), sea_x: Some(31.0), landmarks: vec![] };
        let centre = Vec3::new(-4.0, 0.0, 0.0);
        let mut spawns: Vec<Spawn> = std::iter::once(&d.player_start)
            .chain(d.spawns.iter().filter(|s| s.kind.as_deref() != Some("air")))
            .map(|s| Vec3::new(s.pos[0], 0.0, s.pos[2]))
            .filter(|p| p.x > min.x + 1.0 && p.x < max.x - 1.0 && p.z > min.z + 1.0 && p.z < max.z - 1.0)
            .filter(|p| !map.overlaps(*p, crate::PLAYER_RADIUS + 0.05, crate::PLAYER_HEIGHT))
            .map(|p| {
                let d = centre - p;
                Spawn { pos: p, yaw: (-d.x).atan2(-d.z) }
            })
            .collect();
        spawns.dedup_by(|a, b| a.pos.distance(b.pos) < 3.0);
        map.spawns = spawns;
        map.landmarks = d
            .objectives
            .iter()
            .map(|o| Landmark { name: o.label.clone(), kind: "relay".into(), pos: Vec3::from(o.pos) })
            .chain(d.extraction.iter().map(|e| Landmark { name: "Boat".into(), kind: "boat".into(), pos: Vec3::from(e.pos) }))
            .collect();
        map
    }

    pub fn by_name(name: &str) -> Self {
        match name {
            "yard" => Self::yard(),
            _ => Self::harbour(),
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

    #[test]
    fn harbour_loads_with_spawns_in_the_open() {
        let m = Map::harbour();
        assert!(m.boxes.len() > 500, "{} boxes", m.boxes.len());
        assert!(m.spawns.len() >= 8, "{} spawns", m.spawns.len());
        for s in &m.spawns {
            assert!(!m.overlaps(s.pos, crate::PLAYER_RADIUS, crate::PLAYER_HEIGHT), "spawn inside geometry at {:?}", s.pos);
        }
        assert_eq!(m.landmarks.iter().filter(|l| l.kind == "relay").count(), 3);
    }
}
