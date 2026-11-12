// Full player journey in a real browser against the real Rust server:
// wallet sign-in -> callsign -> claim + equip cosmetic -> match with bots -> rating card -> profile + leaderboard.
// The "wallet" is a test key held by this script; the page talks to it through window.ethereum.
const { chromium } = require("playwright");
const { privateKeyToAccount } = require("viem/accounts");
const { hexToString } = require("viem");

const SERVER = process.env.SERVER || "ws://127.0.0.1:8790/ws";
const WEB = process.env.WEB || "http://127.0.0.1:4173/";
const SHOTS = process.env.SHOTS || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, info = "") => { const l = `${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`; out.push(l); console.log(l); };

// Hardhat/Anvil test key #3 — public, never holds real funds.
const account = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.exposeFunction("__walletSign", async (hex) => account.signMessage({ message: hexToString(hex) }));
  await ctx.addInitScript((addr) => {
    window.ethereum = {
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "eth_chainId") return "0x14a34";
        if (method === "personal_sign") return window.__walletSign(params[0]);
        throw new Error(`test wallet: ${method} not supported`);
      },
    };
  }, account.address);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`${WEB}?server=${encodeURIComponent(SERVER)}`);

  // 1. Sign in with the wallet.
  await page.click("text=Sign in with wallet");
  await page.waitForSelector(".who", { timeout: 15000 });
  const who = await page.textContent(".who");
  ok("wallet sign-in creates an account", /1500 rating · 0 matches/.test(who), who.replace(/\s+/g, " "));

  // 2. Callsign.
  await page.fill("#cs", "clover");
  await page.click("text=Save");
  await page.waitForFunction(() => document.querySelector(".who b")?.textContent === "clover", null, { timeout: 5000 });
  ok("callsign saved", true);

  // 3. Cosmetics: claim + equip the Founders Visor.
  await page.click(".tabs >> text=Cosmetics");
  await page.waitForSelector(".items li");
  await page.click(".items li:has-text('Founders Visor') >> text=Claim");
  await page.waitForSelector(".items li.owned:has-text('Founders Visor')");
  await page.click(".items li:has-text('Founders Visor') >> text=Equip");
  await page.waitForSelector(".items li:has-text('Founders Visor') >> text=Unequip");
  ok("cosmetic claimed and equipped", true);
  const locked = await page.locator(".items li.locked").count();
  ok("unearned cosmetics stay locked", locked >= 4, `${locked} locked`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lobby.png` });

  // 4. Deploy: we join a room topped up with bots, under our callsign.
  await page.click("text=Deploy");
  await page.waitForFunction(() => window.arena?.status === "playing" && arena.remotes.size >= 3, null, { timeout: 20000 });
  const roster = await page.evaluate(() => [...arena.remotes.values()].map((r) => `${r.name}${r.bot ? "(bot)" : ""}`).join(", "));
  ok("room filled with bots", (roster.match(/\(bot\)/g) || []).length === 3, roster);
  await page.evaluate(() => { arena.locked = true; });

  // 5. Fight until the 45 s match ends: aim at the nearest visible bot and hold fire.
  const start = Date.now();
  let ended = false;
  while (Date.now() - start < 70000 && !ended) {
    await page.evaluate(() => {
      let best = null, bd = 1e9;
      for (const r of arena.remotes.values()) {
        const p = arena.remotePose(r, performance.now());
        if (!p || !p.alive) continue;
        const d = Math.hypot(p.pos[0] - arena.curr[0], p.pos[2] - arena.curr[2]);
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) { arena.fireHeld = false; return; }
      const ex = arena.curr[0], ey = arena.curr[1] + arena.eyeHeight, ez = arena.curr[2];
      const dx = best.pos[0] - ex, dz = best.pos[2] - ez, dy = best.pos[1] + 1.1 - ey;
      arena.yaw = Math.atan2(-dx, -dz);
      arena.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      arena.fireHeld = true;
    });
    await sleep(80);
    ended = await page.evaluate(() => !!arena.result);
    if (SHOTS && Date.now() - start > 12000 && Date.now() - start < 12200) await page.screenshot({ path: `${SHOTS}/fight.png` });
  }
  const res = await page.evaluate(() => arena.result && { before: arena.result.before, after: arena.result.me.stats.rating, matches: arena.result.me.stats.matches, kills: arena.result.me.stats.kills });
  ok("match ended and result card shows the rating change", !!res, JSON.stringify(res));
  ok("profile counts the match", res && res.matches === 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/result.png` });

  // 6. Back in the lobby: profile + leaderboard reflect it.
  await page.evaluate(() => arena.disconnect());
  await page.waitForSelector(".who");
  await page.click(".tabs >> text=Profile");
  await page.waitForSelector(".tbl tbody tr");
  const recent = await page.textContent(".tbl tbody tr");
  ok("recent match listed in profile", /\/\s*4/.test(recent), recent.replace(/\s+/g, " "));
  await page.click(".tabs >> text=Leaderboard");
  await page.waitForSelector(".tbl tbody tr");
  const top = await page.textContent(".tbl tbody tr");
  ok("leaderboard lists the player", /clover/.test(top), top.replace(/\s+/g, " "));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/leaderboard.png` });

  const bad = errs.filter((e) => !/fonts\.g/.test(e));
  ok("no page errors", bad.length === 0, bad.slice(0, 3).join(" | "));
  await browser.close();
  process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
