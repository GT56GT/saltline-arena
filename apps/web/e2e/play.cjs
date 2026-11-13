// End-to-end: a real browser (original Saltline renderer) vs a scripted bot, both on the real
// Rust server. Input goes through the original game's own input system: a real click captures
// the mouse, a held mouse button fires the first-person PAC-9, W walks. The server decides.
// Run the server with MIN_PLAYERS=0 (no AI bots, so the scripted bot is the only other player) and
// SPAWN_RULE=nearest (so the bot spawns within sight instead of across the harbour).
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8791/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const SHOT = process.env.SHOT || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, info = "") => { const l = `${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`; out.push(l); console.log(l); };

function bot(name) {
  const ws = new WebSocket(SERVER);
  const b = { ws, id: 0, me: null, kills: [], seq: 0 };
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") b.id = m.id;
    if (m.t === "snapshot") b.me = m.players.find((p) => p.id === b.id);
    if (m.t === "kill") b.kills.push(m);
  };
  // Stand still and keep sending idle inputs like a real client.
  b.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++b.seq, mx: 0, mz: 0, yaw: 0, pitch: 0 }] })), 33);
  return b;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: +(process.env.W || 400), height: +(process.env.H || 225) } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const myShots = [];
  if (process.env.DEBUG_SHOTS) page.on("websocket", (ws) => ws.on("framereceived", (f) => { try { const m = JSON.parse(f.payload); if (m.t === "shot" || m.t === "hit") myShots.push(m); } catch {} }));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=test&noaudio=1`);
  await page.fill("#name", "Atul");
  await page.evaluate(() => document.querySelector("button.btn.primary").click());
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.hasSelf, null, { timeout: 120000 });
  const frame = page.frames().find((f) => f.url().includes("/saltline/play.html"));
  ok("original renderer booted, then joined the Rust server", true, await page.evaluate(() => `id ${arena.id}, tick ${arena.lastTick}`));

  const b = bot("Bot");
  await page.waitForFunction(() => arena.remotes.size === 1 && [...arena.remotes.values()][0].buf.length > 3, null, { timeout: 15000 });
  await frame.waitForFunction(() => __arena.opKit && __arena.avatars.size === 1 && [...__arena.avatars.values()][0] instanceof __arena.Operator, null, { timeout: 60000 });
  ok("bot appears as the contractor model in the original scene", true);

  // Headless Chromium never grants pointer lock, so use the game's own no-lock fallback
  // ("drag" mode: clicks fire, the mouse turns the view) instead of a captured mouse.
  await frame.evaluate(() => { __G.input.mode = "drag"; });
  await page.mouse.move(100, 100);
  const mode = await frame.evaluate(() => ({ locked: __G.input.locked, mode: __G.input.mode, overlay: parent.arena.locked }));
  const f0 = await frame.evaluate(() => window.__frames); await sleep(4000);
  const fps = ((await frame.evaluate(() => window.__frames)) - f0) / 4;
  console.log(`      (software renderer: ${fps.toFixed(1)} frames/s)`);
  ok("game input is live (no-lock fallback)", mode.mode === "drag", JSON.stringify(mode));

  // Aim the game's own camera at the bot's chest and hold the mouse button until the server reports a kill.
  const aim = () => frame.evaluate(() => {
    const a = parent.arena, r = [...a.remotes.values()][0];
    const pose = a.remotePose(r, performance.now());
    if (!pose || !pose.alive) return;
    const e = a.smoothPos(), ey = e[1] + a.eyeHeight;
    const dx = pose.pos[0] - e[0], dz = pose.pos[2] - e[2], dy = pose.pos[1] + 1.35 - ey; // upper chest: clears waist-high crates on the line
    __G.player.yaw = Math.atan2(-dx, -dz);
    __G.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  });
  await aim();
  await page.mouse.down();
  let killed = false;
  const until = Date.now() + 60000;
  while (!killed && Date.now() < until) {
    await aim();
    await sleep(60);
    killed = await page.evaluate(() => arena.me.kills >= 1);
  }
  await page.mouse.up();
  if (process.env.DEBUG_SHOTS) {
    console.log(JSON.stringify(myShots.slice(0, 4)));
    console.log(await page.evaluate(() => { const r = [...arena.remotes.values()][0]; const b = r.buf[r.buf.length - 1]; return JSON.stringify({ me: arena.curr, yaw: arena.yaw, pitch: arena.pitch, bot: b.pos, alive: b.alive }); }));
  }
  const st = await frame.evaluate(() => ({ botHp: [...parent.arena.remotes.values()][0].hp, shots: __G.combat.stats.shots, hits: __G.combat.stats.hits, feed: document.querySelector(".h-feed").textContent }));
  ok("the PAC-9 fired through the original weapon", st.shots > 0, `${st.shots} shots, ${st.hits} drawn as hits, bot hp ${st.botHp}`);
  ok("server awarded the browser player the kill", killed, await page.evaluate(() => `kills ${arena.me.kills}, server ammo ${arena.me.ammo}`));
  ok("bot saw the kill from the server", b.kills.some((k) => k.victim === b.id));
  ok("original HUD kill feed shows it", /You.*Bot/.test(st.feed), st.feed);

  // Walk forward 1 s with the real W key: prediction moves the camera and the server agrees.
  const start = await page.evaluate(() => [...arena.curr]);
  await page.keyboard.down("KeyW");
  await sleep(1000);
  await page.keyboard.up("KeyW");
  await sleep(500);
  const walk = await page.evaluate((s) => ({ moved: Math.hypot(arena.curr[0] - s[0], arena.curr[2] - s[2]), err: arena.predictor.last_error() }), start);
  // Standing still now: after two rendered frames the camera must sit exactly on the prediction.
  const f1 = await frame.evaluate(() => window.__frames);
  await frame.waitForFunction((f) => window.__frames >= f + 2, f1, { timeout: 20000 });
  const cam = await frame.evaluate(() => { const p = parent.arena.curr; return Math.hypot(__G.player.pos.x - p[0], __G.player.pos.z - p[2]); });
  // (Software-rendered headless Chromium runs at a few frames a second, so distance is not the test:
  // agreement with the server is.)
  ok("W walks; prediction matches the server", walk.moved > 0.5 && walk.err < 0.05, `moved ${walk.moved.toFixed(2)} m, last correction ${walk.err.toFixed(4)} m`);
  ok("first-person camera rides the prediction", cam < 0.05, `${cam.toFixed(3)} m`);

  await page.waitForFunction(() => { const r = [...arena.remotes.values()][0]; return r && r.alive; }, null, { timeout: 30000 });
  ok("bot respawned", true);
  if (SHOT) {
    await aim();
    await sleep(600);
    await page.screenshot({ path: SHOT });
    await page.keyboard.down("Tab");
    await sleep(400);
    await page.screenshot({ path: SHOT.replace(".png", "-scores.png") });
    await page.keyboard.up("Tab");
  }
  const bad = errs.filter((e) => !/favicon|fonts\.g|GL Driver/.test(e));
  ok("no page errors", bad.length === 0, bad.slice(0, 3).join(" | "));
  clearInterval(b.timer); b.ws.close();
  await browser.close();
  process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
