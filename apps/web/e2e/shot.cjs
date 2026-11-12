const { chromium } = require("playwright");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const p = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  p.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 200)));
  p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 300)));
  await p.goto("http://127.0.0.1:4173/?server=" + encodeURIComponent("ws://127.0.0.1:8790/ws"));
  await p.fill("#name", "Atul");
  await p.click("text=Deploy");
  await p.waitForFunction(() => window.arena?.status === "playing" && arena.remotes.size >= 3 && arena.map, null, { timeout: 20000 });
  const info = await p.evaluate(() => ({ map: arena.map.name, boxes: arena.map.boxes.length, me: arena.curr }));
  console.log(JSON.stringify(info));
  await p.evaluate(() => { arena.locked = true; arena.pitch = -0.05;
    const orig = arena.ws.send.bind(arena.ws); window.__bad = [];
    arena.ws.send = (d) => { if (/null|NaN/.test(d) && __bad.length < 3) __bad.push(d.slice(0, 300)); return orig(d); }; });
  for (const [i, yaw] of [[1, null], [2, 1.2]]) {
    await p.evaluate((y) => { if (y !== null) arena.yaw += y; }, yaw);
    await sleep(2500);
    console.log("status", await p.evaluate(() => arena.status + " " + arena.error), JSON.stringify(await p.evaluate(() => __bad)));
    await p.screenshot({ path: `${process.env.SHOTS}/harbour${i}.png`, timeout: 90000 });
  }
  await b.close();
})();
