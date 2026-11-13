// Other players' movement sounds: footsteps, jumps, landings and climbs.
//
// How it works (see the "Footstep audio" research doc):
//   - every way of moving has a hearing distance; past it the sound is cut off entirely,
//   - volume stays strong nearby and fades fast toward the edge; distant steps lose some treble,
//   - every sound plays in 3D with head-related panning (HRTF): front/back and above/below are audible,
//   - walls muffle: a ray from your head to the walker's chest; blocked = half volume and dull (900 Hz),
//     blocked and over 2 m above or below you (on or in a container) = through-the-floor (500 Hz),
//   - enemies first: teammates are quieter and carry half as far (setting: normal / quiet / off);
//     at most 4 enemy steps play at once, and the quietest (after a boost for enemies facing you) gives way,
//   - an enemy step within 15 m briefly lowers the ambience (sea, wind, rain) so it is not drowned out.
// Distances are in metres. Volumes are linear gain before the effects slider.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Move = "sprint" | "walk" | "crouch" | "climb" | "land" | "jump";
export interface Hearing { range: number; gain: number }

/** How far each movement is heard by an enemy, and its volume at 1 m. */
export const HEAR: Record<Move, Hearing> = {
  sprint: { range: 32, gain: 1.0 },
  land: { range: 24, gain: 1.0 },
  walk: { range: 18, gain: 0.7 },
  climb: { range: 12, gain: 0.6 },
  jump: { range: 10, gain: 0.45 },
  crouch: { range: 5, gain: 0.3 },
};
/** Teammates' volume and hearing distance relative to an enemy's, per setting ("off" = never heard). */
export type TeamMode = "normal" | "quiet" | "off";
export const TEAM_MODES: Record<TeamMode, Hearing | null> = {
  normal: { gain: 0.7, range: 1 },
  quiet: { gain: 0.4, range: 0.5 },
  off: null,
};
export const TEAMMATE = TEAM_MODES.quiet!;
/** Enemy steps closer than this lower the ambience. */
export const DUCK_RANGE = 15;
export const MAX_ENEMY_VOICES = 4;
export const MAX_TEAM_VOICES = 2;
/** Slower than this is standing still: silent. Faster than SPRINT is a sprint. */
export const STILL = 0.8;
export const SPRINT = 5;
/** Falls faster than this (m/s) make a landing sound. */
export const LAND_SPEED = 4;

/** Volume left at distance d of a sound heard up to R: (1 - (d/R)^2)^1.5, zero from R on. */
export function falloff(d: number, R: number): number {
  if (!(R > 0) || d >= R) return 0;
  const x = Math.max(0, d) / R;
  return Math.pow(1 - x * x, 1.5);
}

/** Low-pass cutoff (Hz): full treble up close, down to 3 kHz at the edge of hearing. */
export function treble(d: number, R: number): number {
  const x = Math.min(1, Math.max(0, d) / R);
  return Math.round(16000 * Math.pow(3000 / 16000, x));
}

export function moveOf(speed: number, crouch: boolean): Move | null {
  if (speed < STILL) return null;
  if (crouch) return "crouch";
  return speed > SPRINT ? "sprint" : "walk";
}

/** A landing's hearing scales with how hard it was: 0.7x to 1.3x of the table, by fall speed. */
export function landing(fall: number): Hearing {
  const k = Math.min(1.3, Math.max(0.7, fall / 7));
  return { range: HEAR.land.range * k, gain: Math.min(1, HEAR.land.gain * 0.75 * k) };
}

export interface StepPlan { gain: number; lp: number; score: number }

/** What a wall or floor between us does: volume factor and low-pass cutoff (Hz). */
export interface Muffle { k: number; lp: number }
export const OPEN: Muffle = { k: 1, lp: 22000 };
export const WALL: Muffle = { k: 0.5, lp: 900 };
export const FLOOR: Muffle = { k: 0.5, lp: 500 };
export function muffle(blocked: boolean, dy: number): Muffle {
  if (!blocked) return OPEN;
  return Math.abs(dy) > 2 ? FLOOR : WALL;
}

/** What a sound should be at this distance, or null when it is out of earshot. */
export function plan(h: Hearing, dist: number, ally: boolean, facing: boolean, team: Hearing | null = TEAMMATE, m: Muffle = OPEN, volume = 1): StepPlan | null {
  if (ally && !team) return null;
  const R = h.range * (ally ? team!.range : 1);
  const gain = h.gain * falloff(dist, R) * (ally ? team!.gain : 1) * m.k * volume;
  if (gain < 0.01) return null;
  return { gain, lp: Math.min(treble(dist, R), m.lp), score: gain * (facing ? 1.5 : 1) };
}

/** Voice budget: at most N steps at once per side; a louder (or more threatening) one displaces the quietest. */
export class StepMixer {
  private active: { end: number; score: number; ally: boolean }[] = [];
  admit(now: number, score: number, ally: boolean, length = 0.3): boolean {
    this.active = this.active.filter((v) => v.end > now);
    const side = this.active.filter((v) => v.ally === ally);
    if (side.length >= (ally ? MAX_TEAM_VOICES : MAX_ENEMY_VOICES)) {
      let low = side[0];
      for (const v of side) if (v.score < low.score) low = v;
      if (score <= low.score) return false;
      this.active.splice(this.active.indexOf(low), 1);
    }
    this.active.push({ end: now + length, score, ally });
    return true;
  }
  get playing() { return this.active.length; }
}

const STEP_SOUND: Record<string, string> = { metal: "step_metal", water: "step_water" };

interface Body { air: boolean; minVy: number }

/**
 * Plays other players' movement sounds through the game's audio engine.
 * `listener` is the camera position; `facing(id)` says whether that player looks at us.
 */
export class Footsteps {
  readonly mixer = new StepMixer();
  private bodies = new Map<number, Body>();
  /** Last sounds played, newest last (for tests and debugging). */
  readonly log: { id: number; what: string; move: Move; dist: number; gain: number; lp: number; ally: boolean; muffled: string }[] = [];
  /** Settings: overall volume (0..1.5) and how teammates sound. */
  volume = 1;
  team: TeamMode = "quiet";
  /** Called when an enemy sound plays within DUCK_RANGE (the bridge lowers the ambience). */
  onNearEnemy: ((dist: number) => void) | null = null;
  private walls = new Map<number, { t: number; m: Muffle }>();

  constructor(private G: any) {}

  /** Is there level geometry between our head and the walker's chest? Cached 100 ms per player. */
  private muffleFor(id: number, feet: number[], listener: { x: number; y: number; z: number }): Muffle {
    const now = performance.now();
    const c = this.walls.get(id);
    if (c && now - c.t < 100) return c.m;
    let m = OPEN;
    try {
      const T = this.G.THREE, ph = this.G.physics;
      if (ph && ph.raycast) {
        const from = new T.Vector3(listener.x, listener.y, listener.z);
        const to = new T.Vector3(feet[0], feet[1] + 1.0, feet[2]);
        const dir = to.clone().sub(from);
        const len = dir.length();
        if (len > 0.5) {
          dir.divideScalar(len);
          const hit = ph.raycast(from, dir, len);
          m = muffle(!!hit && hit.dist < len - 0.4, to.y - from.y);
        }
      }
    } catch { /* no physics: assume open */ }
    this.walls.set(id, { t: now, m });
    return m;
  }

  private surfaceAt(x: number, z: number): string {
    const G = this.G;
    try {
      if (G.ground && G.ground.isPuddle && G.ground.isPuddle(x, z)) return "water";
      return (G.level && G.level.groundSurfaceAt && G.level.groundSurfaceAt(x, z)) || "concrete";
    } catch {
      return "concrete";
    }
  }

  private play(id: number, what: string, move: Move, h: Hearing, pos: number[], listener: { x: number; y: number; z: number }, ally: boolean, facing: boolean, extra: Record<string, unknown> = {}): boolean {
    const dist = Math.hypot(pos[0] - listener.x, pos[1] - listener.y, pos[2] - listener.z);
    const team = TEAM_MODES[this.team];
    // Out of earshot even unmuffled: skip the raycast.
    if (!plan(h, dist, ally, facing, team, OPEN, this.volume)) return false;
    const m = this.muffleFor(id, pos, listener);
    const p = plan(h, dist, ally, facing, team, m, this.volume);
    if (!p) return false;
    if (!this.mixer.admit(performance.now() / 1000, p.score, ally)) return false;
    const T = this.G.THREE;
    try {
      this.G.audio.play(what, {
        pos: new T.Vector3(pos[0], pos[1], pos[2]),
        world: true, hrtf: true, roll: 0, lp: p.lp,
        gain: p.gain, max: 8, pri: ally ? 3 : 6, jitter: 0.08, ...extra,
      });
    } catch { /* audio optional */ }
    if (!ally && dist < DUCK_RANGE && this.onNearEnemy) {
      try { this.onNearEnemy(dist); } catch { /* */ }
    }
    this.log.push({ id, what, move, dist: Math.round(dist * 10) / 10, gain: Math.round(p.gain * 1000) / 1000, lp: p.lp, ally, muffled: m === FLOOR ? "floor" : m === WALL ? "wall" : "" });
    if (this.log.length > 40) this.log.shift();
    return true;
  }

  /** One footfall (one foot) of a remote player. */
  step(id: number, pose: { pos: number[]; crouch: boolean; alive: boolean; climb: boolean }, speed: number, listener: { x: number; y: number; z: number }, ally: boolean, facing: boolean) {
    if (!pose.alive || pose.climb) return;
    const b = this.bodies.get(id);
    if (b && b.air) return; // no footfalls in mid-air
    const move = moveOf(speed, pose.crouch);
    if (!move) return;
    const [x, y, z] = pose.pos;
    const surface = this.surfaceAt(x, z);
    this.play(id, STEP_SOUND[surface] || "step_concrete", move, HEAR[move], [x, y + 0.05, z], listener, ally, facing, { pitch: move === "sprint" ? 1.05 : 1 });
  }

  /**
   * Called every frame per remote player: spots jumps, landings and climbs from the server's
   * vertical speed (exactly 0 on the ground), interpolated like the rest of the pose.
   */
  track(id: number, pose: { pos: number[]; alive: boolean; climb: boolean; vy: number }, climbStarted: boolean, listener: { x: number; y: number; z: number }, ally: boolean, facing: boolean) {
    let b = this.bodies.get(id);
    if (!b) { b = { air: false, minVy: 0 }; this.bodies.set(id, b); }
    if (!pose.alive) { b.air = false; b.minVy = 0; return; }
    const vy = pose.vy;
    const pos = [pose.pos[0], pose.pos[1] + 0.05, pose.pos[2]];
    if (climbStarted) {
      b.air = false;
      b.minVy = 0;
      this.play(id, "land", "climb", HEAR.climb, pos, listener, ally, facing, { pitch: 1.25 });
      return;
    }
    if (pose.climb) { b.air = false; return; }
    if (!b.air) {
      if (vy > 2.5) {
        b.air = true;
        b.minVy = 0;
        this.play(id, "jump", "jump", HEAR.jump, pos, listener, ally, facing);
      } else if (vy < -1) {
        b.air = true; // walked off a ledge
        b.minVy = vy;
      }
    } else {
      b.minVy = Math.min(b.minVy, vy);
      if (Math.abs(vy) < 0.05) {
        b.air = false;
        const fall = -b.minVy;
        if (fall > LAND_SPEED) {
          const water = this.surfaceAt(pose.pos[0], pose.pos[2]) === "water";
          this.play(id, water ? "step_water" : "land", "land", landing(fall), pos, listener, ally, facing, { pitch: 0.95 });
        }
      }
    }
  }

  forget(id: number) { this.bodies.delete(id); this.walls.delete(id); }
}
