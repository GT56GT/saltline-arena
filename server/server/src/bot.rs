//! Server-side bots. A bot produces the same `Input` a human client would, so it obeys every
//! rule (speed, fire rate, line of sight, ammo) through the same code path. It only "sees"
//! players it has line of sight to, reacts after a delay, and aims with a decaying error.

use game_core::{Input, Map, PlayerState, TICK_HZ};
use glam::Vec3;
use protocol::PlayerId;

pub struct Brain {
    /// 0 = clumsy, 1 = sharp.
    skill: f32,
    rng: u64,
    target: Option<PlayerId>,
    react_until: u32,
    err_yaw: f32,
    err_pitch: f32,
    strafe: f32,
    strafe_until: u32,
    burst_until: u32,
    pause_until: u32,
    waypoint: Option<Vec3>,
    last_pos: Vec3,
    stuck_ticks: u32,
    attacker: Option<(PlayerId, u32)>,
    yaw: f32,
}

impl Brain {
    pub fn new(skill: f32, seed: u64) -> Self {
        Self {
            skill: skill.clamp(0.0, 1.0),
            rng: seed | 1,
            target: None,
            react_until: 0,
            err_yaw: 0.0,
            err_pitch: 0.0,
            strafe: 1.0,
            strafe_until: 0,
            burst_until: 0,
            pause_until: 0,
            waypoint: None,
            last_pos: Vec3::ZERO,
            stuck_ticks: 0,
            attacker: None,
            yaw: 0.0,
        }
    }

    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        ((self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32) / (1u64 << 24) as f32
    }
    fn signed(&mut self) -> f32 {
        self.rand() * 2.0 - 1.0
    }

    pub fn hurt_by(&mut self, shooter: PlayerId, tick: u32) {
        self.attacker = Some((shooter, tick));
    }

    pub fn think(&mut self, me_id: PlayerId, me: &PlayerState, world: &[(PlayerId, PlayerState)], map: &Map, tick: u32, seq: u32) -> Input {
        let mut inp = Input { seq, yaw: self.yaw, view_tick: tick, ..Default::default() };
        if !me.alive {
            self.target = None;
            self.waypoint = None;
            return inp;
        }
        let eye = me.eye();

        // --- who can I see? Prefer whoever is shooting me, else the nearest.
        let visible = |id: PlayerId, s: &PlayerState| -> Option<f32> {
            if id == me_id || !s.alive {
                return None;
            }
            let d = eye.distance(s.eye());
            (d < 65.0 && map.line_of_sight(eye, s.eye())).then_some(d)
        };
        let recent_attacker = self.attacker.filter(|(_, t)| tick.saturating_sub(*t) < 3 * TICK_HZ).map(|a| a.0);
        let mut pick: Option<(PlayerId, PlayerState, f32)> = None;
        for (id, s) in world {
            if let Some(d) = visible(*id, s) {
                let bias = if Some(*id) == recent_attacker { 0.5 } else { 1.0 };
                if pick.is_none_or(|(_, _, pd)| d * bias < pd) {
                    pick = Some((*id, *s, d * bias));
                }
            }
        }

        match pick {
            Some((tid, ts, _)) => {
                if self.target != Some(tid) {
                    // New target: reaction time and an initial aim error, both shrinking with skill.
                    self.target = Some(tid);
                    let react = (0.45 - 0.25 * self.skill) * TICK_HZ as f32;
                    self.react_until = tick + react as u32;
                    let spread = 0.28 * (1.0 - 0.6 * self.skill);
                    self.err_yaw = self.signed() * spread;
                    self.err_pitch = self.signed() * spread * 0.4;
                }
                let aim = ts.pos + Vec3::Y * if ts.crouching { 0.8 } else { 1.15 };
                let d = aim - eye;
                let flat = (d.x * d.x + d.z * d.z).sqrt();
                let want_yaw = (-d.x).atan2(-d.z);
                let want_pitch = d.y.atan2(flat.max(0.01));
                // Error decays as the bot tracks; a little tremor never fully goes away.
                let decay = 0.90 - 0.06 * self.skill;
                let tremor = 0.012 * (1.0 - self.skill) + 0.003;
                self.err_yaw = self.err_yaw * decay + self.signed() * tremor;
                self.err_pitch = self.err_pitch * decay + self.signed() * tremor * 0.5;
                self.yaw = want_yaw + self.err_yaw;
                inp.yaw = self.yaw;
                inp.pitch = want_pitch + self.err_pitch;

                // Fire in bursts once reacted and roughly on target.
                let on_target = self.err_yaw.abs() < 0.05 + 0.4 / flat.max(1.0) && self.err_pitch.abs() < 0.05;
                if tick >= self.react_until && on_target && tick >= self.pause_until {
                    if self.burst_until <= tick {
                        self.burst_until = tick + 5 + (self.rand() * 6.0) as u32;
                    }
                    inp.fire = true;
                    if tick + 1 >= self.burst_until {
                        self.pause_until = tick + 4 + (self.rand() * 8.0 * (1.2 - self.skill)) as u32;
                    }
                }

                // Strafe while fighting; close or open the range toward 10-24 m.
                if tick >= self.strafe_until {
                    self.strafe = if self.rand() < 0.5 { -1.0 } else { 1.0 };
                    self.strafe_until = tick + (0.5 + self.rand() * 1.0) as u32 * TICK_HZ / 2 + 12;
                }
                inp.mx = self.strafe;
                inp.mz = if flat > 24.0 { 1.0 } else if flat < 10.0 { -0.7 } else { 0.0 };
                inp.crouch = self.skill > 0.6 && flat > 30.0 && self.rand() < 0.02;
                self.waypoint = None;
            }
            None => {
                self.target = None;
                // Heard shots / got hit by someone unseen: turn toward them.
                if let Some(aid) = recent_attacker {
                    if let Some((_, a)) = world.iter().find(|(id, _)| *id == aid) {
                        let d = a.pos - me.pos;
                        self.yaw = (-d.x).atan2(-d.z);
                        self.waypoint = Some(a.pos);
                    }
                }
                // Wander between points of the yard.
                let reached = self.waypoint.is_some_and(|w| Vec3::new(w.x - me.pos.x, 0.0, w.z - me.pos.z).length() < 2.0);
                if self.waypoint.is_none() || reached {
                    let pick_spawn = !map.spawns.is_empty() && self.rand() < 0.5;
                    self.waypoint = Some(if pick_spawn {
                        let i = ((self.rand() * map.spawns.len() as f32) as usize).min(map.spawns.len() - 1);
                        map.spawns[i].pos
                    } else {
                        Vec3::new(
                            map.min.x + 3.0 + self.rand() * (map.max.x - map.min.x - 6.0),
                            0.0,
                            map.min.z + 3.0 + self.rand() * (map.max.z - map.min.z - 6.0),
                        )
                    });
                }
                let w = self.waypoint.unwrap();
                let d = w - me.pos;
                let want = (-d.x).atan2(-d.z);
                // Turn smoothly rather than snapping.
                let mut dy = want - self.yaw;
                dy = (dy + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI;
                self.yaw += dy.clamp(-0.18, 0.18);
                inp.yaw = self.yaw;
                inp.pitch = 0.0;
                inp.mz = 1.0;
                inp.sprint = dy.abs() < 0.3 && self.rand() < 0.6;
                inp.reload = me.ammo < 12;

                // Stuck against a container: jump, then choose somewhere else.
                if me.pos.distance(self.last_pos) < 0.04 {
                    self.stuck_ticks += 1;
                } else {
                    self.stuck_ticks = 0;
                }
                if self.stuck_ticks > 12 {
                    inp.jump = true;
                    self.waypoint = None;
                    self.yaw += std::f32::consts::FRAC_PI_2 * if self.rand() < 0.5 { 1.0 } else { -1.0 };
                    self.stuck_ticks = 0;
                }
            }
        }
        self.last_pos = me.pos;
        inp.sanitized()
    }
}
