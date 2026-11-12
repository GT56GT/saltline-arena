// End-to-end: a real browser client vs a scripted bot, both on the real Rust server.
// The browser aims (through the client's own aim state) and holds fire; the server decides.
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8790/ws";
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
  // Stand still, facing anywhere; keep sending idle inputs like a real client.
  b.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++b.seq, mx: 0, mz: 0, yaw: 0, pitch: 0 }] })), 33);
  return b;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}`);
  await page.fill("#name", "Atul");
  await page.click("button.btn.primary");
  await page.waitForFunction(() => window.arena && window.arena.status === "playing" && window.arena.lastTick > 0, null, { timeout: 30000 });
  ok("browser joined the Rust server", true, await page.evaluate(() => `id ${arena.id}, tick ${arena.lastTick}`));

  const b = bot("Bot");
  await page.waitForFunction(() => arena.remotes.size === 1 && [...arena.remotes.values()][0].buf.length > 3, null, { timeout: 10000 });
  ok("bot appears as a remote player", true);

  await page.evaluate(() => { arena.locked = true; });
  // Aim at the bot's chest and hold fire until the server reports a kill.
  let killed = false;
  for (let i = 0; i < 120 && !killed; i++) {
    await page.evaluate(() => {
      const r = [...arena.remotes.values()][0];
      const pose = arena.remotePose(r, performance.now());
      if (!pose) return;
      const ex = arena.curr[0], ey = arena.curr[1] + arena.eyeHeight, ez = arena.curr[2];
      const dx = pose.pos[0] - ex, dz = pose.pos[2] - ez, dy = pose.pos[1] + 1.0 - ey;
      arena.yaw = Math.atan2(-dx, -dz);
      arena.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      arena.fireHeld = true;
    });
    await sleep(50);
    killed = await page.evaluate(() => arena.me.kills >= 1);
  }
  await page.evaluate(() => { arena.fireHeld = false; });
  ok("server awarded the browser player the kill", killed, await page.evaluate(() => `kills ${arena.me.kills}, ammo ${arena.me.ammo}`));
  ok("bot saw the kill from the server", b.kills.some((k) => k.victim === b.id));
  const feed = await page.evaluate(() => arena.feed.map((f) => f.text).join(" | "));
  ok("kill feed shows it", /You ▸ Bot/.test(feed), feed);

  // Walk forward for 1 s: prediction should move us and the server should agree.
  const start = await page.evaluate(() => [...arena.curr]);
  await page.evaluate(() => { arena.locked = true; arena.keys.add("KeyW"); });
  await sleep(1000);
  await page.evaluate(() => arena.keys.delete("KeyW"));
  await sleep(400);
  const walk = await page.evaluate((s) => ({ moved: Math.hypot(arena.curr[0] - s[0], arena.curr[2] - s[2]), err: arena.predictor.last_error(), pending: arena.predictor.pending() }), start);
  ok("predicted movement matches server", walk.moved > 2 && walk.err < 0.05, `moved ${walk.moved.toFixed(2)} m, last correction ${walk.err.toFixed(4)} m`);

  if (SHOT) {
    await page.evaluate(() => { arena.keys.add("Tab"); });
    await sleep(300);
    await page.screenshot({ path: SHOT.replace(".png", "-scores.png") });
    await page.evaluate(() => { arena.keys.delete("Tab"); });
    await sleep(3500); // let the bot respawn
    await page.evaluate(() => {
      const r = [...arena.remotes.values()][0];
      const pose = arena.remotePose(r, performance.now());
      const dx = pose.pos[0] - arena.curr[0], dz = pose.pos[2] - arena.curr[2];
      arena.yaw = Math.atan2(-dx, -dz); arena.pitch = -0.05;
    });
    await sleep(500);
    await page.screenshot({ path: SHOT });
  }
  const bad = errs.filter((e) => !/favicon|fonts\.g/.test(e));
  ok("no page errors", bad.length === 0, bad.slice(0, 3).join(" | "));
  clearInterval(b.timer); b.ws.close();
  await browser.close();
  process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
