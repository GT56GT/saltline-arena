// Builds the original Saltline renderer for Hushline (the match view).
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
// Also exposed for the settings menu: per-channel audio volume and the renderer's quality presets.
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
    "audio: per-channel volume (settings), ducking, and recorded sounds in place of synthesized ones",
    "Object.assign(Re,{ctx:e,resume:yr,play:ze,",
    "Object.assign(Re,{setBus(n,v){let b=H[n];if(!b)return;b._base={world:1,near:.95,amb:.55,dry:1,music:.62}[n]*Math.max(0,Math.min(1,+v||0));let t=e.currentTime;b.gain.cancelScheduledValues(t);b.gain.setValueAtTime(b._base,t)}," +
      // duckBus: dip a channel to k of its level (attack a s), hold h s, recover over r s.
      "duckBus(n,k,a,h,r){let b=H[n];if(!b)return;let base=b._base!=null?b._base:b.gain.value,t=e.currentTime;b._base=base;b.gain.cancelScheduledValues(t);b.gain.setValueAtTime(b.gain.value,t);b.gain.setTargetAtTime(base*k,t,a/3);b.gain.setTargetAtTime(base,t+a+h,r/3)}," +
      // setBuffers: recorded versions of a sound replace the synthesized ones (the engine generates
      // only what is missing from its cache, so these win; the variant count follows the files).
      "setBuffers(n,bs){let d=Go[n];if(!d||d.loop||!bs||!bs.length)return!1;bs.forEach((b,i)=>r.set(n+\"#\"+i,b));d.n=bs.length;Pe[n]=0;return!0},ctx:e,resume:yr,play:ze,",
  ],
  [
    "render: expose the quality presets to the settings menu",
    "window.__G=t;",
    "window.__G=t;t.QUALITY=Pr;",
  ],
  // Other players' footsteps and shots: the game files its step and rifle sounds on the "near"
  // (first-person) channel, which plays centred with no distance. These let Arena send any sound
  // through the 3D voices (`world`), with head-related panning (`hrtf`), a per-voice low-pass
  // filter (`lp`, Hz) and its own voice cap and priority (`max`, `pri`).
  [
    "audio: a low-pass filter on every 3D voice",
    "he?(pe.pan=F(!1),pe.g.connect(pe.pan),pe.pan.connect(H[te])):pe.g.connect(H[te])",
    'he?(pe.pan=F(!1),pe.lp=e.createBiquadFilter(),pe.lp.type="lowpass",pe.lp.frequency.value=22e3,pe.g.connect(pe.lp),pe.lp.connect(pe.pan),pe.pan.connect(H[te])):pe.g.connect(H[te])',
  ],
  [
    "audio: play any sound in 3D on request",
    'Ue=!!ke&&pe.bus==="world",',
    'Ue=!!ke&&(pe.bus==="world"||!!he.world),',
  ],
  [
    "audio: per-play voice cap and priority",
    "De=Fe(ct,te,pe,Le);",
    "De=Fe(ct,te,he.max||he.pri?Object.assign({},pe,he.max?{max:he.max}:{},he.pri?{pri:he.pri}:{}):pe,Le);",
  ],
  [
    "audio: per-play HRTF and low-pass",
    "ie(De.pan,Ht.x||0,Ht.y||0,Ht.z||0),",
    'ie(De.pan,Ht.x||0,Ht.y||0,Ht.z||0),De.pan.panningModel=he.hrtf?"HRTF":"equalpower",De.lp&&(De.lp.frequency.cancelScheduledValues(Le),De.lp.frequency.setValueAtTime(he.lp||22e3,Le)),',
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
#boot .boot-mark::after { content: "LINE"; color: #ffb347; }
/* Noise indicator: how far your own movement can be heard. Sits where health fades in, and moves up while it shows. */
.h-noise { position: absolute; left: var(--gl); bottom: calc(22px + var(--sab)); display: flex; align-items: center; gap: 4px; font: 600 11px/1 var(--f-label); letter-spacing: .22em; text-transform: uppercase; color: var(--bone-dim); transition: transform .25s, opacity .25s; }
.h-noise b { font-weight: 600; min-width: 5.6em; margin-right: 4px; color: var(--bone); }
.h-noise i { width: 10px; height: 4px; box-shadow: inset 0 0 0 1px var(--bone-faint); }
.h-noise i.on { background: var(--bone); box-shadow: 0 0 2px rgba(0, 0, 0, .6); }
.h-noise[data-l="3"] b { color: var(--signal); }
.h-noise[data-l="3"] i.on { background: var(--signal); }
.h-noise em { font: 500 11px/1 var(--f-mono); letter-spacing: .04em; font-style: normal; margin-left: 6px; }
.h-noise.off { opacity: 0; }
.h-health.on ~ .h-noise { transform: translateY(-62px); }
@media (pointer: coarse) { .h-noise { display: none; } }
</style>`;

let shell = readFileSync(join(here, "shell.html"), "utf8");
shell = shell.replace(/<title>[^<]*<\/title>/, "<title>Hushline</title>");
// Loading screen wordmark: HUSH + LINE (amber, via CSS below).
shell = shell.replace('<div class="boot-mark">SALTLINE</div>', '<div class="boot-mark">HUSH</div>');
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
