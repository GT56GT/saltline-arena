//! Wire protocol. JSON for the prototype (easy to debug from the browser);
//! the same enums can switch to a binary codec later without touching game logic.
//!
//! Note what is NOT here: there is no client message that claims a position, a hit or a kill.

use game_core::{Input, Map};
use serde::{Deserialize, Serialize};

pub type PlayerId = u32;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message on a connection.
    Hello {
        name: String,
        /// Session token from wallet sign-in; absent = guest.
        #[serde(default)]
        token: Option<String>,
    },
    /// One or more ticks of input, oldest first.
    Input { inputs: Vec<Input> },
    Ping { c: u64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PlayerSnap {
    pub id: PlayerId,
    pub name: String,
    pub pos: [f32; 3],
    pub vel: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub crouch: bool,
    pub hp: f32,
    pub alive: bool,
    pub kills: u32,
    pub deaths: u32,
    #[serde(default)]
    pub bot: bool,
    /// Equipped cosmetic id (visual only).
    #[serde(default)]
    pub cosmetic: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent once on join, with the exact map the server simulates (the client draws and predicts on it).
    Welcome { id: PlayerId, tick: u32, tick_hz: u32, kill_target: u32, map: Map },
    /// Authoritative world state. `ack` = last input seq the server applied for this client
    /// (the client replays newer inputs on top of it for prediction).
    Snapshot { tick: u32, ack: u32, ammo: u32, reloading: bool, players: Vec<PlayerSnap> },
    Shot { shooter: PlayerId, from: [f32; 3], to: [f32; 3] },
    Hit { shooter: PlayerId, target: PlayerId, damage: f32, head: bool },
    Kill { killer: PlayerId, victim: PlayerId, head: bool },
    Respawn { id: PlayerId },
    Joined { id: PlayerId, name: String },
    Left { id: PlayerId },
    MatchEnd { winner: Option<PlayerId>, scores: Vec<(PlayerId, u32, u32)> },
    Pong { c: u64 },
    Error { msg: String },
}

impl ServerMsg {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server messages always serialize")
    }
}

impl ClientMsg {
    pub fn parse(s: &str) -> Option<Self> {
        serde_json::from_str(s).ok()
    }
}
