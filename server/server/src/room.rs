//! One match: up to 8 players (humans and bots) simulated at 30 ticks/s.
//!
//! Trust model: a client may only send *inputs*. The room simulates every player with the
//! shared `game-core` rules, decides every shot with lag compensation, and broadcasts the
//! result. A client cannot claim a position, a hit or a kill: no message exists for it.

use std::collections::{BTreeMap, VecDeque};

use game_core::{look_dir, map::Spawn, ray_vs_player, step_player, Input, Map, PlayerState, RIFLE, TICK_HZ};
use glam::Vec3;
use protocol::{PlayerId, PlayerSnap, RoomConfig, ServerMsg};
use tokio::sync::mpsc;

use crate::bot::Brain;

pub const MAX_PLAYERS: usize = 8;
/// Inputs a client may have waiting; anything beyond is dropped (flooding gains nothing).
pub const MAX_QUEUED_INPUTS: usize = 8;
/// Furthest back in time a shot may be judged (lag compensation window), in ticks (200 ms).
pub const MAX_REWIND_TICKS: u32 = 6;
pub const RESPAWN_TICKS: u32 = 3 * TICK_HZ;
pub const KILL_TARGET: u32 = 30;
pub const MATCH_TICKS: u32 = 8 * 60 * TICK_HZ;
const HISTORY_TICKS: usize = 12;

/// Who a player is outside the match (filled in by the account system; `None` = guest or bot).
#[derive(Clone, Debug, Default)]
pub struct Identity {
    pub account: Option<i64>,
    pub wallet: Option<String>,
    pub cosmetic: Option<String>,
}

pub struct Player {
    pub name: String,
    pub ident: Identity,
    pub state: PlayerState,
    queue: VecDeque<Input>,
    last_seq: u32,
    applied_seq: u32,
    last_input: Input,
    pub kills: u32,
    pub deaths: u32,
    pub headshots: u32,
    pub best_streak: u32,
    streak: u32,
    respawn_at: Option<u32>,
    tx: Option<mpsc::UnboundedSender<String>>,
    pub brain: Option<Brain>,
    /// Team (0 or 1) in a team room.
    pub team: Option<u8>,
}

impl Player {
    pub fn is_bot(&self) -> bool {
        self.brain.is_some()
    }
}

/// What a finished match reports to the rest of the backend (ratings, history, chain).
#[derive(Clone, Debug)]
pub struct MatchSummary {
    pub room: u64,
    pub started_tick: u32,
    pub ended_tick: u32,
    /// (player, name, identity, kills, deaths, headshots, best streak, is_bot)
    pub players: Vec<(PlayerId, String, Identity, u32, u32, u32, u32, bool)>,
    /// Public matchmaking counts toward ratings; private rooms (any teams, bots or size) do not.
    pub ranked: bool,
}

/// A private room made by a host: join code, settings, and whether the match has started.
#[derive(Clone, Debug)]
pub struct Custom {
    pub code: String,
    pub host: PlayerId,
    pub config: RoomConfig,
    /// false = warm-up: players run around and shoot, nobody is hurt, the host can start.
    pub live: bool,
    pub team_kills: [u32; 2],
}

pub const BOT_NAMES: [&str; 12] = [
    "Bollard", "Tidewater", "Ballast", "Kestrel", "Spindle", "Hawser", "Gantry", "Rivet", "Cleat", "Dredge", "Marlin", "Sounder",
];

pub struct Room {
    pub id: u64,
    pub map: Map,
    pub tick: u32,
    match_start: u32,
    next_id: PlayerId,
    pub players: BTreeMap<PlayerId, Player>,
    history: VecDeque<(u32, Vec<(PlayerId, PlayerState)>)>,
    rng: u64,
    /// Finished matches waiting to be picked up by the lobby.
    pub finished: Vec<MatchSummary>,
    pub kill_target: u32,
    pub match_ticks: u32,
    /// Spawn next to the action instead of away from it (practice rooms and browser tests).
    pub spawn_near: bool,
    /// Present for private rooms only.
    pub custom: Option<Custom>,
    bot_counter: usize,
    end_now: bool,
}

impl Room {
    pub fn new(id: u64, map: Map) -> Self {
        Self {
            id,
            map,
            tick: 0,
            match_start: 0,
            next_id: 1,
            players: BTreeMap::new(),
            history: VecDeque::new(),
            rng: 0x9E37_79B9_7F4A_7C15 ^ id,
            finished: Vec::new(),
            kill_target: KILL_TARGET,
            match_ticks: MATCH_TICKS,
            spawn_near: false,
            custom: None,
            bot_counter: 0,
            end_now: false,
        }
    }

    /// A private room: the first player to join becomes the host.
    pub fn new_custom(id: u64, map: Map, code: String, config: RoomConfig) -> Self {
        let config = config.clamped();
        let mut r = Self::new(id, map);
        r.kill_target = config.kill_target;
        r.match_ticks = config.minutes * 60 * TICK_HZ;
        r.custom = Some(Custom { code, host: 0, config, live: false, team_kills: [0, 0] });
        r
    }

    pub fn code(&self) -> Option<&str> {
        self.custom.as_ref().map(|c| c.code.as_str())
    }
    fn teams_on(&self) -> bool {
        self.custom.as_ref().is_some_and(|c| c.config.teams)
    }
    /// Warm-up in a private room: nobody can be hurt and the score does not count.
    fn warmup(&self) -> bool {
        self.custom.as_ref().is_some_and(|c| !c.live)
    }
    pub fn team_size(&self, team: u8) -> usize {
        self.players.values().filter(|p| p.team == Some(team)).count()
    }
    fn smaller_team(&self) -> u8 {
        if self.team_size(1) < self.team_size(0) { 1 } else { 0 }
    }
    fn next_bot_name(&mut self) -> String {
        let used: Vec<String> = self.players.values().map(|p| p.name.clone()).collect();
        for _ in 0..BOT_NAMES.len() {
            let n = BOT_NAMES[self.bot_counter % BOT_NAMES.len()];
            self.bot_counter += 1;
            if !used.iter().any(|u| u == n) {
                return n.to_string();
            }
        }
        format!("Bot {}", self.bot_counter)
    }

    /// Tell everyone the private room's state (host, warm-up/live, settings).
    pub fn broadcast_room(&self) {
        if let Some(c) = &self.custom {
            self.broadcast(&ServerMsg::Room { code: c.code.clone(), host: c.host, live: c.live, config: c.config.clone() });
        }
    }

    fn is_host(&self, id: PlayerId) -> bool {
        self.custom.as_ref().is_some_and(|c| c.host == id)
    }

    /// Private room, before the match: switch team.
    pub fn set_team(&mut self, id: PlayerId, team: u8) {
        if !self.teams_on() || !self.warmup() || team > 1 {
            return;
        }
        if let Some(p) = self.players.get_mut(&id) {
            p.team = Some(team);
        }
        self.broadcast_room();
    }

    /// Host only, before the match: new settings. Bots leave; they come back on start if asked for.
    pub fn configure(&mut self, id: PlayerId, config: RoomConfig) -> Result<(), String> {
        if !self.is_host(id) {
            return Err("only the host can change the room".into());
        }
        if !self.warmup() {
            return Err("the match has already started".into());
        }
        let config = config.clamped();
        let was_teams = self.teams_on();
        while self.remove_one_bot() {}
        self.kill_target = config.kill_target;
        self.match_ticks = config.minutes * 60 * TICK_HZ;
        let teams = config.teams;
        if let Some(c) = self.custom.as_mut() {
            c.config = config;
        }
        if teams != was_teams {
            // Switching mode: everyone gets a fresh, even split (or no team at all).
            let ids: Vec<PlayerId> = self.players.keys().copied().collect();
            for (i, pid) in ids.into_iter().enumerate() {
                self.players.get_mut(&pid).unwrap().team = teams.then_some((i % 2) as u8);
            }
        }
        self.broadcast_room();
        Ok(())
    }

    /// Host only: start the match. Uneven teams are allowed; bots join only if the host asked.
    pub fn start(&mut self, id: PlayerId) -> Result<(), String> {
        if !self.is_host(id) {
            return Err("only the host can start the match".into());
        }
        if !self.warmup() {
            return Err("the match has already started".into());
        }
        let cfg = self.custom.as_ref().unwrap().config.clone();
        if cfg.teams {
            if cfg.balance_bots {
                while self.team_size(0) != self.team_size(1) && !self.is_full() {
                    let t = self.smaller_team();
                    let name = self.next_bot_name();
                    let Some(bid) = self.add_bot(name, 0.55) else { break };
                    self.players.get_mut(&bid).unwrap().team = Some(t);
                }
            }
            if self.team_size(0) == 0 || self.team_size(1) == 0 {
                return Err("each team needs at least one player (or turn on bots to fill the empty side)".into());
            }
        } else {
            for _ in 0..cfg.bots {
                let name = self.next_bot_name();
                if self.add_bot(name, 0.55).is_none() {
                    break;
                }
            }
            if self.players.len() < 2 {
                return Err("free-for-all needs at least two players (or add bots)".into());
            }
        }
        if let Some(c) = self.custom.as_mut() {
            c.live = true;
            c.team_kills = [0, 0];
        }
        self.reset_match();
        for id in self.players.keys().copied().collect::<Vec<_>>() {
            self.broadcast(&ServerMsg::Respawn { id });
        }
        self.broadcast_room();
        Ok(())
    }

    pub fn rand(&mut self) -> f32 {
        // xorshift64*: deterministic per room, good enough for bots and spawns.
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        ((self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32) / (1u64 << 24) as f32
    }

    pub fn humans(&self) -> usize {
        self.players.values().filter(|p| !p.is_bot()).count()
    }
    pub fn bots(&self) -> usize {
        self.players.values().filter(|p| p.is_bot()).count()
    }
    pub fn is_full(&self) -> bool {
        self.players.len() >= MAX_PLAYERS
    }

    pub(crate) fn broadcast(&self, msg: &ServerMsg) {
        let s = msg.to_json();
        for p in self.players.values() {
            if let Some(tx) = &p.tx {
                let _ = tx.send(s.clone());
            }
        }
    }

    /// Farthest spawn from every living enemy (in a team room: the other team), with a little
    /// randomness among the best.
    fn pick_spawn_for(&mut self, team: Option<u8>) -> Spawn {
        // In a team room, only the other team counts as danger.
        let enemies: Vec<Vec3> =
            self.players.values().filter(|p| p.state.alive && (team.is_none() || p.team != team)).map(|p| p.state.pos).collect();
        let mut scored: Vec<(f32, Spawn)> = self
            .map
            .spawns
            .iter()
            .map(|s| (enemies.iter().map(|e| e.distance(s.pos)).fold(60.0, f32::min), s.clone()))
            .collect();
        if self.spawn_near && !enemies.is_empty() {
            // Closest spawn that is not on top of someone (practice / tests).
            scored.retain(|(d, _)| *d > 4.0);
            scored.sort_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((_, s)) = scored.first() {
                return s.clone();
            }
            return Spawn { pos: Vec3::ZERO, yaw: 0.0 };
        }
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        if scored.is_empty() {
            return Spawn { pos: Vec3::ZERO, yaw: 0.0 };
        }
        let top = scored.len().min(2);
        let i = ((self.rand() * top as f32) as usize).min(top - 1);
        scored.swap_remove(i).1
    }

    fn insert(&mut self, name: String, ident: Identity, tx: Option<mpsc::UnboundedSender<String>>, brain: Option<Brain>) -> PlayerId {
        let id = self.next_id;
        self.next_id += 1;
        let team = self.teams_on().then(|| self.smaller_team());
        let sp = self.pick_spawn_for(team);
        if let Some(tx) = &tx {
            let _ = tx.send(
                ServerMsg::Welcome { id, tick: self.tick, tick_hz: TICK_HZ, kill_target: self.kill_target, map: self.map.clone() }.to_json(),
            );
        }
        self.broadcast(&ServerMsg::Joined { id, name: name.clone() });
        self.players.insert(
            id,
            Player {
                name,
                ident,
                state: PlayerState::spawn(sp.pos, sp.yaw),
                queue: VecDeque::new(),
                last_seq: 0,
                applied_seq: 0,
                last_input: Input { yaw: sp.yaw, ..Default::default() },
                kills: 0,
                deaths: 0,
                headshots: 0,
                best_streak: 0,
                streak: 0,
                respawn_at: None,
                tx,
                brain,
                team,
            },
        );
        if let Some(c) = self.custom.as_mut() {
            if c.host == 0 {
                c.host = id;
            }
        }
        self.broadcast_room();
        id
    }

    pub fn join(&mut self, name: String, tx: mpsc::UnboundedSender<String>) -> Result<PlayerId, String> {
        self.join_as(name, Identity::default(), tx)
    }

    pub fn join_as(&mut self, name: String, ident: Identity, tx: mpsc::UnboundedSender<String>) -> Result<PlayerId, String> {
        if self.is_full() && !self.remove_one_bot() {
            return Err("room full".into());
        }
        Ok(self.insert(name, ident, Some(tx), None))
    }

    pub fn add_bot(&mut self, name: String, skill: f32) -> Option<PlayerId> {
        if self.is_full() {
            return None;
        }
        let seed = (self.rand() * 1e6) as u64;
        Some(self.insert(name, Identity::default(), None, Some(Brain::new(skill, seed))))
    }

    pub fn remove_one_bot(&mut self) -> bool {
        let Some(id) = self.players.iter().find(|(_, p)| p.is_bot()).map(|(id, _)| *id) else { return false };
        self.leave(id);
        true
    }

    pub fn leave(&mut self, id: PlayerId) {
        let Some(gone) = self.players.remove(&id) else { return };
        self.broadcast(&ServerMsg::Left { id });
        let Some(c) = self.custom.clone() else { return };
        // A human leaving a live match: a bot takes the slot if the host asked for that.
        if c.live && c.config.replace_leavers && !gone.is_bot() && self.humans() > 0 {
            let name = self.next_bot_name();
            if let Some(bid) = self.add_bot(name, 0.55) {
                self.players.get_mut(&bid).unwrap().team = gone.team;
            }
        }
        // The host left: the longest-standing human takes over.
        if c.host == id {
            let next = self.players.iter().find(|(_, p)| !p.is_bot()).map(|(pid, _)| *pid).unwrap_or(0);
            self.custom.as_mut().unwrap().host = next;
        }
        self.broadcast_room();
    }

    /// Queue inputs from a client. Only strictly newer sequence numbers are accepted, and the
    /// queue is capped, so replaying or flooding inputs cannot make a player act more often.
    pub fn push_inputs(&mut self, id: PlayerId, inputs: Vec<Input>) {
        let Some(p) = self.players.get_mut(&id) else { return };
        for inp in inputs.into_iter().take(MAX_QUEUED_INPUTS) {
            if inp.seq <= p.last_seq {
                continue;
            }
            p.last_seq = inp.seq;
            if p.queue.len() < MAX_QUEUED_INPUTS {
                p.queue.push_back(inp.sanitized());
            }
        }
    }

    fn pose_at(&self, tick: u32, id: PlayerId) -> Option<PlayerState> {
        self.history
            .iter()
            .rev()
            .find(|(t, _)| *t <= tick)
            .and_then(|(_, poses)| poses.iter().find(|(pid, _)| *pid == id).map(|(_, s)| *s))
    }

    /// Advance the whole room by one tick.
    pub fn step(&mut self) {
        self.tick += 1;
        let tick = self.tick;
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        let mut events: Vec<ServerMsg> = Vec::new();

        // 0. Bots decide their input from what they can see (same rules, same input path as humans).
        let world: Vec<(PlayerId, PlayerState, Option<u8>)> = self.players.iter().map(|(id, p)| (*id, p.state, p.team)).collect();
        let teams_on = self.teams_on();
        for id in &ids {
            let p = self.players.get_mut(id).unwrap();
            if let Some(brain) = p.brain.as_mut() {
                let seq = p.last_seq + 1;
                // In a team room a bot only sees the other team as targets.
                let seen: Vec<(PlayerId, PlayerState)> = world
                    .iter()
                    .filter(|(wid, _, t)| *wid == *id || !teams_on || *t != p.team)
                    .map(|(wid, st, _)| (*wid, *st))
                    .collect();
                let inp = brain.think(*id, &p.state, &seen, &self.map, tick, seq);
                p.last_seq = seq;
                p.queue.push_back(inp);
            }
        }

        // 1. Movement: exactly one input per player per tick. If none arrived, repeat the last
        //    movement (never the trigger), so a lagging player keeps gliding, not stuttering.
        let mut fired: Vec<(PlayerId, Input)> = Vec::new();
        for id in &ids {
            let map = &self.map;
            let p = self.players.get_mut(id).unwrap();
            let inp = match p.queue.pop_front() {
                Some(i) => {
                    p.applied_seq = i.seq;
                    i
                }
                None => Input { fire: false, jump: false, reload: false, ..p.last_input },
            };
            p.last_input = inp;
            step_player(&mut p.state, &inp, map);
            if inp.fire {
                fired.push((*id, inp));
            }
        }

        // 2. Shots, judged on the server with lag compensation.
        for (shooter, inp) in fired {
            let s = self.players[&shooter].state;
            if !s.alive || s.fire_cd > 1e-4 || s.reload_t > 0.0 || s.ammo == 0 {
                continue;
            }
            {
                let p = self.players.get_mut(&shooter).unwrap();
                p.state.ammo -= 1;
                p.state.fire_cd = p.state.fire_cd.min(0.0) + RIFLE.interval;
                if p.state.ammo == 0 {
                    p.state.reload_t = RIFLE.reload_empty_secs;
                }
            }
            let eye = s.eye();
            let dir = look_dir(s.yaw, s.pitch);
            let wall = self.map.raycast(eye, dir, RIFLE.range).unwrap_or(RIFLE.range);
            let seen_tick = inp.view_tick.min(tick).max(tick.saturating_sub(MAX_REWIND_TICKS));
            let mut best: Option<(PlayerId, f32, bool)> = None;
            let shooter_team = self.players[&shooter].team;
            let ff = self.custom.as_ref().is_none_or(|c| c.config.friendly_fire);
            let warmup = self.warmup();
            for (&tid, t) in &self.players {
                if tid == shooter || !t.state.alive {
                    continue;
                }
                // Without friendly fire, rounds pass through teammates.
                if !ff && shooter_team.is_some() && t.team == shooter_team {
                    continue;
                }
                let pose = self.pose_at(seen_tick, tid).filter(|p| p.alive).unwrap_or(t.state);
                if let Some((dist, head)) = ray_vs_player(eye, dir, wall, &pose) {
                    if best.is_none_or(|(_, d, _)| dist < d) {
                        best = Some((tid, dist, head));
                    }
                }
            }
            let end = eye + dir * best.map(|b| b.1).unwrap_or(wall);
            events.push(ServerMsg::Shot { shooter, from: eye.to_array(), to: end.to_array() });
            if warmup {
                // Warm-up: the shot is drawn, nobody is hurt.
                continue;
            }
            if let Some((tid, _, head)) = best {
                let dmg = RIFLE.damage * if head { RIFLE.head_mult } else { 1.0 };
                let t = self.players.get_mut(&tid).unwrap();
                t.state.health = (t.state.health - dmg).max(0.0);
                if let Some(b) = t.brain.as_mut() {
                    b.hurt_by(shooter, tick);
                }
                events.push(ServerMsg::Hit { shooter, target: tid, damage: dmg, head });
                if t.state.health <= 0.0 {
                    t.state.alive = false;
                    t.deaths += 1;
                    t.streak = 0;
                    t.respawn_at = Some(tick + RESPAWN_TICKS);
                    let k = self.players.get_mut(&shooter).unwrap();
                    k.kills += 1;
                    k.streak += 1;
                    k.best_streak = k.best_streak.max(k.streak);
                    if head {
                        k.headshots += 1;
                    }
                    let (kt, vt) = (k.team, self.players[&tid].team);
                    if let (Some(c), Some(kt)) = (self.custom.as_mut(), kt) {
                        // A team kill does not score for the team.
                        if vt != Some(kt) {
                            c.team_kills[kt as usize] += 1;
                        }
                    }
                    events.push(ServerMsg::Kill { killer: shooter, victim: tid, head });
                }
            }
        }

        // 3. Respawns.
        for id in &ids {
            if self.players[id].respawn_at.is_some_and(|t| t <= tick) {
                let team = self.players[id].team;
                let sp = self.pick_spawn_for(team);
                let p = self.players.get_mut(id).unwrap();
                p.state = PlayerState::spawn(sp.pos, sp.yaw);
                p.respawn_at = None;
                p.queue.clear();
                p.last_input = Input { yaw: sp.yaw, ..Default::default() };
                events.push(ServerMsg::Respawn { id: *id });
            }
        }

        // 4. Remember poses for future rewinds.
        self.history.push_back((tick, self.players.iter().map(|(id, p)| (*id, p.state)).collect()));
        while self.history.len() > HISTORY_TICKS {
            self.history.pop_front();
        }

        for e in &events {
            self.broadcast(e);
        }

        // 5. Match end: first to the kill target (a player, or a team), or the clock runs out.
        // Same order as the recorded placings: most kills, then fewest deaths, then earliest joiner.
        let leader = self
            .players
            .iter()
            .min_by(|(ia, a), (ib, b)| b.kills.cmp(&a.kills).then(a.deaths.cmp(&b.deaths)).then(ia.cmp(ib)))
            .map(|(id, p)| (*id, p.kills));
        let team_scores = self.custom.as_ref().filter(|c| c.config.teams).map(|c| c.team_kills);
        let target_hit = match team_scores {
            Some(t) => t[0] >= self.kill_target || t[1] >= self.kill_target,
            None => leader.is_some_and(|(_, k)| k >= self.kill_target),
        };
        if self.warmup() {
            // Nothing counts before the host starts.
            self.match_start = tick;
            self.end_now = false;
        } else if self.end_now || target_hit || tick - self.match_start >= self.match_ticks {
            self.end_now = false;
            let scores = self.players.iter().map(|(id, p)| (*id, p.kills, p.deaths)).collect();
            let winner_team = team_scores.and_then(|t| match t[0].cmp(&t[1]) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => None,
            });
            let winner = if team_scores.is_some() { None } else { leader.filter(|(_, k)| *k > 0).map(|l| l.0) };
            self.broadcast(&ServerMsg::MatchEnd { winner, scores, winner_team, team_scores });
            self.finished.push(MatchSummary {
                room: self.id,
                started_tick: self.match_start,
                ended_tick: tick,
                players: self
                    .players
                    .iter()
                    .map(|(id, p)| (*id, p.name.clone(), p.ident.clone(), p.kills, p.deaths, p.headshots, p.best_streak, p.is_bot()))
                    .collect(),
                ranked: self.custom.is_none(),
            });
            self.reset_match();
            if self.custom.is_some() {
                // Back to warm-up: bots leave, the host can change settings and start again.
                while self.remove_one_bot() {}
                if let Some(c) = self.custom.as_mut() {
                    c.live = false;
                    c.team_kills = [0, 0];
                }
                self.broadcast_room();
            }
        }

        // 6. Per-player snapshot (ack + ammo are private to each player).
        let snaps: Vec<PlayerSnap> = self
            .players
            .iter()
            .map(|(id, p)| PlayerSnap {
                id: *id,
                name: p.name.clone(),
                pos: p.state.pos.to_array(),
                vel: p.state.vel.to_array(),
                yaw: p.state.yaw,
                pitch: p.state.pitch,
                crouch: p.state.crouching,
                hp: p.state.health,
                alive: p.state.alive,
                kills: p.kills,
                deaths: p.deaths,
                bot: p.is_bot(),
                cosmetic: p.ident.cosmetic.clone(),
                team: p.team,
            })
            .collect();
        let team_scores = self.custom.as_ref().filter(|c| c.config.teams).map(|c| c.team_kills);
        for p in self.players.values() {
            if let Some(tx) = &p.tx {
                let msg = ServerMsg::Snapshot {
                    tick,
                    ack: p.applied_seq,
                    ammo: p.state.ammo,
                    reloading: p.state.reload_t > 0.0,
                    players: snaps.clone(),
                    team_scores,
                };
                let _ = tx.send(msg.to_json());
            }
        }
    }

    fn reset_match(&mut self) {
        self.match_start = self.tick;
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        for id in ids {
            let team = self.players[&id].team;
            let sp = self.pick_spawn_for(team);
            let p = self.players.get_mut(&id).unwrap();
            p.kills = 0;
            p.deaths = 0;
            p.headshots = 0;
            p.best_streak = 0;
            p.streak = 0;
            p.respawn_at = None;
            p.state = PlayerState::spawn(sp.pos, sp.yaw);
        }
        self.history.clear();
    }

    /// Ends the current match now (used by tests and admin tools).
    pub fn force_end(&mut self) {
        self.end_now = true;
    }

    pub fn state_of(&self, id: PlayerId) -> Option<PlayerState> {
        self.players.get(&id).map(|p| p.state)
    }

    /// Place a player (the server's own action, never a client's). Used by tests and spawns.
    pub fn teleport(&mut self, id: PlayerId, pos: Vec3, yaw: f32) {
        if let Some(p) = self.players.get_mut(&id) {
            p.state.pos = pos;
            p.state.yaw = yaw;
            p.state.vel = Vec3::ZERO;
            p.last_input.yaw = yaw;
        }
    }
}
