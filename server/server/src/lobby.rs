//! Matchmaker: puts players into rooms of up to 8, tops public rooms up with bots so nobody
//! plays alone, removes bots as humans arrive, and closes rooms when the last human leaves.
//! Private rooms (made by a host, joined by code) never get automatic bots: their host decides.

use std::collections::BTreeMap;

use game_core::Map;
use protocol::{PlayerId, RoomConfig};
use tokio::sync::mpsc;

use crate::room::{Identity, MatchSummary, Room, MAX_PLAYERS};

const BOT_NAMES: [&str; 12] = [
    "Gull-07", "Hound-12", "Rivet", "Ballast", "Bollard", "Tidewater", "Kestrel", "Gantry", "Spindle", "Lantern", "Ferrous", "Pilot-3",
];

/// How a connection wants to play.
#[derive(Clone, Debug)]
pub enum JoinReq {
    /// Public matchmaking (free-for-all, ranked).
    Quick,
    /// Make a private room and host it.
    Create(RoomConfig),
    /// Join a private room by its code.
    Code(String),
}

const CODE_ABC: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn fresh_code(taken: impl Fn(&str) -> bool) -> String {
    use std::hash::{BuildHasher, Hasher};
    loop {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let mut x = h.finish();
        let code: String = (0..5)
            .map(|_| {
                let c = CODE_ABC[(x % CODE_ABC.len() as u64) as usize] as char;
                x /= CODE_ABC.len() as u64;
                c
            })
            .collect();
        if !taken(&code) {
            return code;
        }
    }
}

pub struct Lobby {
    pub rooms: BTreeMap<u64, Room>,
    next_room: u64,
    /// Rooms with at least one human are filled with bots up to this many players.
    pub min_players: usize,
    map: fn() -> Map,
    bot_counter: usize,
    /// Finished matches waiting for the account system (ratings, history, chain).
    pub finished: Vec<MatchSummary>,
    pub kill_target: u32,
    pub match_ticks: u32,
    pub spawn_near: bool,
}

impl Lobby {
    pub fn new(map: fn() -> Map, min_players: usize) -> Self {
        Self {
            rooms: BTreeMap::new(),
            next_room: 1,
            min_players: min_players.min(MAX_PLAYERS),
            map,
            bot_counter: 0,
            finished: Vec::new(),
            kill_target: crate::room::KILL_TARGET,
            match_ticks: crate::room::MATCH_TICKS,
            spawn_near: false,
        }
    }

    /// Place a player in public matchmaking (see `join_with`).
    pub fn join(&mut self, name: String, ident: Identity, tx: mpsc::UnboundedSender<String>) -> Result<(u64, PlayerId), String> {
        self.join_with(name, ident, tx, JoinReq::Quick)
    }

    /// Place a player: public matchmaking picks the busiest public room with a free slot (or opens
    /// one); `Create` opens a private room with a fresh code; `Code` joins that private room.
    pub fn join_with(&mut self, name: String, ident: Identity, tx: mpsc::UnboundedSender<String>, req: JoinReq) -> Result<(u64, PlayerId), String> {
        let room_id = match req {
            JoinReq::Quick => self
                .rooms
                .iter()
                .filter(|(_, r)| r.custom.is_none() && r.humans() < MAX_PLAYERS)
                .max_by_key(|(_, r)| r.humans())
                .map(|(id, _)| *id)
                .unwrap_or_else(|| {
                    let id = self.next_room;
                    self.next_room += 1;
                    let mut room = Room::new(id, (self.map)());
                    room.kill_target = self.kill_target;
                    room.match_ticks = self.match_ticks;
                    room.spawn_near = self.spawn_near;
                    self.rooms.insert(id, room);
                    id
                }),
            JoinReq::Create(config) => {
                let id = self.next_room;
                self.next_room += 1;
                let code = fresh_code(|c| self.rooms.values().any(|r| r.code() == Some(c)));
                let mut room = Room::new_custom(id, (self.map)(), code, config);
                room.spawn_near = self.spawn_near;
                self.rooms.insert(id, room);
                id
            }
            JoinReq::Code(code) => {
                let code = code.trim().to_uppercase();
                let Some((id, r)) = self.rooms.iter().find(|(_, r)| r.code() == Some(code.as_str())) else {
                    return Err(format!("no room with code {code}"));
                };
                if r.humans() >= MAX_PLAYERS {
                    return Err("that room is full".into());
                }
                *id
            }
        };
        let room = self.rooms.get_mut(&room_id).unwrap();
        let pid = room.join_as(name, ident, tx)?;
        Ok((room_id, pid))
    }

    /// Private-room commands from a player (team pick, host settings, host start).
    pub fn room_cmd(&mut self, room_id: u64, pid: PlayerId, msg: protocol::ClientMsg) -> Result<(), String> {
        let Some(room) = self.rooms.get_mut(&room_id) else { return Err("no room".into()) };
        if room.custom.is_none() {
            return Err("this is a public match".into());
        }
        match msg {
            protocol::ClientMsg::SetTeam { team } => {
                room.set_team(pid, team);
                Ok(())
            }
            protocol::ClientMsg::Configure { config } => room.configure(pid, config),
            protocol::ClientMsg::Start => room.start(pid),
            _ => Ok(()),
        }
    }

    pub fn leave(&mut self, room_id: u64, pid: PlayerId) {
        if let Some(room) = self.rooms.get_mut(&room_id) {
            room.leave(pid);
            if room.humans() == 0 {
                // Keep any finished match data, then close the room.
                let r = self.rooms.remove(&room_id).unwrap();
                self.finished.extend(r.finished);
            }
        }
    }

    pub fn push_inputs(&mut self, room_id: u64, pid: PlayerId, inputs: Vec<game_core::Input>) {
        if let Some(room) = self.rooms.get_mut(&room_id) {
            room.push_inputs(pid, inputs);
        }
    }

    pub fn step(&mut self) {
        for room in self.rooms.values_mut() {
            if room.humans() > 0 && room.custom.is_none() {
                while room.players.len() < self.min_players {
                    let name = BOT_NAMES[self.bot_counter % BOT_NAMES.len()].to_string();
                    let skill = 0.25 + ((self.bot_counter * 37) % 60) as f32 / 100.0;
                    self.bot_counter += 1;
                    if room.add_bot(name, skill).is_none() {
                        break;
                    }
                }
                while room.players.len() > self.min_players.max(room.humans()) && room.bots() > 0 {
                    room.remove_one_bot();
                }
            }
            room.step();
            self.finished.append(&mut room.finished);
        }
    }

    pub fn room_mut(&mut self, id: u64) -> Option<&mut Room> {
        self.rooms.get_mut(&id)
    }

    pub fn stats(&self) -> (usize, usize, usize) {
        let humans = self.rooms.values().map(|r| r.humans()).sum();
        let bots = self.rooms.values().map(|r| r.bots()).sum();
        (self.rooms.len(), humans, bots)
    }
}
