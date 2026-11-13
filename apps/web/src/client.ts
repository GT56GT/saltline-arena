// The game client: networking, prediction and interpolation. No React and no rendering in here.
// The original Saltline renderer (see game/bridge.ts) feeds it input every frame and draws what
// it reports; the React overlay subscribes to a throttled change signal.

import init, { Predictor } from "./wasm/game_wasm.js";
import { type Input, type MapData, type PlayerId, type PlayerSnap, type RoomConfig, type RoomState, type ServerMsg, type V3 } from "./protocol";
import { api, session, type Me } from "./api";

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
/** Remote players are drawn this far in the past so there are always two snapshots to blend. */
export const INTERP_MS = 100;

let wasmReady: Promise<unknown> | null = null;

interface Pose { t: number; pos: V3; yaw: number; pitch: number; crouch: boolean; alive: boolean; climb: boolean; /** Vertical speed, m/s (0 on the ground). */ vy: number }
export interface Remote { id: PlayerId; name: string; buf: Pose[]; hp: number; alive: boolean; kills: number; deaths: number; firedAt: number; bot: boolean; cosmetic: string | null; team: number | null; /** Fog of war: the server is not telling us where they are. */ hidden: boolean }
/** How to enter: public matchmaking, a new private room (we host), or a room code. */
export type JoinRequest = { kind: "quick" } | { kind: "create"; config: RoomConfig } | { kind: "code"; code: string };
export const TEAM_NAMES = ["Harbour", "Rust"] as const;
export const TEAM_COLORS = ["#3fb6ad", "#e2733a"] as const;
export interface FeedLine { id: number; text: string; mine: boolean; t: number }
/** Things the renderer animates (sounds, tracers, hit markers, damage direction...). */
export type ClientEvent =
  | { t: "shot"; shooter: PlayerId; from: V3; to: V3 }
  | { t: "hit"; shooter: PlayerId; target: PlayerId; damage: number; head: boolean }
  | { t: "kill"; killer: PlayerId; victim: PlayerId; head: boolean; killerName: string; victimName: string }
  | { t: "joined"; name: string }
  | { t: "left"; name: string }
  | { t: "match_end"; winner: PlayerId | null; text: string; scores: [PlayerId, number, number][]; winnerTeam: number | null; teamScores: [number, number] | null }
  | { t: "room" };
/** What the player is asking to do this frame (read from the original game's input system). */
export interface ControlState { mx: number; mz: number; sprint: boolean; crouch: boolean; fire: boolean }

export class GameClient {
  ws: WebSocket | null = null;
  id: PlayerId = 0;
  name = "";
  map: MapData | null = null;
  predictor: Predictor | null = null;
  status: "idle" | "connecting" | "playing" | "closed" = "idle";
  error = "";
  killTarget = 30;

  // Local player, as the server last reported it.
  me = { hp: 100, alive: true, ammo: 30, reloading: false, kills: 0, deaths: 0, team: null as number | null };
  /** Private room (null in public matchmaking). */
  room: RoomState | null = null;
  teamScores: [number, number] | null = null;
  /** Bumped whenever the server puts us somewhere new (join, respawn, match start). */
  spawnSeq = 0;
  /** Last error the server sent (e.g. "only the host can start"), for the overlay. */
  notice = { text: "", t: -1 };
  private snapNext = false;
  lastTick = 0;
  rtt = 0;
  /** True once the server has told us where we spawned. */
  hasSelf = false;

  // Input state: aim and controls are written by the renderer every frame.
  yaw = 0;
  pitch = 0;
  control: ControlState = { mx: 0, mz: 0, sprint: false, crouch: false, fire: false };
  /** Keys the overlay cares about (Tab for the scoreboard). */
  keys = new Set<string>();
  private jumpQueued = false;
  private reloadQueued = false;
  private seq = 0;
  private acc = 0;
  locked = false;
  /** Set by the renderer bridge to animate server events. */
  onEvent: ((e: ClientEvent) => void) | null = null;

  // Smoothed local position (prediction runs at 30 Hz, rendering at screen rate).
  prev: V3 = [0, 0, 0];
  curr: V3 = [0, 0, 0];
  eyeHeight = 1.6;

  remotes = new Map<PlayerId, Remote>();
  feed: FeedLine[] = [];
  banner = { text: "", t: -1 };
  /** Signed-in player's profile after the last finished match (for the match-end card). */
  result: { me: Me; before: number; t: number } | null = null;
  profile: Me | null = null;
  private feedId = 0;
  private listeners = new Set<() => void>();
  private pingTimer = 0;

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify() {
    for (const fn of this.listeners) fn();
  }

  async connect(url: string, name: string, join: JoinRequest = { kind: "quick" }) {
    this.name = name;
    this.status = "connecting";
    this.error = "";
    this.notify();
    wasmReady ??= init();
    await wasmReady;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.room = null;
    this.teamScores = null;
    ws.onopen = () =>
      ws.send(JSON.stringify({
        t: "hello", name, token: session.token ?? undefined,
        room: join.kind === "code" ? join.code : undefined,
        create: join.kind === "create" ? join.config : undefined,
      }));
    if (session.token) api.me().then((m) => { this.profile = m; }).catch(() => {});
    ws.onmessage = (ev) => {
      try {
        this.onMsg(JSON.parse(ev.data as string) as ServerMsg);
      } catch (e) {
        console.error("[net] bad message", e);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.status !== "playing") this.error = "Could not reach the match server.";
      this.status = "closed";
      this.notify();
    };
    ws.onerror = () => {};
    this.pingTimer = window.setInterval(() => this.send({ t: "ping", c: Math.round(performance.now()) }), 2000);
  }

  disconnect() {
    window.clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.status = "idle";
    this.remotes.clear();
    this.notify();
  }

  // ------------------------------------------------------------------ private rooms
  setTeam(team: number) {
    this.send({ t: "set_team", team });
  }
  configure(config: RoomConfig) {
    this.send({ t: "configure", config });
  }
  startMatch() {
    this.send({ t: "start" });
  }
  get isHost() {
    return !!this.room && this.room.host === this.id;
  }

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ------------------------------------------------------------------ input
  queueJump() {
    this.jumpQueued = true;
  }
  queueReload() {
    this.reloadQueued = true;
  }

  /** Called every animation frame. Runs as many fixed 30 Hz ticks as real time requires. */
  frame(dt: number) {
    if (this.status !== "playing" || !this.predictor) return;
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.tick();
    }
  }

  /** 0..1 progress between the last two predicted ticks, for smooth camera motion. */
  get alpha() {
    return this.acc / DT;
  }

  private tick() {
    const p = this.predictor!;
    // Never send a non-number aim (the server would reject the input).
    if (!Number.isFinite(this.yaw)) this.yaw = 0;
    if (!Number.isFinite(this.pitch)) this.pitch = 0;
    const c = this.control;
    const fire = c.fire && this.me.alive;
    const input: Input = {
      seq: ++this.seq, mx: c.mx, mz: c.mz, yaw: this.yaw, pitch: this.pitch,
      jump: this.jumpQueued, sprint: c.sprint, crouch: c.crouch, fire,
      reload: this.reloadQueued,
      // We draw others INTERP_MS in the past; tell the server which moment we were looking at.
      view_tick: Math.max(0, this.lastTick - Math.round((INTERP_MS / 1000) * TICK_HZ)),
    };
    this.jumpQueued = false;
    this.reloadQueued = false;

    this.prev = this.curr;
    p.apply(input.seq, c.mx, c.mz, this.yaw, this.pitch, input.jump, c.sprint, c.crouch, fire);
    this.curr = [p.x(), p.y(), p.z()];
    this.eyeHeight = p.eye_y() - p.y();
    this.send({ t: "input", inputs: [input] });
  }

  /** Predicted local position, smoothed between the last two ticks. */
  smoothPos(): V3 {
    const a = Math.min(1, this.alpha), P = this.prev, C = this.curr;
    return [P[0] + (C[0] - P[0]) * a, P[1] + (C[1] - P[1]) * a, P[2] + (C[2] - P[2]) * a];
  }
  predictedVel(): V3 {
    const p = this.predictor;
    return p ? [p.vx(), p.vy(), p.vz()] : [0, 0, 0];
  }
  /** Climbing a ledge right now (prediction). */
  get climbing() {
    return !!this.predictor && this.predictor.mantling();
  }
  predictedOnGround() {
    return this.predictor ? this.predictor.on_ground() : true;
  }

  // ------------------------------------------------------------------ messages
  private nameOf(id: PlayerId) {
    if (id === this.id) return "You";
    return this.remotes.get(id)?.name ?? `#${id}`;
  }
  private pushFeed(text: string, mine: boolean) {
    this.feed = [...this.feed.slice(-4), { id: ++this.feedId, text, mine, t: performance.now() }];
  }

  private uiListeners = new Set<(e: ClientEvent) => void>();
  /** Match UI (score popups, medals, end screen) listens here; the renderer uses `onEvent`. */
  listen(f: (e: ClientEvent) => void): () => void {
    this.uiListeners.add(f);
    return () => this.uiListeners.delete(f);
  }

  private emit(e: ClientEvent) {
    for (const f of [this.onEvent, ...this.uiListeners]) {
      if (!f) continue;
      try {
        f(e);
      } catch (err) {
        console.error("[client] event handler", err);
      }
    }
  }

  private onMsg(m: ServerMsg) {
    const now = performance.now();
    switch (m.t) {
      case "welcome": {
        this.id = m.id;
        this.result = null;
        this.hasSelf = false;
        this.map = m.map;
        this.killTarget = m.kill_target;
        this.predictor = new Predictor(JSON.stringify(m.map));
        this.status = "playing";
        this.notify();
        break;
      }
      case "snapshot": {
        this.lastTick = m.tick;
        this.me.ammo = m.ammo;
        this.me.reloading = m.reloading;
        this.teamScores = m.team_scores ?? null;
        const seen = new Set<PlayerId>();
        for (const s of m.players) {
          seen.add(s.id);
          if (s.id === this.id) this.applySelf(s, m.ack);
          else this.applyRemote(s, now);
        }
        for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
        break;
      }
      case "shot":
        if (m.shooter !== this.id) {
          const r = this.remotes.get(m.shooter);
          if (r) r.firedAt = now;
          this.emit({ t: "shot", shooter: m.shooter, from: m.from, to: m.to });
        }
        break;
      case "hit":
        this.emit({ t: "hit", shooter: m.shooter, target: m.target, damage: m.damage, head: m.head });
        break;
      case "kill": {
        const killerName = this.nameOf(m.killer), victimName = this.nameOf(m.victim);
        this.pushFeed(`${killerName} ▸ ${victimName}${m.head ? "  ·  head" : ""}`, m.killer === this.id || m.victim === this.id);
        this.emit({ t: "kill", killer: m.killer, victim: m.victim, head: m.head, killerName, victimName });
        this.notify();
        break;
      }
      case "joined":
        if (m.id !== this.id) {
          this.pushFeed(`${m.name} joined`, false);
          this.emit({ t: "joined", name: m.name });
        }
        this.notify();
        break;
      case "left":
        this.pushFeed(`${this.nameOf(m.id)} left`, false);
        this.emit({ t: "left", name: this.nameOf(m.id) });
        this.remotes.delete(m.id);
        this.notify();
        break;
      case "match_end": {
        const w = m.winner;
        const wt = m.winner_team;
        const ts = m.team_scores;
        this.banner = {
          text: ts
            ? wt == null ? `Draw ${ts[0]}–${ts[1]}` : `${TEAM_NAMES[wt]} wins ${ts[wt]}–${ts[1 - wt]}${wt === this.me.team ? " · your team" : ""}`
            : w == null ? "Match over" : w === this.id ? "You win the match" : `${this.nameOf(w)} wins the match`,
          t: now,
        };
        this.emit({ t: "match_end", winner: w, text: this.banner.text, scores: m.scores, winnerTeam: m.winner_team ?? null, teamScores: m.team_scores ?? null });
        this.notify();
        // Rating changes are computed after the match is recorded; fetch them shortly after.
        if (session.token && this.profile) {
          const before = this.profile.stats.rating;
          window.setTimeout(() => {
            api.me().then((m) => { this.result = { me: m, before, t: performance.now() }; this.profile = m; this.notify(); }).catch(() => {});
          }, 1500);
        }
        break;
      }
      case "room": {
        const { t: _t, ...room } = m;
        void _t;
        this.room = room;
        this.emit({ t: "room" });
        this.notify();
        break;
      }
      case "pong":
        this.rtt = Math.round(now - m.c);
        break;
      case "error":
        console.warn("[server]", m.msg);
        this.notice = { text: m.msg, t: now };
        if (this.status === "connecting") this.error = m.msg;
        this.notify();
        break;
      case "respawn":
        if (m.id === this.id) this.snapNext = true;
        break;
    }
  }

  private applySelf(s: PlayerSnap, ack: number) {
    const wasAlive = this.me.alive;
    Object.assign(this.me, { hp: s.hp, alive: s.alive, kills: s.kills, deaths: s.deaths, team: s.team ?? null });
    const p = this.predictor!;
    p.reconcile(ack, s.pos[0], s.pos[1], s.pos[2], s.vel[0], s.vel[1], s.vel[2], s.crouch, s.alive, s.mantle ?? null);
    const c: V3 = [p.x(), p.y(), p.z()];
    // The first snapshot and every respawn are teleports: snap and face where the server put us.
    if (!this.hasSelf || (!wasAlive && s.alive) || (this.snapNext && s.alive)) {
      this.hasSelf = true;
      this.snapNext = false;
      this.spawnSeq++;
      this.prev = c;
      this.yaw = s.yaw;
      this.pitch = 0;
    }
    this.curr = c;
    if (wasAlive !== s.alive) this.notify();
  }

  private applyRemote(s: PlayerSnap, now: number) {
    let r = this.remotes.get(s.id);
    if (!r) {
      r = { id: s.id, name: s.name, buf: [], hp: 100, alive: true, kills: 0, deaths: 0, firedAt: 0, bot: !!s.bot, cosmetic: s.cosmetic ?? null, team: s.team ?? null, hidden: false };
      this.remotes.set(s.id, r);
    }
    // Fog of war: a hidden opponent keeps their scoreboard row but has no position. When they come
    // back, start a fresh buffer so they don't slide in from where they were last seen.
    if (s.hidden) {
      r.hidden = true;
      r.buf.length = 0;
      Object.assign(r, { alive: s.alive, kills: s.kills, deaths: s.deaths, name: s.name, bot: !!s.bot, cosmetic: s.cosmetic ?? null, team: s.team ?? null });
      return;
    }
    if (r.hidden) {
      r.hidden = false;
      r.buf.length = 0;
    }
    r.buf.push({ t: now, pos: s.pos, yaw: s.yaw, pitch: s.pitch, crouch: s.crouch, alive: s.alive, climb: !!s.mantle, vy: s.vel ? s.vel[1] : 0 });
    if (r.buf.length > 20) r.buf.shift();
    Object.assign(r, { hp: s.hp, alive: s.alive, kills: s.kills, deaths: s.deaths, name: s.name, bot: !!s.bot, cosmetic: s.cosmetic ?? null, team: s.team ?? null });
  }

  /** A remote player's pose, interpolated INTERP_MS in the past. */
  remotePose(r: Remote, now: number): Pose | null {
    const b = r.buf;
    if (!b.length) return null;
    const t = now - INTERP_MS;
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > t) i--;
    const B = b[i], A = b[Math.max(0, i - 1)];
    const span = B.t - A.t;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - A.t) / span)) : 1;
    let dy = B.yaw - A.yaw;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return {
      t,
      pos: [A.pos[0] + (B.pos[0] - A.pos[0]) * k, A.pos[1] + (B.pos[1] - A.pos[1]) * k, A.pos[2] + (B.pos[2] - A.pos[2]) * k],
      yaw: A.yaw + dy * k,
      pitch: A.pitch + (B.pitch - A.pitch) * k,
      crouch: B.crouch,
      alive: B.alive,
      climb: B.climb || A.climb,
      vy: A.vy + (B.vy - A.vy) * k,
    };
  }

  scoreboard() {
    const rows = [{ id: this.id, name: `${this.name} (you)`, kills: this.me.kills, deaths: this.me.deaths, me: true, bot: false, team: this.me.team }];
    for (const r of this.remotes.values()) rows.push({ id: r.id, name: r.name, kills: r.kills, deaths: r.deaths, me: false, bot: r.bot, team: r.team });
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }
}

export const client = new GameClient();
// Handy for debugging and automated tests.
(window as unknown as { arena: GameClient }).arena = client;
