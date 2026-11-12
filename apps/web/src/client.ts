// The game client: networking, input, prediction and interpolation. No React in here —
// the 3D scene reads it every frame and the HUD subscribes to a throttled change signal.

import init, { Predictor } from "./wasm/game_wasm.js";
import { lookDir, type Input, type MapData, type PlayerId, type PlayerSnap, type ServerMsg, type V3 } from "./protocol";

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
/** Remote players are drawn this far in the past so there are always two snapshots to blend. */
export const INTERP_MS = 100;
const FIRE_INTERVAL = 0.1;
const MOUSE_SENS = 0.0022;

let wasmReady: Promise<unknown> | null = null;

interface Pose { t: number; pos: V3; yaw: number; pitch: number; crouch: boolean; alive: boolean }
export interface Remote { id: PlayerId; name: string; buf: Pose[]; hp: number; alive: boolean; kills: number; deaths: number; firedAt: number }
export interface Tracer { from: V3; to: V3; born: number; mine: boolean }
export interface FeedLine { id: number; text: string; mine: boolean; t: number }

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
  me = { hp: 100, alive: true, ammo: 30, reloading: false, kills: 0, deaths: 0 };
  lastTick = 0;
  rtt = 0;

  // Input state.
  yaw = 0;
  pitch = 0;
  keys = new Set<string>();
  fireHeld = false;
  private jumpQueued = false;
  private reloadQueued = false;
  private seq = 0;
  private acc = 0;
  private fireCd = 0;
  locked = false;

  // Smoothed local position (prediction runs at 30 Hz, rendering at screen rate).
  prev: V3 = [0, 0, 0];
  curr: V3 = [0, 0, 0];
  eyeHeight = 1.6;

  remotes = new Map<PlayerId, Remote>();
  tracers: Tracer[] = [];
  feed: FeedLine[] = [];
  hitMarker = { t: -1, head: false, kill: false };
  hurt = { t: -1, from: null as V3 | null };
  banner = { text: "", t: -1 };
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

  async connect(url: string, name: string) {
    this.name = name;
    this.status = "connecting";
    this.error = "";
    this.notify();
    wasmReady ??= init();
    await wasmReady;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name }));
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

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ------------------------------------------------------------------ input
  onMouseMove(dx: number, dy: number) {
    if (!this.locked) return;
    this.yaw -= dx * MOUSE_SENS;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * MOUSE_SENS));
  }
  onKey(code: string, down: boolean) {
    if (down) {
      if (code === "Space" && !this.keys.has(code)) this.jumpQueued = true;
      if (code === "KeyR") this.reloadQueued = true;
      this.keys.add(code);
    } else this.keys.delete(code);
  }

  /** Called every animation frame. Runs as many fixed 30 Hz ticks as real time requires. */
  frame(dt: number) {
    if (this.status !== "playing" || !this.predictor) return;
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.tick();
    }
    const now = performance.now();
    this.tracers = this.tracers.filter((t) => now - t.born < 140);
  }

  /** 0..1 progress between the last two predicted ticks, for smooth camera motion. */
  get alpha() {
    return this.acc / DT;
  }

  private tick() {
    const p = this.predictor!;
    const k = this.keys;
    const mx = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const mz = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const crouch = k.has("KeyC") || k.has("ControlLeft");
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    const input: Input = {
      seq: ++this.seq, mx, mz, yaw: this.yaw, pitch: this.pitch,
      jump: this.jumpQueued, sprint, crouch, fire: this.fireHeld && this.locked,
      reload: this.reloadQueued,
      // We draw others INTERP_MS in the past; tell the server which moment we were looking at.
      view_tick: Math.max(0, this.lastTick - Math.round((INTERP_MS / 1000) * TICK_HZ)),
    };
    this.jumpQueued = false;
    this.reloadQueued = false;

    this.prev = this.curr;
    p.apply(input.seq, mx, mz, this.yaw, this.pitch, input.jump, sprint, crouch);
    this.curr = [p.x(), p.y(), p.z()];
    this.eyeHeight = p.eye_y() - p.y();
    this.send({ t: "input", inputs: [input] });

    // Instant local feedback for our own shot; the server still decides whether it hit.
    this.fireCd = Math.max(0, this.fireCd - DT);
    if (input.fire && this.fireCd === 0 && this.me.alive && !this.me.reloading && this.me.ammo > 0) {
      this.fireCd = FIRE_INTERVAL;
      const eye: V3 = [this.curr[0], this.curr[1] + this.eyeHeight, this.curr[2]];
      const d = lookDir(this.yaw, this.pitch);
      const dist = p.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], 200);
      // Muzzle sits a little right of and below the eye (right = (cos yaw, 0, -sin yaw)).
      const gun: V3 = [eye[0] + d[0] * 0.6 + Math.cos(this.yaw) * 0.15, eye[1] - 0.18, eye[2] + d[2] * 0.6 - Math.sin(this.yaw) * 0.15];
      this.tracers.push({ from: gun, to: [eye[0] + d[0] * dist, eye[1] + d[1] * dist, eye[2] + d[2] * dist], born: performance.now(), mine: true });
    }
  }

  // ------------------------------------------------------------------ messages
  private nameOf(id: PlayerId) {
    if (id === this.id) return "You";
    return this.remotes.get(id)?.name ?? `#${id}`;
  }
  private pushFeed(text: string, mine: boolean) {
    this.feed = [...this.feed.slice(-4), { id: ++this.feedId, text, mine, t: performance.now() }];
  }

  private onMsg(m: ServerMsg) {
    const now = performance.now();
    switch (m.t) {
      case "welcome": {
        this.id = m.id;
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
          this.tracers.push({ from: m.from, to: m.to, born: now, mine: false });
          const r = this.remotes.get(m.shooter);
          if (r) r.firedAt = now;
        }
        break;
      case "hit":
        if (m.shooter === this.id) this.hitMarker = { t: now, head: m.head, kill: false };
        if (m.target === this.id) {
          const r = this.remotes.get(m.shooter);
          const last = r?.buf[r.buf.length - 1];
          this.hurt = { t: now, from: last ? last.pos : null };
        }
        break;
      case "kill":
        if (m.killer === this.id) this.hitMarker = { t: now, head: m.head, kill: true };
        this.pushFeed(`${this.nameOf(m.killer)} ▸ ${this.nameOf(m.victim)}${m.head ? "  ·  head" : ""}`, m.killer === this.id || m.victim === this.id);
        this.notify();
        break;
      case "joined":
        if (m.id !== this.id) this.pushFeed(`${m.name} joined`, false);
        this.notify();
        break;
      case "left":
        this.pushFeed(`${this.nameOf(m.id)} left`, false);
        this.remotes.delete(m.id);
        this.notify();
        break;
      case "match_end": {
        const w = m.winner;
        this.banner = { text: w == null ? "Match over" : w === this.id ? "You win the match" : `${this.nameOf(w)} wins the match`, t: now };
        this.notify();
        break;
      }
      case "pong":
        this.rtt = Math.round(now - m.c);
        break;
      case "error":
        console.warn("[server]", m.msg);
        break;
      case "respawn":
        break;
    }
  }

  private applySelf(s: PlayerSnap, ack: number) {
    const wasAlive = this.me.alive;
    Object.assign(this.me, { hp: s.hp, alive: s.alive, kills: s.kills, deaths: s.deaths });
    const p = this.predictor!;
    p.reconcile(ack, s.pos[0], s.pos[1], s.pos[2], s.vel[0], s.vel[1], s.vel[2], s.crouch, s.alive);
    const c: V3 = [p.x(), p.y(), p.z()];
    // A respawn is a teleport: snap the camera and face where the server spawned us.
    if (!wasAlive && s.alive) {
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
      r = { id: s.id, name: s.name, buf: [], hp: 100, alive: true, kills: 0, deaths: 0, firedAt: 0 };
      this.remotes.set(s.id, r);
    }
    r.buf.push({ t: now, pos: s.pos, yaw: s.yaw, pitch: s.pitch, crouch: s.crouch, alive: s.alive });
    if (r.buf.length > 20) r.buf.shift();
    Object.assign(r, { hp: s.hp, alive: s.alive, kills: s.kills, deaths: s.deaths, name: s.name });
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
    };
  }

  scoreboard() {
    const rows = [{ id: this.id, name: `${this.name} (you)`, kills: this.me.kills, deaths: this.me.deaths, me: true }];
    for (const r of this.remotes.values()) rows.push({ id: r.id, name: r.name, kills: r.kills, deaths: r.deaths, me: false });
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }
}

export const client = new GameClient();
// Handy for debugging and automated tests.
(window as unknown as { arena: GameClient }).arena = client;
