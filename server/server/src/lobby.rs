//! Matchmaker: puts players into rooms of up to 8, tops rooms up with bots so nobody plays
//! alone, removes bots as humans arrive, and closes rooms when the last human leaves.

use std::collections::BTreeMap;

use game_core::Map;
use protocol::PlayerId;
use tokio::sync::mpsc;

use crate::room::{Identity, MatchSummary, Room, MAX_PLAYERS};

const BOT_NAMES: [&str; 12] = [
    "Gull-07", "Hound-12", "Rivet", "Ballast", "Bollard", "Tidewater", "Kestrel", "Gantry", "Spindle", "Lantern", "Ferrous", "Pilot-3",
];

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

    /// Place a player: the busiest room that still has a human slot, or a fresh room.
    pub fn join(&mut self, name: String, ident: Identity, tx: mpsc::UnboundedSender<String>) -> Result<(u64, PlayerId), String> {
        let room_id = self
            .rooms
            .iter()
            .filter(|(_, r)| r.humans() < MAX_PLAYERS)
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
            });
        let room = self.rooms.get_mut(&room_id).unwrap();
        let pid = room.join_as(name, ident, tx)?;
        Ok((room_id, pid))
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
            if room.humans() > 0 {
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
