//! Browser side of `game-core`: the client predicts its own movement with the exact rules the
//! server uses, then corrects itself whenever an authoritative snapshot arrives.
//!
//! Flow per tick: `apply(input)` moves the local player immediately (no input lag) and keeps
//! the input. Per snapshot: `reconcile(ack, server_state)` resets to the server's state and
//! replays every kept input newer than `ack`. If client and server agree, nothing visibly moves.

use std::collections::VecDeque;

use game_core::{step_player, Input, Map, PlayerState};
use glam::Vec3;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Predictor {
    map: Map,
    state: PlayerState,
    pending: VecDeque<Input>,
    /// How far the last correction moved us (metres) — useful for debugging desyncs.
    last_error: f32,
}

#[wasm_bindgen]
impl Predictor {
    /// `map_json` is the `map` field of the server's Welcome message.
    #[wasm_bindgen(constructor)]
    pub fn new(map_json: &str) -> Result<Predictor, JsValue> {
        let map: Map = serde_json::from_str(map_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Predictor { map, state: PlayerState::spawn(Vec3::ZERO, 0.0), pending: VecDeque::new(), last_error: 0.0 })
    }

    /// Predict one tick of local movement and remember the input for replay.
    #[allow(clippy::too_many_arguments)]
    pub fn apply(&mut self, seq: u32, mx: f32, mz: f32, yaw: f32, pitch: f32, jump: bool, sprint: bool, crouch: bool) {
        let input = Input { seq, mx, mz, yaw, pitch, jump, sprint, crouch, ..Default::default() };
        step_player(&mut self.state, &input, &self.map);
        self.pending.push_back(input);
        while self.pending.len() > 120 {
            self.pending.pop_front();
        }
    }

    /// Adopt the server's state for this player, then replay inputs it has not processed yet.
    #[allow(clippy::too_many_arguments)]
    pub fn reconcile(&mut self, ack: u32, x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, crouch: bool, alive: bool) {
        let before = self.state.pos;
        while self.pending.front().is_some_and(|i| i.seq <= ack) {
            self.pending.pop_front();
        }
        self.state.pos = Vec3::new(x, y, z);
        self.state.vel = Vec3::new(vx, vy, vz);
        self.state.crouching = crouch;
        self.state.alive = alive;
        self.state.on_ground = vy.abs() < 1e-4 && (y <= 1e-3 || self.map.floor_below(self.state.pos, game_core::PLAYER_RADIUS).is_some_and(|f| (f - y).abs() < 1e-3));
        if !alive {
            self.pending.clear();
        }
        for input in self.pending.iter() {
            step_player(&mut self.state, input, &self.map);
        }
        self.last_error = before.distance(self.state.pos);
    }

    pub fn x(&self) -> f32 { self.state.pos.x }
    pub fn y(&self) -> f32 { self.state.pos.y }
    pub fn z(&self) -> f32 { self.state.pos.z }
    pub fn eye_y(&self) -> f32 { self.state.eye().y }
    pub fn speed(&self) -> f32 { Vec3::new(self.state.vel.x, 0.0, self.state.vel.z).length() }
    pub fn last_error(&self) -> f32 { self.last_error }
    pub fn pending(&self) -> u32 { self.pending.len() as u32 }

    /// Distance to the first wall along a ray (for drawing the local tracer instantly).
    pub fn raycast(&self, ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32, max: f32) -> f32 {
        self.map.raycast(Vec3::new(ox, oy, oz), Vec3::new(dx, dy, dz).normalize_or_zero(), max).unwrap_or(max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconcile_with_agreeing_server_does_not_move_us() {
        let map = Map::yard();
        let json = serde_json::to_string(&map).unwrap();
        let mut client = Predictor::new(&json).unwrap();
        let mut server = PlayerState::spawn(Vec3::ZERO, 0.0);
        for seq in 1..=10 {
            client.apply(seq, 0.0, 1.0, 0.0, 0.0, false, false, false);
        }
        // Server has processed the first 6 inputs only (latency).
        for seq in 1..=6 {
            step_player(&mut server, &Input { seq, mz: 1.0, ..Default::default() }, &map);
        }
        let (px, pz) = (client.x(), client.z());
        client.reconcile(6, server.pos.x, server.pos.y, server.pos.z, server.vel.x, server.vel.y, server.vel.z, false, true);
        assert!((client.x() - px).abs() < 1e-4 && (client.z() - pz).abs() < 1e-4);
        assert_eq!(client.pending(), 4);
    }
}
