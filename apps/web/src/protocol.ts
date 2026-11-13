// Mirrors server/protocol/src/lib.rs. Keep the two in sync.

export type PlayerId = number;
export type V3 = [number, number, number];

export interface Aabb { min: V3; max: V3; player_only?: boolean; surface?: "concrete" | "metal" | "wood" | "rubber" | "dirt" }
export interface MapData {
  min: V3; max: V3; boxes: Aabb[]; spawns: { pos: V3; yaw: number }[];
  name?: string; sea_x?: number | null; landmarks?: { name: string; kind: string; pos: V3 }[];
}

export interface PlayerSnap {
  id: PlayerId; name: string; pos: V3; vel: V3; yaw: number; pitch: number;
  crouch: boolean; hp: number; alive: boolean; kills: number; deaths: number;
  bot?: boolean; cosmetic?: string | null; team?: number;
}

/** Private room settings (host only, before the match). Mirrors protocol::RoomConfig. */
export interface RoomConfig {
  teams: boolean; bots: number; balance_bots: boolean; replace_leavers: boolean;
  friendly_fire: boolean; kill_target: number; minutes: number;
}
export const DEFAULT_ROOM: RoomConfig = { teams: true, bots: 0, balance_bots: false, replace_leavers: false, friendly_fire: false, kill_target: 30, minutes: 8 };
export interface RoomState { code: string; host: PlayerId; live: boolean; config: RoomConfig }

export type ServerMsg =
  | { t: "welcome"; id: PlayerId; tick: number; tick_hz: number; kill_target: number; map: MapData }
  | { t: "snapshot"; tick: number; ack: number; ammo: number; reloading: boolean; players: PlayerSnap[]; team_scores?: [number, number] }
  | ({ t: "room" } & RoomState)
  | { t: "shot"; shooter: PlayerId; from: V3; to: V3 }
  | { t: "hit"; shooter: PlayerId; target: PlayerId; damage: number; head: boolean }
  | { t: "kill"; killer: PlayerId; victim: PlayerId; head: boolean }
  | { t: "respawn"; id: PlayerId }
  | { t: "joined"; id: PlayerId; name: string }
  | { t: "left"; id: PlayerId }
  | { t: "match_end"; winner: PlayerId | null; scores: [PlayerId, number, number][]; winner_team?: number | null; team_scores?: [number, number] }
  | { t: "pong"; c: number }
  | { t: "error"; msg: string };

export interface Input {
  seq: number; mx: number; mz: number; yaw: number; pitch: number;
  jump: boolean; sprint: boolean; crouch: boolean; fire: boolean; reload: boolean; view_tick: number;
}

/** Same as game_core::look_dir: yaw 0 looks toward -Z, positive pitch looks up. */
export function lookDir(yaw: number, pitch: number): V3 {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
