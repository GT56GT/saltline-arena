// Connects the Arena network client to the original Saltline renderer running in the game iframe.
//
// The original game keeps doing what it is good at: the level, materials, light, weather, post
// effects, the first-person PAC-9 (recoil, reload, shells, muzzle flash), audio and HUD. This file:
//   - feeds the game's own input (keyboard/mouse/touch/gamepad, look sensitivity) into the client,
//   - places the camera at the server-checked predicted position (patched `arenaMove` hook),
//   - keeps health, ammo, reloads, death and respawn in step with the Rust server,
//   - draws other players (avatar.ts) and their shots, hits and kills with the game's own effects.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ClientEvent, GameClient } from "../client";
import type { V3 } from "../protocol";
import { COSMETICS } from "../cosmetics";
import { Avatar, makeKit, type Kit } from "./avatar";
import { Operator, loadOperatorKit, type OperatorKit } from "./operator";

const RESERVE = 90;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function attachRenderer(win: any, client: GameClient): () => void {
  const G = win.__G;
  const T = G.THREE;
  const P = G.player, I = G.input, W = G.weapon, H = G.hud, E = G.events;
  const kit: Kit = makeKit(G);
  const avatars = new Map<number, Avatar | Operator>();
  // The contractor model streams in after the match starts; until then (or if it fails) players
  // use the built-in procedural soldier. When it arrives, existing players are rebuilt with it.
  let opKit: OperatorKit | null = null;
  loadOperatorKit(win, G, kit)
    .then((k) => {
      if (!k || detached) return;
      opKit = k;
      for (const a of avatars.values()) a.dispose();
      avatars.clear();
    })
    .catch((e) => console.warn("[arena] operator model unavailable, using the built-in soldier", e));
  const offs: (() => void)[] = [];
  const on = (name: string, fn: (e: any) => void) => offs.push(E.on(name, fn));
  let started = false;
  let wasAlive = true;
  let lastLocalShot = -1e9;
  let lastLocalHit = -1e9;
  let lockHintT = 0.8;
  let objective = "";
  let detached = false;
  const v = (a: V3) => new T.Vector3(a[0], a[1], a[2]);

  // ------------------------------------------------------------------ player shots hit avatars
  // The rifle's own hitscan asks `enemies.raycast` for targets. There are no machines in Arena, so
  // answer with the other players: the game then draws the hit spark, plays the hit sound and shows
  // its hit marker instantly. The server still decides the real damage.
  const origRaycast = G.enemies.raycast;
  G.enemies.raycast = (o: any, d: any, max: number) => {
    let best: any = null;
    for (const [id, a] of avatars) {
      const h = a.raycast(o, d, best ? best.dist : max);
      if (h) best = { id, ...h };
    }
    if (!best) return null;
    lastLocalHit = performance.now();
    const point = o.clone().addScaledVector(d, best.dist);
    return {
      point,
      normal: d.clone().negate(),
      dist: best.dist,
      part: best.head ? "weak" : "body",
      enemy: { type: "operator", alive: true, pos: point, damage: () => false, arenaId: best.id },
    };
  };

  on("weapon:fire", () => { lastLocalShot = performance.now(); });
  on("weapon:reload", (e) => { if (e && e.phase === "start") client.queueReload(); });

  // ------------------------------------------------------------------ server events
  client.onEvent = (e: ClientEvent) => {
    if (detached) return;
    switch (e.t) {
      case "shot": {
        const a = avatars.get(e.shooter);
        const from = a ? a.muzzleWorld(new T.Vector3()) : v(e.from);
        const to = v(e.to);
        const dir = to.clone().sub(from);
        const len = dir.length();
        if (len < 1e-3) break;
        dir.divideScalar(len);
        a && a.fired();
        try { G.fx.tracer(from.clone(), to.clone(), { color: 16756832, speed: 140 }); } catch { /* fx optional */ }
        try { G.fx.muzzleFlash(from.clone(), dir.clone(), { scale: 0.85 }); } catch { /* */ }
        try { G.render.lightPool && G.render.lightPool.flash(from.clone(), 16756832, 40, 8, 0.05); } catch { /* */ }
        try { G.audio.play("rifle_shot", { pos: from.clone(), variant: (Math.random() * 4) | 0, gain: 0.95, jitter: 0.02 }); } catch { /* */ }
        // Where it struck the world: sparks, decal, impact sound, and a whiz if it passed close by.
        try {
          const hit = G.physics.raycast(from, dir, len + 0.25);
          if (hit && hit.dist >= len - 0.3) {
            E.emit("impact", { point: hit.point, normal: hit.normal, dist: hit.dist, surface: hit.surface, enemy: null, dir, from: "enemy" });
          }
        } catch { /* */ }
        break;
      }
      case "hit": {
        if (e.target === client.id) {
          const a = avatars.get(e.shooter);
          const from = a ? a.root.position.clone().setY(a.root.position.y + 1.4) : null;
          try { P.damage(e.damage, from); } catch { /* */ }
        } else {
          const t = avatars.get(e.target);
          if (t && t.pose) {
            const pt = new T.Vector3(t.pose.pos[0], t.pose.pos[1] + (e.head ? t.bodyHeight - 0.14 : 1.1), t.pose.pos[2]);
            try { E.emit("impact", { point: pt, normal: new T.Vector3(0, 1, 0), surface: "enemy", enemy: { type: "operator" }, part: e.head ? "weak" : "body", dir: new T.Vector3(0, -1, 0), from: "enemy" }); } catch { /* */ }
          }
          // Our hit that our own screen missed (lag): the server's word still gets a marker.
          if (e.shooter === client.id && performance.now() - lastLocalHit > 180) H.hitmarker(e.head ? "weak" : "hit");
        }
        break;
      }
      case "kill": {
        if (e.killer === client.id) H.hitmarker("kill");
        const k = e.killer === client.id ? "You" : e.killerName;
        const vname = e.victim === client.id ? "you" : e.victimName;
        H.feed(`<b>${esc(k)}</b> ${e.head ? "headshot " : ""}&#9656; ${esc(vname)}`);
        if (e.victim === client.id) H.message(`Taken down by ${e.killerName}`, 3);
        break;
      }
      case "joined":
        H.feed(`<b>${esc(e.name)}</b> joined`);
        break;
      case "left":
        H.feed(`<b>${esc(e.name)}</b> left`);
        break;
      case "match_end":
        H.message(e.text, 6);
        break;
    }
  };

  // ------------------------------------------------------------------ start / respawn
  const spawnHere = () => {
    const p = client.curr;
    P.reset({ pos: new T.Vector3(p[0], p[1], p[2]), yaw: client.yaw });
    P.pitch = client.pitch;
    try { W.reset(); W.reserve = RESERVE; W.setVisible(true); W.snap && W.snap(); } catch { /* */ }
  };
  const start = () => {
    started = true;
    spawnHere();
    P.enabled = true;
    try { H.reset(); H.show(true); } catch { /* */ }
    I.setGameplay && I.setGameplay(true);
    const post = G.render && G.render.post;
    if (post) { post.fade = 0; post.saturation = 1; }
    try { G.audio.setPaused && G.audio.setPaused(false); G.audio.setIntensity && G.audio.setIntensity(0.35); } catch { /* */ }
    G.game.state = "playing";
    const k = win.document.querySelector(".hud .h-obj .h-k");
    if (k) k.textContent = "Free for all";
  };

  // ------------------------------------------------------------------ per-frame hooks
  G.arenaMove = (C: any) => {
    const p = client.smoothPos();
    C.pos.set(p[0], p[1], p[2]);
    const vel = client.predictedVel();
    C.vel.set(vel[0], vel[1], vel[2]);
    C.health = client.me.hp;
    return { onGround: client.predictedOnGround() };
  };

  const camPos = new T.Vector3();
  // The game clamps its frame step to 50 ms; the network clock must follow real time instead,
  // or a slow frame rate would make us send fewer inputs than the server ticks.
  let lastReal = performance.now();
  G.arenaTick = (dt: number) => {
    if (detached || client.status !== "playing" || !client.predictor) return false;
    if (!client.hasSelf) return false;
    if (!started) start();

    // Death and respawn come from the server (checked before reading aim, so a respawn keeps
    // the facing the server chose).
    const alive = client.me.alive;
    if (wasAlive && !alive) {
      P.arenaDie && P.arenaDie();
      E.emit("player:dead", {});
    } else if (!wasAlive && alive) {
      spawnHere();
      H.message("", 0);
    }
    wasAlive = alive;

    // Input from the game's own input system.
    const locked = !!(I.locked || I.touch || I.mode === "drag");
    client.locked = locked;
    client.control = {
      mx: +I.move.x || 0,
      mz: +I.move.y || 0,
      sprint: !!I.sprint,
      crouch: !!I.crouch,
      fire: !!I.fire && locked && W.root.visible,
    };
    if (I.pressed && I.pressed("jump")) client.queueJump();
    client.yaw = P.yaw;
    client.pitch = P.pitch;
    const nowReal = performance.now();
    client.frame((nowReal - lastReal) / 1000);
    lastReal = nowReal;
    P.health = client.me.hp;

    // Ammo and reloads: the first-person rifle animates locally; the server's count wins when idle.
    W.reserve = RESERVE;
    const now = performance.now();
    if (client.me.reloading && W.state !== "reloading" && W.ammo < W.magSize) W.reloadNow();
    else if (!client.me.reloading && W.state !== "reloading" && now - lastLocalShot > 450 && W.ammo !== client.me.ammo) W.ammo = client.me.ammo;

    // Other players.
    camPos.copy(G.camera.position);
    const seen = new Set<number>();
    for (const r of client.remotes.values()) {
      seen.add(r.id);
      let a = avatars.get(r.id);
      if (!a) {
        a = opKit ? new Operator(opKit, r.name, win.document) : new Avatar(kit, r.name, win.document);
        G.scene.add(a.root);
        avatars.set(r.id, a);
      }
      a.setName(r.name);
      const look = r.cosmetic ? COSMETICS[r.cosmetic] ?? null : null;
      a.setCosmetic(r.cosmetic, look);
      const pose = client.remotePose(r, now);
      if (pose) a.update(pose, dt, camPos);
    }
    for (const [id, a] of avatars) if (!seen.has(id)) { a.dispose(); avatars.delete(id); }

    // Match panel (the original objective slot).
    let leader = { name: "", kills: -1 };
    for (const r of client.remotes.values()) if (r.kills > leader.kills) leader = { name: r.name, kills: r.kills };
    const text = `First to ${client.killTarget}: you ${client.me.kills}` + (leader.kills > client.me.kills ? ` · ${leader.name} ${leader.kills}` : leader.kills >= 0 ? " · leading" : "");
    if (text !== objective) { objective = text; H.setObjective(text); }

    // Mouse-capture hint, like the original director.
    if (I.mode === "lock" && !I.locked && !I.touch) {
      lockHintT -= dt;
      if (lockHintT <= 0) { lockHintT = 2; H.message(I.describeMode(), 2.6); }
    } else lockHintT = 0.8;
    return true;
  };

  // For tests and screenshots: build or inspect operator models directly.
  win.__arena = { kit, Avatar, Operator, avatars, get opKit() { return opKit; } };

  // Overlay keys (scoreboard) and audio unlock happen inside the iframe.
  const keydown = (ev: KeyboardEvent) => {
    if (ev.code === "Tab") { ev.preventDefault(); client.keys.add("Tab"); client.notify(); }
  };
  const keyup = (ev: KeyboardEvent) => {
    if (ev.code === "Tab") { client.keys.delete("Tab"); client.notify(); }
  };
  const blur = () => { client.keys.clear(); client.notify(); };
  const unlockAudio = () => { try { G.audio.resume && G.audio.resume(); } catch { /* */ } };
  win.addEventListener("keydown", keydown);
  win.addEventListener("keyup", keyup);
  win.addEventListener("blur", blur);
  win.addEventListener("pointerdown", unlockAudio);

  return () => {
    detached = true;
    client.onEvent = null;
    for (const off of offs) { try { off(); } catch { /* */ } }
    G.enemies.raycast = origRaycast;
    G.arenaTick = null;
    G.arenaMove = null;
    for (const a of avatars.values()) a.dispose();
    avatars.clear();
    try { I.setGameplay && I.setGameplay(false); I.exitLock && I.exitLock(); } catch { /* */ }
    win.removeEventListener("keydown", keydown);
    win.removeEventListener("keyup", keyup);
    win.removeEventListener("blur", blur);
    win.removeEventListener("pointerdown", unlockAudio);
  };
}
