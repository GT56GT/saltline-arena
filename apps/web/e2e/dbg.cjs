const { chromium } = require("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  await page.goto("http://127.0.0.1:4173/?server=" + encodeURIComponent("ws://127.0.0.1:8790/ws"));
  await page.fill("#name", "Atul"); await page.click("button.btn.primary");
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.lastTick > 0);
  const ws = new WebSocket("ws://127.0.0.1:8790/ws"); let seq = 0;
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: "Bot" }));
  const t = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++seq, mx: 0, mz: 0, yaw: 0, pitch: 0 }] })), 33);
  await page.waitForFunction(() => arena.remotes.size === 1 && [...arena.remotes.values()][0].buf.length > 3);
  await page.evaluate(() => { arena.locked = true; window.__hits = 0; });
  const info = await page.evaluate(() => {
    const r = [...arena.remotes.values()][0]; const pose = arena.remotePose(r, performance.now());
    const ex = arena.curr[0], ey = arena.curr[1] + arena.eyeHeight, ez = arena.curr[2];
    const dx = pose.pos[0] - ex, dz = pose.pos[2] - ez, dy = pose.pos[1] + 1 - ey; const L = Math.hypot(dx, dy, dz);
    const wall = arena.predictor.raycast(ex, ey, ez, dx / L, dy / L, dz / L, 200);
    return { me: arena.curr, bot: pose.pos, dist: L, wall };
  });
  console.log(JSON.stringify(info));
  await page.evaluate(() => { window.__mine = []; window.__sent = []; arena.ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if ((m.t === 'shot' && m.shooter === arena.id) || m.t === 'hit') __mine.push(m); });
    const orig = arena.ws.send.bind(arena.ws); arena.ws.send = (d) => { const m = JSON.parse(d); if (m.t === 'input' && m.inputs[0].fire) __sent.push(m.inputs[0]); return orig(d); }; });
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => { const r = [...arena.remotes.values()][0]; const pose = arena.remotePose(r, performance.now());
      const ex = arena.curr[0], ey = arena.curr[1] + arena.eyeHeight, ez = arena.curr[2]; const dx = pose.pos[0] - ex, dz = pose.pos[2] - ez, dy = pose.pos[1] + 1 - ey;
      arena.yaw = Math.atan2(-dx, -dz); arena.pitch = Math.atan2(dy, Math.hypot(dx, dz)); arena.fireHeld = true; });
    await sleep(50);
  }
  console.log(JSON.stringify(await page.evaluate(() => ({ sent: __sent.slice(0, 2), n: __sent.length, got: __mine.slice(0, 3), eye: arena.eyeHeight }))));
  clearInterval(t); ws.close(); await browser.close(); process.exit(0);
})();
