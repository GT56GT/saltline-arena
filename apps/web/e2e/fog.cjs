// Fog of war, end to end: the real server (harbour map, normal far-apart spawns) withholds a
// silent, out-of-sight opponent's position; the browser draws nothing for them and can't hit them;
// when they run toward us they arrive (position, model) before reaching us.
// Run the server with MIN_PLAYERS=0 (default spawn rule) on :8792 and `vite preview` on :4173.
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8792/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, info = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

function bot(name) {
  const ws = new WebSocket(SERVER);
  const b = { ws, id: 0, me: null, seq: 0, yaw: 0, input: { mx: 0, mz: 0, sprint: false, crouch: false, jump: false, fire: false } };
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") b.id = m.id;
    if (m.t === "snapshot") { b.me = m.players.find((p) => p.id === b.id); b.others = m.players.filter((p) => p.id !== b.id); }
  };
  b.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++b.seq, yaw: b.yaw, pitch: 0, reload: false, view_tick: 0, ...b.input }] })), 33);
  return b;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 320, height: 180 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // Record what actually arrives on the wire about the bot.
  const wire = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => { try { const m = JSON.parse(f.payload); if (m.t === "snapshot") wire.push(m.players); } catch {} }));
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=test&noaudio=1`);
  await page.fill("#name", "Atul");
  await page.evaluate(() => document.querySelector("button.btn.primary").click());
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.hasSelf, null, { timeout: 120000 });
  const frame = page.frames().find((f) => f.url().includes("/saltline/play.html"));
  await frame.waitForFunction(() => window.__arena && __arena.opKit, null, { timeout: 60000 });

  const b = bot("Ghost");
  await page.waitForFunction(() => arena.remotes.size === 1, null, { timeout: 15000 });
  await sleep(2500); // past the one-second hold after spawning
  const st = await page.evaluate(() => { const r = [...arena.remotes.values()][0]; return { hidden: r.hidden, buf: r.buf.length, name: r.name }; });
  const meNow = await page.evaluate(() => arena.curr);
  const d0 = b.me ? Math.hypot(b.me.pos[0] - meNow[0], b.me.pos[2] - meNow[2]) : -1;
  console.log(`      bot spawned ${d0.toFixed(1)} m away; hidden=${st.hidden}`);
  ok("silent opponent out of sight: withheld by the server", st.hidden === true && st.buf === 0, JSON.stringify(st));
  const lastBot = wire.length ? wire[wire.length - 1].find((p) => p.id === b.id) : null;
  ok("  the wire carries no position for them", lastBot && lastBot.hidden && lastBot.pos.every((v) => v === 0), JSON.stringify(lastBot));
  ok("  scoreboard still lists them", await page.evaluate(() => arena.scoreboard().some((r) => r.name === "Ghost")));
  await frame.waitForFunction(() => __arena.avatars.size === 1, null, { timeout: 20000 });
  const av = await frame.evaluate(() => { const a = [...__arena.avatars.values()][0]; return { visible: a.root.visible }; });
  ok("  nothing drawn for them", av.visible === false, JSON.stringify(av));
  ok("  the bot can't see us either", b.others && b.others.every((p) => p.hidden), JSON.stringify(b.others && b.others.map((p) => p.hidden)));

  // Run at us: they must arrive before they reach us.
  let firstSeen = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    const me = await page.evaluate(() => arena.curr);
    if (b.me) {
      const dx = me[0] - b.me.pos[0], dz = me[2] - b.me.pos[2];
      const dist = Math.hypot(dx, dz);
      b.yaw = Math.atan2(-dx, -dz);
      b.input = { ...b.input, sprint: true, mz: 1, mx: (Date.now() / 1500 | 0) % 4 === 3 ? 1 : 0 };
      const hidden = await page.evaluate(() => [...arena.remotes.values()][0].hidden);
      if (!hidden && firstSeen == null) firstSeen = dist;
      if (!hidden && dist < 8) break;
    }
    await sleep(100);
  }
  b.input = { mx: 0, mz: 0, sprint: false, crouch: false, jump: false, fire: false };
  ok("running opponent arrives before reaching us", firstSeen != null && firstSeen > 5, firstSeen == null ? "never seen" : `first sent at ${firstSeen.toFixed(1)} m`);
  await frame.waitForFunction(() => [...__arena.avatars.values()][0].root.visible, null, { timeout: 30000 }).catch(() => {});
  ok("  and their model is drawn", await frame.evaluate(() => [...__arena.avatars.values()][0].root.visible));
  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  clearInterval(b.timer);
  b.ws.close();
  await browser.close();
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
