// Visual check: the match renders through the original Saltline renderer, other players are
// drawn as operators, and the camera follows the server-checked prediction.
// Usage: node e2e/visual.cjs [outDir]   (server on :8790, `vite preview` on :4173)
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8790/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const OUT = process.argv[2] || ".";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name, cond, info = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=${process.env.Q || "test"}&noaudio=1`);
  await page.fill("#name", "Atul");
  await page.click("button.btn.primary");
  const t0 = Date.now();
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.hasSelf, null, { timeout: 120000 });
  ok("original renderer booted and joined", true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const frame = page.frames().find((f) => f.url().includes("/saltline/play.html"));
  await frame.waitForFunction(() => __G.game.state === "playing", null, { timeout: 20000 });
  await page.waitForFunction(() => arena.remotes.size > 0, null, { timeout: 20000 });
  await sleep(1500);

  const info = await frame.evaluate(() => {
    const G = __G, a = parent.arena;
    const avatars = G.scene.children.filter((o) => o.name === "arena-player");
    const p = a.smoothPos();
    return {
      avatars: avatars.length,
      remotes: a.remotes.size,
      camErr: Math.hypot(G.player.pos.x - p[0], G.player.pos.z - p[2]).toFixed(3),
      hp: G.player.health, ammo: G.weapon.ammo, weaponVisible: G.weapon.root.visible,
      hud: document.querySelector(".hud").classList.contains("on"),
      objective: document.querySelector(".h-obj-t").textContent,
      level: G.level.stats ? JSON.stringify(G.level.stats).slice(0, 80) : "",
    };
  });
  ok("other players are drawn as operator models", info.avatars === info.remotes && info.avatars > 0, `${info.avatars} avatars`);
  ok("camera sits on the predicted position", +info.camErr < 0.05, `error ${info.camErr} m`);
  ok("original HUD and rifle are live", info.hud && info.weaponVisible, `hp ${info.hp} ammo ${info.ammo} · "${info.objective}"`);
  await page.screenshot({ path: `${OUT}/arena-1-spawn.png` });

  // Face the nearest player and look at them for a portrait of the operator model.
  await frame.evaluate(() => {
    const G = __G, a = parent.arena, me = a.smoothPos();
    let best = null, bd = 1e9;
    for (const r of a.remotes.values()) {
      const p = a.remotePose(r, performance.now());
      if (!p || !p.alive) continue;
      const d = Math.hypot(p.pos[0] - me[0], p.pos[2] - me[2]);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) {
      G.player.yaw = Math.atan2(-(best.pos[0] - me[0]), -(best.pos[2] - me[2]));
      G.player.pitch = Math.atan2(best.pos[1] + 1.2 - (me[1] + 1.68), bd);
    }
    window.__dist = bd;
  });
  await sleep(700);
  await page.screenshot({ path: `${OUT}/arena-2-facing.png` });
  ok("faced nearest player", true, `${(await frame.evaluate(() => window.__dist)).toFixed(1)} m away`);

  // A close-up: park a free camera next to an avatar (debug only, the game's camera hook).
  await frame.evaluate(() => {
    const G = __G, av = G.scene.children.find((o) => o.name === "arena-player" && o.visible);
    if (!av) return;
    const p = av.position, yaw = av.rotation.y;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    window.__setShot({ cam: [p.x + fx * 2.2 + rx * 1.1, p.y + 1.55, p.z + fz * 2.2 + rz * 1.1, p.x, p.y + 1.1, p.z].join(",") });
  });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/arena-3-closeup.png` });
  await frame.evaluate(() => window.__setShot({ cam: "" }));

  ok("no page errors", errs.length === 0, errs.slice(0, 4).join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
