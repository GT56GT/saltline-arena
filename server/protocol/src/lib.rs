//! Wire protocol. JSON for the prototype (easy to debug from the browser);
//! the same enums can switch to a binary codec later without touching game logic.
//!
//! Note what is NOT here: there is no client message that claims a position, a hit or a kill.

use game_core::{Input, Map};
use serde::{Deserialize, Serialize};

pub type PlayerId = u32;

/// Settings for a private room. Only the host can change them, and only before the match starts.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RoomConfig {
    /// Two teams (A = 0, B = 1) instead of everyone for themselves.
    #[serde(default)]
    pub teams: bool,
    /// Free-for-all: how many bots join when the match starts (0 = none).
    #[serde(default)]
    pub bots: u8,
    /// Teams: when the host starts, bots fill the smaller side until both are even.
    #[serde(default)]
    pub balance_bots: bool,
    /// A bot takes over the slot of a player who leaves during the match.
    #[serde(default)]
    pub replace_leavers: bool,
    /// Teammates can hurt each other.
    #[serde(default)]
    pub friendly_fire: bool,
    #[serde(default = "default_kills")]
    pub kill_target: u32,
    #[serde(default = "default_minutes")]
    pub minutes: u32,
    /// Weapon damage in percent of normal (host's "damage" setting): 50..=150.
    #[serde(default = "default_damage")]
    pub damage: u32,
}
fn default_damage() -> u32 {
    100
}
fn default_kills() -> u32 {
    30
}
fn default_minutes() -> u32 {
    8
}
impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            teams: true,
            bots: 0,
            balance_bots: false,
            replace_leavers: false,
            friendly_fire: false,
            kill_target: 30,
            minutes: 8,
            damage: 100,
        }
    }
}
impl RoomConfig {
    /// Keep host-chosen numbers in sane ranges.
    pub fn clamped(mut self) -> Self {
        self.bots = self.bots.min(7);
        self.kill_target = self.kill_target.clamp(5, 100);
        self.minutes = self.minutes.clamp(2, 30);
        self.damage = self.damage.clamp(50, 150);
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First message on a connection.
    Hello {
        name: String,
        /// Session token from wallet sign-in; absent = guest.
        #[serde(default)]
        token: Option<String>,
        /// Join a private room by its code.
        #[serde(default)]
        room: Option<String>,
        /// Create a private room with these settings (the sender becomes its host).
        #[serde(default)]
        create: Option<RoomConfig>,
    },
    /// Private rooms, before the match: move to team 0 or 1.
    SetTeam {
        team: u8,
    },
    /// Host only, before the match: change the room settings.
    Configure {
        config: RoomConfig,
    },
    /// Host only: start the match (also restarts after one ends).
    Start,
    /// One or more ticks of input, oldest first.
    Input {
        inputs: Vec<Input>,
    },
    Ping {
        c: u64,
    },
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
    /// Team (0 or 1) in a team room.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<u8>,
    /// Climbing a ledge: [from x y z, to x y z, seconds in, total seconds].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mantle: Option<[f32; 8]>,
    /// Fog of war: this opponent is out of your sight and earshot. Only id, name, team and the
    /// scoreboard fields are real; position, velocity, aim, health and stance are zeroed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent once on join, with the exact map the server simulates (the client draws and predicts on it).
    Welcome {
        id: PlayerId,
        tick: u32,
        tick_hz: u32,
        kill_target: u32,
        map: Map,
    },
    /// Authoritative world state. `ack` = last input seq the server applied for this client
    /// (the client replays newer inputs on top of it for prediction).
    Snapshot {
        tick: u32,
        ack: u32,
        ammo: u32,
        reloading: bool,
        players: Vec<PlayerSnap>,
        /// Team rooms: kills per team this match.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        team_scores: Option<[u32; 2]>,
    },
    /// Private room state: sent on join and whenever the host, phase, settings or teams change.
    /// `live` = false is the warm-up before the host starts (nobody can be hurt).
    Room {
        code: String,
        host: PlayerId,
        live: bool,
        config: RoomConfig,
    },
    Shot {
        shooter: PlayerId,
        from: [f32; 3],
        to: [f32; 3],
    },
    Hit {
        shooter: PlayerId,
        target: PlayerId,
        damage: f32,
        head: bool,
    },
    Kill {
        killer: PlayerId,
        victim: PlayerId,
        head: bool,
    },
    Respawn {
        id: PlayerId,
    },
    Joined {
        id: PlayerId,
        name: String,
    },
    Left {
        id: PlayerId,
    },
    MatchEnd {
        winner: Option<PlayerId>,
        scores: Vec<(PlayerId, u32, u32)>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        winner_team: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        team_scores: Option<[u32; 2]>,
    },
    Pong {
        c: u64,
    },
    Error {
        msg: String,
    },
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
