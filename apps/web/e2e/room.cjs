// Private room end to end: the browser creates a room (host), a scripted friend joins by code,
// the host puts them on opposite teams and starts 1 v 1 with bots off. Server decides everything.
const { chromium } = require("playwright");
const SERVER = process.env.SERVER || "ws://127.0.0.1:8791/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const SHOT = process.env.SHOT || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, info = "") => { const l = `${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`; out.push(l); console.log(l); };

function friend(code) {
  const ws = new WebSocket(SERVER);
  const f = { ws, id: 0, room: null, me: null, seq: 0, errors: [] };
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: "Friend", room: code }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") f.id = m.id;
    if (m.t === "room") f.room = m;
    if (m.t === "snapshot") f.me = m.players.find((p) => p.id === f.id);
    if (m.t === "error") f.errors.push(m.msg);
  };
  f.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "input", inputs: [{ seq: ++f.seq, mx: 0, mz: 0, yaw: 0, pitch: 0 }] })), 33);
  return f;
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 800, height: 450 } })).newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}&q=test&noaudio=1`);
  await page.fill("#name", "Atul");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Create room").click());
  await page.waitForFunction(() => window.arena && arena.status === "playing" && arena.room && arena.hasSelf, null, { timeout: 150000 });
  const room = await page.evaluate(() => arena.room);
  ok("browser created a private room and hosts it", room.host === (await page.evaluate(() => arena.id)), `code ${room.code}, live ${room.live}`);
  // The room code goes into the address bar once the match view mounts (after the matchmaking card).
  await page.waitForFunction((c) => location.search.includes(`room=${c}`), room.code, { timeout: 60000 }).catch(() => {});
  ok("address bar is the invite link", (await page.evaluate(() => location.search)).includes(`room=${room.code}`), await page.evaluate(() => location.search));

  const f = friend(room.code);
  await page.waitForFunction(() => arena.remotes.size === 1, null, { timeout: 30000, polling: 250 });
  ok("friend joined by code", f.room && f.room.code === room.code, `friend sees host ${f.room && f.room.host}`);
  const bots0 = await page.evaluate(() => [...arena.remotes.values()].filter((r) => r.bot).length);
  ok("no bots in a private room by default", bots0 === 0);

  // Put both on team 0 first: starting 2 v 0 must be refused (bots are off).
  await page.evaluate(() => arena.setTeam(0));
  f.ws.send(JSON.stringify({ t: "set_team", team: 0 }));
  await sleep(1500);
  await page.evaluate(() => arena.startMatch());
  await page.waitForFunction(() => arena.notice.t > 0, null, { timeout: 30000, polling: 250 });
  ok("starting with an empty team is refused", true, await page.evaluate(() => arena.notice.text));

  // A non-host cannot start.
  f.ws.send(JSON.stringify({ t: "start" }));
  await sleep(2000);
  ok("friend (not host) cannot start", f.errors.some((e) => /host/.test(e)), f.errors.join(" | "));

  // Friend moves to Rust: 1 v 1, host starts.
  f.ws.send(JSON.stringify({ t: "set_team", team: 1 }));
  await page.waitForFunction(() => [...arena.remotes.values()][0].team === 1, null, { timeout: 30000, polling: 250 });
  if (SHOT) {
    await page.evaluate(() => { arena.locked = false; arena.notify(); });
    await sleep(800);
    await page.screenshot({ path: SHOT.replace(".png", "-panel.png") });
  }
  await page.evaluate(() => arena.startMatch());
  await page.waitForFunction(() => arena.room.live, null, { timeout: 30000, polling: 250 });
  const st = await page.evaluate(() => ({ teams: [arena.me.team, [...arena.remotes.values()][0].team], bots: [...arena.remotes.values()].filter((r) => r.bot).length }));
  ok("host started the match 1 v 1 with bots off", st.bots === 0 && st.teams[0] === 0 && st.teams[1] === 1, JSON.stringify(st));
  const frame = page.frames().find((fr) => fr.url().includes("/saltline/play.html"));
  await frame.waitForFunction(() => /Harbour \d+ – \d+ Rust/.test(document.querySelector(".h-obj-t").textContent), null, { timeout: 30000 });
  ok("game HUD shows the team score", true, await frame.evaluate(() => document.querySelector(".h-obj-t").textContent));
  if (SHOT) await page.screenshot({ path: SHOT });
  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  clearInterval(f.timer); f.ws.close();
  await browser.close();
  process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
