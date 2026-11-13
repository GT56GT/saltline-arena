// Builds the original Saltline renderer for Arena.
//
// Input:  game/saltline.min.js (the original game, unmodified) + game/shell.html (its page shell).
// Output: public/saltline/game.js + public/saltline/play.html.
//
// The original game keeps everything it draws: level, props, materials, lighting, post-processing,
// weather, effects, audio, first-person rifle and HUD. A handful of exact-text patches swap its
// single-player mission director for hooks the Arena client drives from the Rust server:
//   - `?arena=1` boots with an Arena game object instead of the mission (no title menu, no machines),
//   - the player's position comes from the server-checked prediction, not the game's own physics,
//   - the server decides health and death (no local fall damage, drowning or self-kill).
// Every patch must match exactly once, so a changed bundle fails the build instead of misbehaving.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "saltline");

const PATCHES = [
  [
    "boot: Arena game object in place of the mission director",
    "t.game=mM(t)",
    't.game=i.arena?{state:"arena",flow:null,menus:null,run:null,start(){},pause(){},resume(){},debugCut(){},' +
      "update(P){return t.arenaTick?t.arenaTick(P):!1}}:mM(t)",
  ],
  [
    "player: movement comes from the Arena prediction",
    "R=i.physics.moveCapsule(C.pos,C.vel,F,Pi.radius,o,l)||{}",
    "R=(i.arenaMove?i.arenaMove(C,F,o,l):i.physics.moveCapsule(C.pos,C.vel,F,Pi.radius,o,l))||{}",
  ],
  ["player: the server handles falling into the sea", "C.pos.y<oi.seaY-2.2&&", "!i.arenaMove&&C.pos.y<oi.seaY-2.2&&"],
  ["player: no local fall damage", "ce>13&&C.damage(", "ce>13&&!i.arenaMove&&C.damage("],
  [
    "player: only the server can kill the player",
    'C.health<=0&&(C.alive=!1,z=0,C.sprinting=!1,i.events.emit("player:dead",{}))',
    'C.health<=0&&!i.arenaMove&&(C.alive=!1,z=0,C.sprinting=!1,i.events.emit("player:dead",{}))',
  ],
  [
    "player: Arena can restart the death camera",
    "update:N};",
    "update:N,arenaDie(){C.alive=!1,z=0,C.sprinting=!1}};",
  ],
];

let src = readFileSync(join(here, "saltline.min.js"), "utf8");
for (const [what, from, to] of PATCHES) {
  const n = src.split(from).length - 1;
  if (n !== 1) {
    console.error(`[saltline] patch "${what}": anchor found ${n} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(from, () => to);
}

// Arena-only HUD tweaks: no relay counter, the objective panel becomes the match panel.
const arenaCss = `<style>
.h-relays { display: none !important; }
.hud .h-obj .h-k { letter-spacing: .18em; }
#boot .boot-mark::after { content: " ARENA"; color: #ffb347; }
</style>`;

let shell = readFileSync(join(here, "shell.html"), "utf8");
shell = shell.replace(/<title>[^<]*<\/title>/, "<title>Saltline Arena</title>");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "game.js"), src);
writeFileSync(join(out, "play.html"), `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${shell}\n${arenaCss}\n<script src="game.js"></script>\n<script src="loader.js"></script>\n`);

// glTF loader for character models, bundled against the game's own THREE (no second copy).
await build({
  entryPoints: [join(here, "loader-entry.js")],
  bundle: true,
  format: "iife",
  minify: true,
  outfile: join(out, "loader.js"),
  logLevel: "warning",
  plugins: [{
    name: "game-three",
    setup(b) {
      b.onResolve({ filter: /^three$/ }, () => ({ path: "three", namespace: "game-three" }));
      b.onLoad({ filter: /.*/, namespace: "game-three" }, () => ({ contents: "module.exports = window.__G.THREE;", loader: "js" }));
    },
  }],
});
console.log(`[saltline] patched ${PATCHES.length} hook points -> public/saltline/{game.js,play.html,loader.js}`);
