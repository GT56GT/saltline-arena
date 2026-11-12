//! Weapon rules. The server enforces every number here; the client only animates them.

#[derive(Clone, Copy, Debug)]
pub struct Weapon {
    pub name: &'static str,
    pub damage: f32,
    pub head_mult: f32,
    /// Seconds between shots.
    pub interval: f32,
    pub mag: u32,
    pub reload_secs: f32,
    pub range: f32,
}

pub const RIFLE: Weapon = Weapon {
    name: "FAC-9 Longbore",
    damage: 25.0,
    head_mult: 2.0,
    interval: 0.1,
    mag: 30,
    reload_secs: 2.0,
    range: 200.0,
};
