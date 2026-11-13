// Footstep audio, end to end through the original game's audio engine (patched play()).
//   1. Exact checks: footsteps, jumps and landings fed straight into the footstep module at known
//      distances and directions; we read back the real Web Audio nodes the engine used
//      (3D panner position, HRTF, low-pass cutoff) and the gain the module chose.
//   2. Live check: a scripted bot walks, sprints, crouches and jumps next to us on the real server;
//      its sounds must arrive with sane distances and never past their hearing distance.
// Run the server with MIN_PLAYERS=0 SPAWN_RULE=nearest on :8791 and `vite preview` on :4173.
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8791/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, info = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

function bot(name) {
  const ws = new WebSocket(SERVER);
  const b = { ws, id: 0, me: null, seq: 0, input: { mx: 0, mz: 0, sprint: false, crouch: false, jump: false, fire: false } };
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") b.id = m.id;
    if (m.t === "snapshot") b.me = m.players.find((p) => p.id === b.id);
  };
  b.yaw = 0;
  b.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++b.seq, yaw: b.yaw, pitch: 0, reload: false, view_tick: 0, ...b.input }] })), 33);
  return b;
}

// Record every panner and biquad the page creates, in creation order (a 3D voice = panner, then its low-pass).
const HOOK = () => {
  const made = (window.__audioNodes = []);
  const P = BaseAudioContext.prototype;
  const cp = P.createPanner, cb = P.createBiquadFilter;
  P.createPanner = function () { const n = cp.call(this); made.push({ kind: "pan", n }); return n; };
  P.createBiquadFilter = function () { const n = cb.call(this); made.push({ kind: "lp", n }); return n; };
};

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 320, height: 180 } });
  await ctx.addInitScript(HOOK);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=test`);
  await page.fill("#name", "Atul");
  await page.evaluate(() => document.querySelector("button.btn.primary").click());
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.hasSelf, null, { timeout: 120000 });
  const frame = page.frames().find((f) => f.url().includes("/saltline/play.html"));
  await frame.waitForFunction(() => window.__arena && __arena.steps && __G.audio && __G.audio.ctx, null, { timeout: 60000 });
  await frame.evaluate(() => { try { __G.audio.resume && __G.audio.resume(); } catch {} });
  await frame.waitForFunction(() => __G.audio.ctx.state === "running", null, { timeout: 15000 }).catch(() => {});
  ok("audio engine running", await frame.evaluate(() => __G.audio.ctx.state === "running"), await frame.evaluate(() => __G.audio.ctx.state));

  // ---------------------------------------------------------------- 1. exact checks
  // Place a footstep at a unique spot `d` metres away in a given direction, then find the panner
  // the engine moved there and the low-pass created with it.
  const probe = (args) => frame.evaluate(async ({ d, ang, dy, move, ally, kind }) => {
    const S = __arena.steps, cam = __G.camera.position.clone();
    const listener = { x: cam.x, y: cam.y, z: cam.z };
    const x = cam.x + Math.sin(ang) * d, z = cam.z + Math.cos(ang) * d, y = cam.y + dy - 0.05;
    const id = 9000 + Math.floor(Math.random() * 1000);
    const before = S.log.length;
    S.mixer.active = [];
    const speed = move === "sprint" ? 6.4 : move === "crouch" ? 1.9 : move === "walk" ? 3.8 : 0;
    if (kind === "step") S.step(id, { pos: [x, y, z], crouch: move === "crouch", alive: true, climb: false }, speed, listener, ally, false);
    else {
      // a jump straight up and back down: on ground, rising, falling fast, landed
      for (const vy of [0, 6.4, 0.5, -3, -7.5, -6, 0]) S.track(id, { pos: [x, y, z], alive: true, climb: false, vy }, false, listener, ally, false);
    }
    await new Promise((r) => setTimeout(r, 60));
    const entries = S.log.slice(before);
    const nodes = window.__audioNodes || [];
    let pan = null, lp = null;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind === "pan" && Math.abs(n.n.positionX.value - x) < 1e-3 && Math.abs(n.n.positionZ.value - z) < 1e-3) {
        pan = n.n;
        if (nodes[i + 1] && nodes[i + 1].kind === "lp") lp = nodes[i + 1].n;
      }
    }
    return {
      entries,
      pan: pan && { model: pan.panningModel, roll: pan.rolloffFactor, y: pan.positionY.value },
      lp: lp && Math.round(lp.frequency.value),
    };
  }, args);

  let r = await probe({ d: 9, ang: Math.PI, dy: 0, move: "walk", ally: false, kind: "step" });
  const e0 = r.entries[0];
  ok("enemy walking 9 m behind: heard, in 3D with HRTF", !!e0 && !!r.pan && r.pan.model === "HRTF", JSON.stringify(r));
  ok("  volume follows the curve (0.7 x 0.65 at half of 18 m)", e0 && Math.abs(e0.gain - 0.7 * Math.pow(1 - 0.25, 1.5)) < 0.01, e0 && `gain ${e0.gain}`);
  ok("  engine distance roll-off is off (the module sets the volume)", r.pan && r.pan.roll === 0);
  ok("  distant treble trimmed (low-pass ~6.9 kHz at half range)", r.lp != null && Math.abs(r.lp - 6928) < 60, `lp ${r.lp}`);

  r = await probe({ d: 4, ang: 0.3, dy: 3, move: "walk", ally: false, kind: "step" });
  ok("enemy on a container 3 m above: panner sits above us", r.pan && r.pan.model === "HRTF" && r.pan.y > 2.5 + (await frame.evaluate(() => __G.camera.position.y)) - 0.5, JSON.stringify(r.pan));

  r = await probe({ d: 20, ang: 1, dy: 0, move: "walk", ally: false, kind: "step" });
  ok("walking 20 m away: out of earshot (18 m), nothing plays", r.entries.length === 0 && !r.pan);
  r = await probe({ d: 28, ang: 1, dy: 0, move: "sprint", ally: false, kind: "step" });
  ok("sprinting 28 m away: heard (32 m)", r.entries.length === 1 && !!r.pan, JSON.stringify(r.entries));
  r = await probe({ d: 6, ang: 2, dy: 0, move: "crouch", ally: false, kind: "step" });
  ok("crouch-walking 6 m away: silent (5 m)", r.entries.length === 0);
  r = await probe({ d: 3, ang: 2, dy: 0, move: "crouch", ally: false, kind: "step" });
  ok("crouch-walking 3 m away: faint", r.entries.length === 1 && r.entries[0].gain < 0.2, JSON.stringify(r.entries));

  const en = await probe({ d: 6, ang: -1, dy: 0, move: "walk", ally: false, kind: "step" });
  const tm = await probe({ d: 6, ang: -1, dy: 0, move: "walk", ally: true, kind: "step" });
  ok("teammate at 6 m quieter than an enemy at 6 m", en.entries[0] && tm.entries[0] && tm.entries[0].gain < en.entries[0].gain * 0.4, `${tm.entries[0] && tm.entries[0].gain} vs ${en.entries[0] && en.entries[0].gain}`);
  r = await probe({ d: 12, ang: -1, dy: 0, move: "walk", ally: true, kind: "step" });
  ok("teammate walking 12 m away: not heard (half of 18 m)", r.entries.length === 0);

  r = await probe({ d: 8, ang: 0.8, dy: 0, kind: "jump", ally: false });
  const kinds = r.entries.map((e) => e.move).join(",");
  ok("enemy jump 8 m away: jump, then landing", kinds === "jump,land", kinds);
  ok("  landing plays in 3D with HRTF", !!r.pan && r.pan.model === "HRTF");

  // A normal 3D sound (an impact) still uses plain panning and the engine's own distance curve.
  const imp = await frame.evaluate(async () => {
    const c = __G.camera.position, x = c.x + 4.321, z = c.z;
    __G.audio.play("impact_concrete", { pos: new __G.THREE.Vector3(x, c.y, z) });
    await new Promise((r) => setTimeout(r, 30));
    const p = window.__audioNodes.filter((n) => n.kind === "pan" && Math.abs(n.n.positionX.value - x) < 1e-3).pop();
    return p && { model: p.n.panningModel, roll: p.n.rolloffFactor };
  });
  ok("other game sounds unchanged (equalpower, engine roll-off)", imp && imp.model === "equalpower" && imp.roll === 0.7, JSON.stringify(imp));

  // ---------------------------------------------------------------- 2. live bot
  await frame.evaluate(() => { __arena.steps.log.length = 0; });
  const b = bot("Walker");
  await page.waitForFunction(() => arena.remotes.size >= 1, null, { timeout: 15000 });
  const phase = async (name, input, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      // back and forth so it stays near us
      const dir = Math.floor((Date.now() - t0) / 900) % 2 ? 1 : -1;
      b.input = { ...b.input, ...input, mz: dir, jump: !!input.jump && (Date.now() / 400 | 0) % 3 === 0 };
      await sleep(100);
    }
  };
  // Sprint toward us until close (it may spawn across the harbour).
  const t0 = Date.now();
  let dist = 1e9;
  while (Date.now() - t0 < 40000) {
    const cam = await frame.evaluate(() => { const c = __G.camera.position; return [c.x, c.z]; });
    if (b.me) {
      const dx = cam[0] - b.me.pos[0], dz = cam[1] - b.me.pos[2];
      dist = Math.hypot(dx, dz);
      b.yaw = Math.atan2(-dx, -dz);
      // sidestep now and then to get round containers
      b.input = { ...b.input, sprint: true, mz: 1, mx: (Date.now() / 1500 | 0) % 4 === 3 ? 1 : 0 };
      if (dist < 7) break;
    }
    await sleep(100);
  }
  console.log(`      bot came within ${dist.toFixed(1)} m`);
  await phase("walk", { sprint: false, crouch: false }, 8000);
  await phase("sprint", { sprint: true, crouch: false }, 8000);
  await phase("jump", { sprint: false, crouch: false, jump: true }, 10000);
  b.input = { mx: 0, mz: 0, sprint: false, crouch: false, jump: false, fire: false };
  const log = await frame.evaluate(() => __arena.steps.log.slice());
  console.log("      bot", JSON.stringify(b.me && { pos: b.me.pos.map((v) => +v.toFixed(1)), vel: b.me.vel.map((v) => +v.toFixed(1)), alive: b.me.alive }),
    "cam", JSON.stringify(await frame.evaluate(() => { const c = __G.camera.position; return [c.x, c.y, c.z].map((v) => +v.toFixed(1)); })),
    "avatar steps", await frame.evaluate(() => [...__arena.avatars.values()].map((a) => a.steps + "/" + a.groundSpeed.toFixed(1)).join(",")));
  const RANGE = { sprint: 32, walk: 18, crouch: 5, land: 32, jump: 10, climb: 12 };
  const moves = [...new Set(log.map((e) => e.move))].join(",");
  console.log(`      live: ${log.length} sounds (${moves}); fps ${await frame.evaluate(() => window.__frames)}`);
  ok("live bot: its movement is heard", log.length > 0, moves);
  ok("live bot: nothing past its hearing distance", log.every((e) => e.dist < RANGE[e.move]), JSON.stringify(log.filter((e) => e.dist >= RANGE[e.move])));
  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  clearInterval(b.timer);
  b.ws.close();
  await browser.close();
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
