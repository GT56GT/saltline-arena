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
    /// Full damage out to this distance (metres)...
    pub falloff_start: f32,
    /// ...then a straight line down to `falloff_min` of it at this distance and beyond.
    pub falloff_end: f32,
    pub falloff_min: f32,
}

pub const RIFLE: Weapon = Weapon {
    name: "FAC-9 Longbore",
    // Six body shots or four to the head (about half a second of sustained fire): a fair
    // fight with time to react, instead of the old four-shot 0.25 s kills.
    damage: 18.0,
    head_mult: 1.75,
    // 720 rounds a minute, 2.1 s tactical / 2.72 s empty reload: the original PAC-9's numbers.
    interval: 60.0 / 720.0,
    mag: 30,
    reload_secs: 2.1,
    reload_empty_secs: 2.72,
    range: 200.0,
    falloff_start: 25.0,
    falloff_end: 60.0,
    falloff_min: 0.65,
};

impl Weapon {
    /// Damage for a hit at `dist` metres, before the room's damage setting.
    pub fn damage_at(&self, dist: f32, head: bool) -> f32 {
        let t = ((dist - self.falloff_start) / (self.falloff_end - self.falloff_start)).clamp(0.0, 1.0);
        let fall = 1.0 + (self.falloff_min - 1.0) * t;
        self.damage * fall * if head { self.head_mult } else { 1.0 }
    }

    pub fn reload_time(&self, ammo_left: u32) -> f32 {
        if ammo_left == 0 { self.reload_empty_secs } else { self.reload_secs }
    }
}

#[cfg(test)]
mod tests {
    use super::RIFLE;

    #[test]
    fn damage_falls_off_with_range() {
        assert_eq!(RIFLE.damage_at(10.0, false), 18.0);
        assert_eq!(RIFLE.damage_at(10.0, true), 31.5);
        let far = RIFLE.damage_at(80.0, false);
        assert!((far - 18.0 * 0.65).abs() < 1e-4, "{far}");
        let mid = RIFLE.damage_at(42.5, false);
        assert!(mid < 18.0 && mid > far);
        // Six body shots or four headshots up close.
        assert_eq!((100.0 / RIFLE.damage_at(5.0, false)).ceil() as u32, 6);
        assert_eq!((100.0 / RIFLE.damage_at(5.0, true)).ceil() as u32, 4);
    }
}
