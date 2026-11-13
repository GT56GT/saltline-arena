// Connects the Arena network client to the original Saltline renderer running in the game iframe.
//
// The original game keeps doing what it is good at: the level, materials, light, weather, post
// effects, the first-person PAC-9 (recoil, reload, shells, muzzle flash), audio and HUD. This file:
//   - feeds the game's own input (keyboard/mouse/touch/gamepad, look sensitivity) into the client,
//   - places the camera at the server-checked predicted position (patched `arenaMove` hook),
//   - keeps health, ammo, reloads, death and respawn in step with the Rust server,
//   - draws other players (avatar.ts) and their shots, hits and kills with the game's own effects.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { TEAM_COLORS, TEAM_NAMES, type ClientEvent, type GameClient } from "../client";
import type { V3 } from "../protocol";
import { COSMETICS } from "../cosmetics";
import { Avatar, makeKit, type Kit } from "./avatar";
import { Operator, loadOperatorKit, type OperatorKit } from "./operator";
import { getSettings, onSettings, type Settings } from "../settings";
import { Footsteps, HEAR, moveOf } from "./footsteps";

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
  let lastSpawn = -1;
  /** In a team room without friendly fire, teammates are not targets. */
  const isAlly = (id: number) => {
    const r = client.remotes.get(id);
    return !!client.room && client.room.config.teams && r != null && r.team != null && r.team === client.me.team;
  };
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
    const ff = !client.room || client.room.config.friendly_fire;
    for (const [id, a] of avatars) {
      if (!ff && isAlly(id)) continue;
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
        // Other players' shots: in 3D (direction, height, distance), heard across the map up to 150 m.
        if (from.distanceTo(G.camera.position) < 150) {
          try { G.audio.play("rifle_shot", { pos: from.clone(), world: true, hrtf: true, ref: 6, roll: 0.6, variant: (Math.random() * 4) | 0, gain: 0.95, jitter: 0.02 }); } catch { /* */ }
        }
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
    lastSpawn = client.spawnSeq;
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

  // ------------------------------------------------------------------ settings, applied live
  const applySettings = (st: Settings) => {
    try {
      I.sensitivity = st.sens;
      I.invertY = st.invertY;
      P.setFov && P.setFov(st.fov);
      const A = G.audio;
      if (A) {
        A.setVolume && A.setVolume(st.master);
        if (A.setBus) {
          A.setBus("music", st.music);
          A.setBus("amb", st.ambience);
          for (const b of ["world", "near", "dry"]) A.setBus(b, st.effects);
        }
      }
      const Q = G.QUALITY;
      if (st.quality !== "auto" && Q && Q[st.quality] && G.render && G.render.setQuality && (!G.quality || G.quality.name !== st.quality)) {
        G.render.setQuality({ ...Q[st.quality] });
      }
    } catch (e) {
      console.warn("[arena] settings", e);
    }
  };
  applySettings(getSettings());
  offs.push(onSettings(applySettings));

  // ------------------------------------------------------------------ per-frame hooks
  let climbing = false;
  G.arenaMove = (C: any) => {
    const p = client.smoothPos();
    C.pos.set(p[0], p[1], p[2]);
    const vel = client.predictedVel();
    C.vel.set(vel[0], vel[1], vel[2]);
    C.health = client.me.hp;
    // Climbing: the rifle drops to its sprint pose while the hands are busy.
    if (client.climbing) C.sprinting = true;
    return { onGround: client.predictedOnGround() };
  };

  // Other players' footsteps, jumps, landings and climbs: in 3D, by hearing distance, enemies first.
  const steps = new Footsteps(G);
  const climbHeard = new Map<number, boolean>();
  // An enemy step close by briefly lowers the ambience (sea, wind, rain) by about 4 dB.
  steps.onNearEnemy = () => { try { G.audio.duckBus && G.audio.duckBus("amb", 0.63, 0.03, 0.15, 0.4); } catch { /* */ } };
  let noiseOn = true;
  const applyStepSettings = (st: Settings) => {
    steps.volume = st.footsteps;
    steps.team = st.teamSteps;
    noiseOn = st.noise;
  };
  applyStepSettings(getSettings());
  offs.push(onSettings(applyStepSettings));

  // Noise indicator: how far my own movement can be heard right now (same table as other players').
  let noiseEl: HTMLElement | null = null;
  let noiseKey = "";
  const updateNoise = () => {
    if (!noiseEl) {
      const hp = win.document.querySelector(".hud .h-health");
      if (!hp || !hp.parentElement) return;
      noiseEl = win.document.createElement("div");
      noiseEl!.className = "h-noise off";
      hp.parentElement.insertBefore(noiseEl!, hp.nextSibling);
    }
    const p = client.predictor;
    let level = 0, label = "Silent", range = 0;
    if (p && client.me.alive) {
      const move = moveOf(Math.hypot(p.vx(), p.vz()), p.crouching());
      if (client.climbing) { level = 2; label = "Climbing"; range = HEAR.climb.range; }
      else if (!p.on_ground()) { level = 3; label = "Landing"; range = HEAR.land.range; }
      else if (move === "sprint") { level = 3; label = "Loud"; range = HEAR.sprint.range; }
      else if (move === "walk") { level = 2; label = "Heard"; range = HEAR.walk.range; }
      else if (move === "crouch") { level = 1; label = "Quiet"; range = HEAR.crouch.range; }
    }
    const show = noiseOn && !!p && client.me.alive;
    const key = `${show}|${level}|${label}`;
    if (key === noiseKey) return;
    noiseKey = key;
    noiseEl!.className = show ? "h-noise" : "h-noise off";
    noiseEl!.dataset.l = String(level);
    noiseEl!.innerHTML = `<b>${label}</b>` + [1, 2, 3].map((n) => `<i class="${n <= level ? "on" : ""}"></i>`).join("") + (range ? `<em>${range} m</em>` : "");
    noiseEl!.title = range ? `Enemies can hear you within about ${range} m` : "Enemies cannot hear you";
  };
  /** Is this remote player looking roughly at us (within ~45 degrees)? Their steps take priority. */
  const facingUs = (pose: { pos: V3; yaw: number }) => {
    const dx = camPos.x - pose.pos[0], dz = camPos.z - pose.pos[2];
    const d = Math.hypot(dx, dz) || 1;
    return (-Math.sin(pose.yaw) * dx - Math.cos(pose.yaw) * dz) / d > 0.7;
  };
  const stepsHeard = new Map<number, number>();

  // Names: teammates always; enemies when under the crosshair (or always, in settings).
  let aimedId = -1;
  let aimedUntil = 0;
  const fwd = new T.Vector3();
  const findAimed = (now: number) => {
    G.camera.getWorldDirection(fwd);
    const o = G.camera.position;
    let best: { id: number; dist: number } | null = null;
    for (const [id, a] of avatars) {
      const h: { dist: number } | null = a.raycast(o, fwd, best ? best.dist : 120);
      if (h) best = { id, dist: h.dist };
    }
    if (best) {
      const wall = G.physics && G.physics.raycast ? G.physics.raycast(o, fwd, best.dist) : null;
      if (!wall || wall.dist >= best.dist - 0.05) {
        aimedId = best.id;
        aimedUntil = now + 900;
      }
    }
    if (now > aimedUntil) aimedId = -1;
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
    } else if (alive && client.spawnSeq !== lastSpawn) {
      // Respawn, or the host started the match and everyone was moved to a fresh spawn.
      spawnHere();
      H.message("", 0);
    }
    lastSpawn = client.spawnSeq;
    wasAlive = alive;

    // Input from the game's own input system.
    const locked = !!(I.locked || I.touch || I.mode === "drag");
    client.locked = locked;
    client.control = {
      mx: +I.move.x || 0,
      mz: +I.move.y || 0,
      sprint: !!I.sprint,
      crouch: !!I.crouch,
      fire: !!I.fire && locked && W.root.visible && !client.climbing,
    };
    if (I.pressed && I.pressed("jump")) client.queueJump();
    client.yaw = P.yaw;
    client.pitch = P.pitch;
    const nowReal = performance.now();
    client.frame((nowReal - lastReal) / 1000);
    lastReal = nowReal;
    P.health = client.me.hp;
    // Climb start and finish: grab the ledge, then a soft landing on top.
    if (client.climbing !== climbing) {
      climbing = client.climbing;
      try { G.audio.play("land", { gain: climbing ? 0.45 : 0.6, pitch: climbing ? 1.25 : 0.95 }); } catch { /* */ }
    }

    // Ammo and reloads: the first-person rifle animates locally; the server's count wins when idle.
    W.reserve = RESERVE;
    const now = performance.now();
    if (client.me.reloading && W.state !== "reloading" && W.ammo < W.magSize) W.reloadNow();
    else if (!client.me.reloading && W.state !== "reloading" && now - lastLocalShot > 450 && W.ammo !== client.me.ammo) W.ammo = client.me.ammo;

    // Other players.
    camPos.copy(G.camera.position);
    updateNoise();
    const st = getSettings();
    findAimed(now);
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
      const teams = !!client.room && client.room.config.teams;
      a.setLook(r.cosmetic, look, teams && r.team != null ? TEAM_COLORS[r.team] : null, teams && r.team != null && r.team === client.me.team);
      const ally = teams && r.team != null && r.team === client.me.team;
      a.tagWanted = ally || st.names === "always" || r.id === aimedId;
      const pose = client.remotePose(r, now);
      if (pose) {
        a.update(pose, dt, camPos);
        const facing = facingUs(pose);
        const climbStarted = pose.climb && climbHeard.get(r.id) === false;
        climbHeard.set(r.id, pose.climb);
        steps.track(r.id, pose, climbStarted, camPos, ally, facing);
        if (a.steps !== stepsHeard.get(r.id)) {
          if (stepsHeard.has(r.id)) steps.step(r.id, pose, a.groundSpeed, camPos, ally, facing);
          stepsHeard.set(r.id, a.steps);
        }
      }
    }
    for (const [id, a] of avatars) if (!seen.has(id)) { a.dispose(); avatars.delete(id); stepsHeard.delete(id); climbHeard.delete(id); steps.forget(id); }

    // Match panel (the original objective slot).
    let leader = { name: "", kills: -1 };
    for (const r of client.remotes.values()) if (r.kills > leader.kills) leader = { name: r.name, kills: r.kills };
    const room = client.room;
    const ts = client.teamScores;
    const target = room ? room.config.kill_target : client.killTarget;
    const text = room && !room.live
      ? (client.isHost ? "Warm-up · Esc, then Start match" : "Warm-up · waiting for the host")
      : room && room.config.teams && ts
        ? `${TEAM_NAMES[0]} ${ts[0]} – ${ts[1]} ${TEAM_NAMES[1]} · first to ${target}` + (client.me.team != null ? ` · you: ${TEAM_NAMES[client.me.team]}` : "")
        : `First to ${target}: you ${client.me.kills}` + (leader.kills > client.me.kills ? ` · ${leader.name} ${leader.kills}` : leader.kills >= 0 ? " · leading" : "");
    const k = win.document.querySelector(".hud .h-obj .h-k");
    const label = room ? (room.config.teams ? "Team match" : "Free for all") + ` · room ${room.code}` : "Free for all";
    if (k && k.textContent !== label) k.textContent = label;
    if (text !== objective) { objective = text; H.setObjective(text); }

    // Mouse-capture hint, like the original director.
    if (I.mode === "lock" && !I.locked && !I.touch) {
      lockHintT -= dt;
      if (lockHintT <= 0) { lockHintT = 2; H.message(I.describeMode(), 2.6); }
    } else lockHintT = 0.8;
    return true;
  };

  // For tests and screenshots: build or inspect operator models directly.
  win.__arena = { kit, Avatar, Operator, avatars, steps, get opKit() { return opKit; } };

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
