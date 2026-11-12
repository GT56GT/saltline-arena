//! Saltline Arena authoritative match server (phase-1 prototype: one free-for-all room).
//!
//! Trust model: a client may only send *inputs*. The room simulates every player with the
//! shared `game-core` rules, decides every shot with lag compensation, and broadcasts the
//! result. A client cannot claim a position, a hit or a kill, because no message exists for it.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use game_core::{look_dir, map::Spawn, ray_vs_player, step_player, Input, Map, PlayerState, DT, RIFLE, TICK_HZ};
use glam::Vec3;
use protocol::{ClientMsg, PlayerId, PlayerSnap, ServerMsg};
use tokio::sync::mpsc;

pub const MAX_PLAYERS: usize = 8;
/// Inputs a client may have waiting; anything beyond is dropped (flooding gains nothing).
pub const MAX_QUEUED_INPUTS: usize = 8;
/// Furthest back in time a shot may be judged (lag compensation window), in ticks (200 ms).
pub const MAX_REWIND_TICKS: u32 = 6;
pub const RESPAWN_TICKS: u32 = 3 * TICK_HZ;
pub const KILL_TARGET: u32 = 30;
pub const MATCH_TICKS: u32 = 8 * 60 * TICK_HZ;
const HISTORY_TICKS: usize = 12;
const MAX_BAD_MESSAGES: u32 = 20;

struct Player {
    name: String,
    state: PlayerState,
    queue: VecDeque<Input>,
    last_seq: u32,
    applied_seq: u32,
    last_input: Input,
    kills: u32,
    deaths: u32,
    respawn_at: Option<u32>,
    tx: mpsc::UnboundedSender<String>,
}

pub struct Room {
    pub map: Map,
    pub tick: u32,
    match_start: u32,
    next_id: PlayerId,
    players: BTreeMap<PlayerId, Player>,
    /// Recent poses of every player, newest last, for rewinding shots.
    history: VecDeque<(u32, Vec<(PlayerId, PlayerState)>)>,
}

impl Room {
    pub fn new(map: Map) -> Self {
        Self { map, tick: 0, match_start: 0, next_id: 1, players: BTreeMap::new(), history: VecDeque::new() }
    }

    fn broadcast(&self, msg: &ServerMsg) {
        let s = msg.to_json();
        for p in self.players.values() {
            let _ = p.tx.send(s.clone());
        }
    }

    fn pick_spawn(&self) -> Spawn {
        // Farthest spawn from every living player.
        let enemies: Vec<Vec3> = self.players.values().filter(|p| p.state.alive).map(|p| p.state.pos).collect();
        self.map
            .spawns
            .iter()
            .max_by(|a, b| {
                let score = |s: &Spawn| enemies.iter().map(|e| e.distance(s.pos)).fold(f32::MAX, f32::min);
                score(a).total_cmp(&score(b))
            })
            .cloned()
            .unwrap_or(Spawn { pos: Vec3::ZERO, yaw: 0.0 })
    }

    pub fn join(&mut self, name: String, tx: mpsc::UnboundedSender<String>) -> Result<PlayerId, String> {
        if self.players.len() >= MAX_PLAYERS {
            return Err("room full".into());
        }
        let id = self.next_id;
        self.next_id += 1;
        let sp = self.pick_spawn();
        let _ = tx.send(ServerMsg::Welcome { id, tick: self.tick, tick_hz: TICK_HZ, kill_target: KILL_TARGET, map: self.map.clone() }.to_json());
        self.broadcast(&ServerMsg::Joined { id, name: name.clone() });
        self.players.insert(
            id,
            Player {
                name,
                state: PlayerState::spawn(sp.pos, sp.yaw),
                queue: VecDeque::new(),
                last_seq: 0,
                applied_seq: 0,
                last_input: Input { yaw: sp.yaw, ..Default::default() },
                kills: 0,
                deaths: 0,
                respawn_at: None,
                tx,
            },
        );
        Ok(id)
    }

    pub fn leave(&mut self, id: PlayerId) {
        if self.players.remove(&id).is_some() {
            self.broadcast(&ServerMsg::Left { id });
        }
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
            if !s.alive || s.fire_cd > 0.0 || s.reload_t > 0.0 || s.ammo == 0 {
                continue;
            }
            {
                let p = self.players.get_mut(&shooter).unwrap();
                p.state.ammo -= 1;
                p.state.fire_cd = RIFLE.interval;
                if p.state.ammo == 0 {
                    p.state.reload_t = RIFLE.reload_secs;
                }
            }
            let eye = s.eye();
            let dir = look_dir(s.yaw, s.pitch);
            let wall = self.map.raycast(eye, dir, RIFLE.range).unwrap_or(RIFLE.range);
            // Judge against where targets were when the shooter saw them (bounded rewind).
            let seen_tick = inp.view_tick.min(tick).max(tick.saturating_sub(MAX_REWIND_TICKS));
            let mut best: Option<(PlayerId, f32, bool)> = None;
            for (&tid, t) in &self.players {
                if tid == shooter || !t.state.alive {
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
            if let Some((tid, _, head)) = best {
                let dmg = RIFLE.damage * if head { RIFLE.head_mult } else { 1.0 };
                let t = self.players.get_mut(&tid).unwrap();
                t.state.health = (t.state.health - dmg).max(0.0);
                events.push(ServerMsg::Hit { shooter, target: tid, damage: dmg, head });
                if t.state.health <= 0.0 {
                    t.state.alive = false;
                    t.deaths += 1;
                    t.respawn_at = Some(tick + RESPAWN_TICKS);
                    self.players.get_mut(&shooter).unwrap().kills += 1;
                    events.push(ServerMsg::Kill { killer: shooter, victim: tid, head });
                }
            }
        }

        // 3. Respawns.
        for id in &ids {
            if self.players[id].respawn_at.is_some_and(|t| t <= tick) {
                let sp = self.pick_spawn();
                let p = self.players.get_mut(id).unwrap();
                p.state = PlayerState::spawn(sp.pos, sp.yaw);
                p.respawn_at = None;
                p.queue.clear();
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

        // 5. Match end: first to the kill target, or the clock runs out.
        let leader = self.players.iter().max_by_key(|(_, p)| p.kills).map(|(id, p)| (*id, p.kills));
        if leader.is_some_and(|(_, k)| k >= KILL_TARGET) || tick - self.match_start >= MATCH_TICKS {
            let scores = self.players.iter().map(|(id, p)| (*id, p.kills, p.deaths)).collect();
            self.broadcast(&ServerMsg::MatchEnd { winner: leader.filter(|(_, k)| *k > 0).map(|l| l.0), scores });
            self.reset_match();
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
            })
            .collect();
        for p in self.players.values() {
            let msg = ServerMsg::Snapshot {
                tick,
                ack: p.applied_seq,
                ammo: p.state.ammo,
                reloading: p.state.reload_t > 0.0,
                players: snaps.clone(),
            };
            let _ = p.tx.send(msg.to_json());
        }
    }

    fn reset_match(&mut self) {
        self.match_start = self.tick;
        let ids: Vec<PlayerId> = self.players.keys().copied().collect();
        for id in ids {
            let sp = self.pick_spawn();
            let p = self.players.get_mut(&id).unwrap();
            p.kills = 0;
            p.deaths = 0;
            p.respawn_at = None;
            p.state = PlayerState::spawn(sp.pos, sp.yaw);
        }
        self.history.clear();
    }

    /// Test/debug helper: current authoritative state of a player.
    pub fn state_of(&self, id: PlayerId) -> Option<PlayerState> {
        self.players.get(&id).map(|p| p.state)
    }

    /// Test helper: place a player (the server's own action, never a client's).
    pub fn teleport(&mut self, id: PlayerId, pos: Vec3, yaw: f32) {
        if let Some(p) = self.players.get_mut(&id) {
            p.state.pos = pos;
            p.state.yaw = yaw;
            p.state.vel = Vec3::ZERO;
            p.last_input.yaw = yaw;
        }
    }
}

pub type SharedRoom = Arc<Mutex<Room>>;

/// Run the tick loop and the WebSocket endpoint on `listener` until the process ends.
pub async fn serve(listener: tokio::net::TcpListener) {
    let room: SharedRoom = Arc::new(Mutex::new(Room::new(Map::yard())));
    spawn_ticker(room.clone());
    axum::serve(listener, router(room)).await.expect("server");
}

pub fn spawn_ticker(room: SharedRoom) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs_f32(DT));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            iv.tick().await;
            room.lock().unwrap().step();
        }
    });
}

pub fn router(room: SharedRoom) -> Router {
    Router::new()
        .route("/health", get(|| async { "saltline arena ok" }))
        .route("/ws", get(ws_upgrade))
        .with_state(room)
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(room): State<SharedRoom>) -> impl IntoResponse {
    ws.max_message_size(16 * 1024).on_upgrade(move |socket| client(socket, room))
}

fn clean_name(raw: &str) -> String {
    let s: String = raw.chars().filter(|c| c.is_alphanumeric() || " _.-".contains(*c)).take(16).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "Breacher".into() } else { s }
}

async fn client(socket: WebSocket, room: SharedRoom) {
    let (mut sink, mut stream) = socket.split();

    // The first message must be a Hello, within 5 seconds.
    let hello = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
    let name = match hello {
        Ok(Some(Ok(Message::Text(t)))) => match ClientMsg::parse(t.as_str()) {
            Some(ClientMsg::Hello { name }) => clean_name(&name),
            _ => return,
        },
        _ => return,
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let joined = room.lock().unwrap().join(name, tx.clone());
    let id = match joined {
        Ok(id) => id,
        Err(e) => {
            let _ = sink.send(Message::Text(ServerMsg::Error { msg: e }.to_json().into())).await;
            return;
        }
    };

    let writer = tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if sink.send(Message::Text(s.into())).await.is_err() {
                break;
            }
        }
    });

    let mut bad = 0u32;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        match ClientMsg::parse(text.as_str()) {
            Some(ClientMsg::Input { inputs }) => room.lock().unwrap().push_inputs(id, inputs),
            Some(ClientMsg::Ping { c }) => {
                let _ = tx.send(ServerMsg::Pong { c }.to_json());
            }
            Some(ClientMsg::Hello { .. }) | None => {
                bad += 1;
                let _ = tx.send(ServerMsg::Error { msg: "unexpected message".into() }.to_json());
                if bad > MAX_BAD_MESSAGES {
                    break;
                }
            }
        }
    }
    room.lock().unwrap().leave(id);
    writer.abort();
}
