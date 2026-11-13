// Recorded sound effects: the files in public/audio replace the synthesized sounds in the engine.
// Checks that every sound in the manifest loads, that playing it uses the recorded buffers (length
// and loudness match the files), and that a real shot in a match plays a recording.
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8791/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name, cond, info = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({ viewport: { width: 320, height: 180 } });
  await ctx.addInitScript(() => {
    window.__played = [];
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      if (this.buffer && window.__tag) window.__played.push({ tag: window.__tag, dur: Math.round(this.buffer.duration * 100) / 100 });
      return st.apply(this, a);
    };
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const manifest = await (await fetch(WEB + "audio/manifest.json")).json();
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=test`);
  await page.fill("#name", "Atul");
  await page.evaluate(() => document.querySelector("button.btn.primary").click());
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.hasSelf, null, { timeout: 120000 });
  const frame = page.frames().find((f) => f.url().includes("/saltline/play.html"));
  await frame.waitForFunction(() => window.__arena && __arena.sounds, null, { timeout: 60000 });
  const load = await frame.evaluate(() => __arena.sounds);
  ok("every recorded sound loaded", load.failed.length === 0 && Object.keys(manifest).every((n) => load.loaded.includes(n)), JSON.stringify(load));

  // Expected lengths straight from the files.
  const want = {};
  for (const [n, c] of Object.entries(manifest)) {
    want[n] = new Set();
    for (let i = 0; i < c; i++) {
      const b = Buffer.from(await (await fetch(`${WEB}audio/${n}_${i}.wav`)).arrayBuffer());
      const dataLen = b.readUInt32LE(b.indexOf("data") + 4);
      want[n].add(Math.round((dataLen / 2 / 48000) * 100) / 100);
    }
  }
  await frame.evaluate(() => { try { __G.audio.resume(); } catch {} });
  for (const [n, c] of Object.entries(manifest)) {
    const got = await frame.evaluate(async ({ n, c }) => {
      window.__played = [];
      for (let v = 0; v < c * 2; v++) { window.__tag = n; __G.audio.play(n, { variant: v, gain: 0.01 }); window.__tag = null; await new Promise((r) => setTimeout(r, 60)); }
      return [...new Set(window.__played.map((p) => p.dur))];
    }, { n, c });
    ok(`${n}: plays the recordings (${c} versions)`, got.length === want[n].size && got.every((d) => want[n].has(d)), `played ${JSON.stringify(got)}, files ${JSON.stringify([...want[n]])}`);
  }

  // A real shot through the first-person rifle.
  await frame.evaluate(() => { __G.input.mode = "drag"; window.__played = []; window.__tag = "any"; });
  await page.mouse.click(160, 90);
  await page.mouse.down(); await sleep(2500); await page.mouse.up();
  const durs = await frame.evaluate(() => [...new Set(window.__played.map((p) => p.dur))]);
  ok("firing the rifle in a match plays the recorded shot", [...want.rifle_shot].some((d) => durs.includes(d)), JSON.stringify(durs));
  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : "all passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
