//! Weapon rules. The server enforces every number here; the client only animates them.

#[derive(Clone, Copy, Debug)]
pub struct Weapon {
    pub name: &'static str,
    pub damage: f32,
    pub head_mult: f32,
    /// Seconds between shots.
    pub interval: f32,
    pub mag: u32,
    /// Reload with rounds still in the magazine.
    pub reload_secs: f32,
    /// Reload from empty (the bolt has to be racked too).
    pub reload_empty_secs: f32,
    pub range: f32,
}

pub const RIFLE: Weapon = Weapon {
    name: "FAC-9 Longbore",
    damage: 25.0,
    head_mult: 2.0,
    // 720 rounds a minute, 2.1 s tactical / 2.72 s empty reload: the original PAC-9's numbers.
    interval: 60.0 / 720.0,
    mag: 30,
    reload_secs: 2.1,
    reload_empty_secs: 2.72,
    range: 200.0,
};

impl Weapon {
    pub fn reload_time(&self, ammo_left: u32) -> f32 {
        if ammo_left == 0 { self.reload_empty_secs } else { self.reload_secs }
    }
}
