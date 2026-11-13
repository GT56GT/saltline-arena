// Other players, drawn inside the original Saltline renderer.
//
// The original game is first-person only, so it has no body for a person. This builds one in the
// same visual language: the game's own PBR material library (armour, glove fabric, polymer, rubber)
// and a clone of the original PAC-9 rifle mesh from the first-person viewmodel. Arms are solved with
// two-bone IK every frame so the hands stay on the rifle at any aim pitch.
//
// Everything here uses the THREE instance that lives inside the game's iframe (G.THREE).

/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;

export const BODY_RADIUS = 0.32;
export const HEAD_RADIUS = 0.14;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.15;

export interface Kit {
  T: any;
  mats: Record<string, any>;
  visor: (color: string | null) => any;
  plates: (color: string | null) => any;
  rifle: () => { group: any; muzzle: any };
  geo: Record<string, any>;
}

/** Shared materials and geometry for every avatar (built once per renderer). */
export function makeKit(G: G): Kit {
  const T = G.THREE;
  const m = (name: string, color?: number) => G.mats.get(name, color === undefined ? {} : { color });
  const mats = {
    suit: m("glove_fabric", 0x6c7262),
    suitDark: m("glove_fabric", 0x4b5045),
    plate: m("armor_white", 0x9aa0a2),
    pouch: m("polymer_tan"),
    black: m("polymer_black"),
    rubber: m("rubber"),
    metal: m("gunmetal"),
    skin: m("glove_fabric", 0x1b1d1e),
  };
  const visorCache = new Map<string, any>();
  const visor = (color: string | null) => {
    const key = color || "default";
    let v = visorCache.get(key);
    if (!v) {
      const c = new T.Color(color || "#9fd8ff");
      v = new T.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.25), emissive: c, emissiveIntensity: 1.1, roughness: 0.12, metalness: 0.6 });
      v.name = "arena_visor";
      visorCache.set(key, v);
    }
    return v;
  };
  const plateCache = new Map<string, any>();
  const plates = (color: string | null) => {
    if (!color) return mats.plate;
    let p = plateCache.get(color);
    if (!p) {
      p = G.mats.get("armor_white", { color: new T.Color(color).getHex() });
      plateCache.set(color, p);
    }
    return p;
  };

  // The PAC-9 from the first-person viewmodel: keep the rifle (pac9_* + magazine/brass), drop the
  // gloves, muzzle-flash and sight quads. Geometry and materials are shared, not copied.
  const vm = G.weapon && G.weapon.root;
  let template: any = null;
  let muzzleLocal = new T.Vector3(0, 0, -0.8);
  if (vm) {
    try { G.weapon.reset && G.weapon.reset(); } catch { /* fine */ }
    template = new T.Group();
    const keep = (o: any): boolean => {
      let ok = false;
      o.traverse((c: any) => {
        const n = c.material && !Array.isArray(c.material) ? String(c.material.name || "") : "";
        if (c.isMesh && (n.startsWith("pac9") || n === "brass")) ok = true;
      });
      return ok;
    };
    vm.updateMatrixWorld(true);
    for (const child of vm.children) {
      if (!keep(child)) continue;
      const c = child.clone(true);
      c.traverse((o: any) => {
        if (o.isMesh) {
          const n = o.material && !Array.isArray(o.material) ? String(o.material.name || "") : "";
          if (!(n.startsWith("pac9") || n === "brass")) o.visible = false;
          o.castShadow = true;
          o.receiveShadow = true;
        }
        o.layers.set(0);
      });
      template.add(c);
    }
    // Normalise: barrel along -Z, ~0.86 m long, origin at the pistol grip.
    const box = new T.Box3().setFromObject(template);
    const size = box.getSize(new T.Vector3());
    const len = Math.max(size.z, 1e-3);
    const s = 0.86 / len;
    template.scale.setScalar(s);
    const b2 = new T.Box3().setFromObject(template);
    const c2 = b2.getCenter(new T.Vector3());
    // Grip sits about 60% of the way back from the muzzle and below the bore.
    const grip = new T.Vector3(c2.x, b2.min.y + (b2.max.y - b2.min.y) * 0.45, b2.min.z + (b2.max.z - b2.min.z) * 0.62);
    template.position.sub(grip);
    muzzleLocal = new T.Vector3(c2.x - grip.x, b2.max.y - (b2.max.y - b2.min.y) * 0.32 - grip.y, b2.min.z - grip.z);
  }
  const rifle = () => {
    const group = new T.Group();
    if (template) group.add(template.clone(true));
    else {
      const body = new T.Mesh(new T.BoxGeometry(0.06, 0.1, 0.8), mats.metal);
      body.position.z = -0.25;
      group.add(body);
    }
    const muzzle = new T.Object3D();
    muzzle.position.copy(muzzleLocal);
    group.add(muzzle);
    return { group, muzzle };
  };

  // Rounded box from an extruded rounded rectangle (three's RoundedBoxGeometry is not in the bundle).
  const rbox = (w: number, h: number, d: number, r: number) => {
    const s = new T.Shape();
    const x = -w / 2 + r, y = -h / 2 + r, ww = w - 2 * r, hh = h - 2 * r;
    s.moveTo(x, y - r);
    s.lineTo(x + ww, y - r);
    s.quadraticCurveTo(x + ww + r, y - r, x + ww + r, y);
    s.lineTo(x + ww + r, y + hh);
    s.quadraticCurveTo(x + ww + r, y + hh + r, x + ww, y + hh + r);
    s.lineTo(x, y + hh + r);
    s.quadraticCurveTo(x - r, y + hh + r, x - r, y + hh);
    s.lineTo(x - r, y);
    s.quadraticCurveTo(x - r, y - r, x, y - r);
    const g = new T.ExtrudeGeometry(s, { depth: Math.max(1e-3, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.9, bevelSegments: 3, curveSegments: 5 });
    g.translate(0, 0, -(d - 2 * r) / 2);
    g.computeVertexNormals();
    return g;
  };
  const cap = (r: number, len: number) => new T.CapsuleGeometry(r, len, 6, 14);
  const geo = {
    pelvis: new T.SphereGeometry(1, 18, 12),
    thigh: cap(0.095, 0.27),
    shin: cap(0.076, 0.3),
    knee: rbox(0.12, 0.12, 0.07, 0.03),
    boot: rbox(0.13, 0.12, 0.28, 0.045),
    abdomen: cap(0.15, 0.12),
    chest: cap(0.165, 0.16),
    plateF: rbox(0.34, 0.36, 0.055, 0.025),
    plateB: rbox(0.34, 0.4, 0.06, 0.025),
    band: rbox(0.42, 0.12, 0.3, 0.04),
    pouch: rbox(0.085, 0.13, 0.06, 0.018),
    radio: rbox(0.1, 0.15, 0.065, 0.018),
    antenna: new T.CylinderGeometry(0.005, 0.005, 0.3, 6),
    pad: rbox(0.13, 0.08, 0.14, 0.035),
    neck: new T.CylinderGeometry(0.055, 0.065, 0.1, 12),
    head: new T.SphereGeometry(0.105, 20, 14),
    helmet: new T.SphereGeometry(0.138, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.56),
    rim: new T.TorusGeometry(0.131, 0.012, 6, 28),
    visor: new T.SphereGeometry(0.128, 24, 8, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.42, Math.PI * 0.2),
    ear: new T.CylinderGeometry(0.045, 0.045, 0.04, 14),
    nvg: rbox(0.07, 0.05, 0.06, 0.012),
    upper: cap(0.066, 0.19),
    fore: cap(0.058, 0.2),
    glove: new T.SphereGeometry(0.056, 12, 10),
  };
  return { T, mats, visor, plates, rifle, geo };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (a: number, b: number, k: number, dt: number) => lerp(a, b, 1 - Math.exp(-k * dt));
const wrapAngle = (a: number) => ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;

export interface AvatarPose { pos: [number, number, number]; yaw: number; pitch: number; crouch: boolean; alive: boolean; climb?: boolean }

export class Avatar {
  root: any;
  private T: any;
  private kit: Kit;
  private hips: any;
  private torso: any;
  private head: any;
  private aim: any;
  private legs: { hip: any; knee: any }[] = [];
  private arms: { upper: any; fore: any; glove: any; shoulder: any; side: number }[] = [];
  private gun: { group: any; muzzle: any };
  private tag: any;
  private tagCanvas: HTMLCanvasElement;
  private tagText = "";
  private platesMeshes: any[] = [];
  private visorMesh: any;
  private cosmetic: string | null = null;

  // animation state
  private phase = 0;
  private crouchK = 0;
  private lastPos: any;
  private speed = 0;
  private moveAngle = 0;
  private deadT = -1;
  private fireT = 9;
  pose: AvatarPose | null = null;
  private speedNow = 0;
  /** Footfalls so far (the bridge plays a step sound for each new one). */
  steps = 0;
  private lastFoot = 0;
  /** Whether the name tag should show (bridge decides: teammate, or under the crosshair). */
  tagWanted = true;
  /** Current speed over the ground, m/s (footstep loudness). */
  get groundSpeed() { return this.speedNow; }
  bodyHeight = STAND_HEIGHT;

  constructor(kit: Kit, name: string, doc: Document) {
    const T = (this.T = kit.T);
    this.kit = kit;
    const { mats, geo } = kit;
    const mesh = (g: any, m: any) => {
      const o = new T.Mesh(g, m);
      o.castShadow = true;
      o.receiveShadow = true;
      return o;
    };
    this.root = new T.Group();
    this.root.name = "arena-player";
    this.lastPos = new T.Vector3();

    // --- hips and legs
    this.hips = new T.Group();
    this.hips.position.y = 0.95;
    this.root.add(this.hips);
    const pelvis = mesh(geo.pelvis, mats.suit);
    pelvis.scale.set(0.19, 0.125, 0.135);
    this.hips.add(pelvis);
    const legsRoot = new T.Group();
    this.hips.add(legsRoot);
    for (const side of [-1, 1]) {
      const hip = new T.Group();
      hip.position.set(0.105 * side, -0.03, 0);
      legsRoot.add(hip);
      const thigh = mesh(geo.thigh, mats.suit);
      thigh.position.y = -0.22;
      hip.add(thigh);
      const knee = new T.Group();
      knee.position.y = -0.44;
      hip.add(knee);
      const pad = mesh(geo.knee, mats.black);
      pad.position.set(0, -0.02, -0.065);
      knee.add(pad);
      const shin = mesh(geo.shin, mats.suitDark);
      shin.position.y = -0.21;
      knee.add(shin);
      const boot = mesh(geo.boot, mats.rubber);
      boot.position.set(0, -0.44, -0.045);
      knee.add(boot);
      this.legs.push({ hip, knee });
    }
    (this as any).legsRoot = legsRoot;

    // --- torso
    this.torso = new T.Group();
    this.torso.position.y = 0.04;
    this.hips.add(this.torso);
    const abdomen = mesh(geo.abdomen, mats.suit);
    abdomen.scale.set(1.12, 1, 0.82);
    abdomen.position.y = 0.13;
    this.torso.add(abdomen);
    const chest = mesh(geo.chest, mats.suit);
    chest.scale.set(1.28, 1, 0.82);
    chest.position.y = 0.36;
    this.torso.add(chest);
    const plateF = mesh(geo.plateF, mats.plate);
    plateF.position.set(0, 0.37, -0.14);
    this.torso.add(plateF);
    const plateB = mesh(geo.plateB, mats.plate);
    plateB.position.set(0, 0.36, 0.14);
    this.torso.add(plateB);
    this.platesMeshes.push(plateF, plateB);
    const band = mesh(geo.band, mats.pouch);
    band.position.set(0, 0.22, 0);
    this.torso.add(band);
    for (let i = -1; i <= 1; i++) {
      const p = mesh(geo.pouch, mats.pouch);
      p.position.set(i * 0.095, 0.27, -0.185);
      this.torso.add(p);
    }
    const radio = mesh(geo.radio, mats.black);
    radio.position.set(-0.08, 0.4, 0.195);
    this.torso.add(radio);
    const ant = mesh(geo.antenna, mats.black);
    ant.position.set(-0.11, 0.6, 0.2);
    ant.rotation.z = 0.12;
    this.torso.add(ant);
    for (const side of [-1, 1]) {
      const pad = mesh(geo.pad, mats.plate);
      pad.position.set(0.215 * side, 0.52, 0);
      pad.rotation.z = -0.35 * side;
      this.torso.add(pad);
      this.platesMeshes.push(pad);
    }
    const neck = mesh(geo.neck, mats.skin);
    neck.position.y = 0.6;
    this.torso.add(neck);

    // --- head
    this.head = new T.Group();
    this.head.position.y = 0.72;
    this.torso.add(this.head);
    const headM = mesh(geo.head, mats.skin);
    headM.scale.set(0.95, 1.05, 1);
    this.head.add(headM);
    const helmet = mesh(geo.helmet, mats.plate);
    helmet.position.y = 0.012;
    helmet.scale.set(1, 0.92, 1.06);
    this.head.add(helmet);
    this.platesMeshes.push(helmet);
    const rim = mesh(geo.rim, mats.black);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.014;
    rim.scale.set(1, 1.06, 1);
    this.head.add(rim);
    this.visorMesh = mesh(geo.visor, kit.visor(null));
    this.visorMesh.castShadow = false;
    this.head.add(this.visorMesh);
    for (const side of [-1, 1]) {
      const ear = mesh(geo.ear, mats.black);
      ear.rotation.z = Math.PI / 2;
      ear.position.set(0.12 * side, -0.01, 0.005);
      this.head.add(ear);
    }
    const nvg = mesh(geo.nvg, mats.metal);
    nvg.position.set(0, 0.09, -0.12);
    nvg.rotation.x = -0.4;
    this.head.add(nvg);

    // --- aim frame (pitches with the player's aim) carries the rifle; arms reach for it by IK
    this.aim = new T.Group();
    this.aim.position.set(0.02, 0.5, -0.02);
    this.torso.add(this.aim);
    this.gun = kit.rifle();
    this.gun.group.position.set(0.09, -0.07, -0.26);
    this.aim.add(this.gun.group);
    for (const side of [-1, 1]) {
      const shoulder = new T.Vector3(0.2 * side, 0.5, -0.01);
      const upper = mesh(geo.upper, mats.suit);
      const fore = mesh(geo.fore, mats.suit);
      const glove = mesh(geo.glove, mats.black);
      this.torso.add(upper, fore, glove);
      this.arms.push({ upper, fore, glove, shoulder, side });
    }

    // --- name tag (hidden by walls; only drawn when reasonably close)
    this.tagCanvas = doc.createElement("canvas");
    this.tagCanvas.width = 256;
    this.tagCanvas.height = 64;
    const tex = new T.CanvasTexture(this.tagCanvas);
    tex.colorSpace = T.SRGBColorSpace;
    this.tag = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
    this.tag.scale.set(0.8, 0.2, 1);
    this.tag.position.y = 2.05;
    this.tag.renderOrder = 10;
    this.root.add(this.tag);
    this.setName(name);
  }

  setName(name: string) {
    if (name === this.tagText) return;
    this.tagText = name;
    const c = this.tagCanvas.getContext("2d")!;
    c.clearRect(0, 0, 256, 64);
    c.font = '600 30px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    const w = Math.min(240, c.measureText(name).width + 28);
    c.fillStyle = "rgba(8,10,12,0.62)";
    c.fillRect(128 - w / 2, 14, w, 36);
    c.fillStyle = "#ffb347";
    c.fillRect(128 - w / 2, 14, 3, 36);
    c.fillStyle = "#eef2f0";
    c.fillText(name.toUpperCase(), 130, 33);
    this.tag.material.map.needsUpdate = true;
  }

  setLook(id: string | null, look: { slot: "visor" | "plates"; color: string } | null, teamColor: string | null, ally: boolean) {
    const key = `${id}|${teamColor}|${ally}`;
    if (key === this.cosmetic) return;
    this.cosmetic = key;
    this.visorMesh.material = this.kit.visor(look && look.slot === "visor" ? look.color : null);
    const plate = this.kit.plates(teamColor || (look && look.slot === "plates" ? look.color : null));
    for (const m of this.platesMeshes) m.material = plate;
    this.tag.material.depthTest = !ally;
  }

  /** World position of the rifle's muzzle (for tracers, flashes and sound). */
  muzzleWorld(out: any) {
    this.root.updateMatrixWorld(true);
    return this.gun.muzzle.getWorldPosition(out);
  }

  fired() {
    this.fireT = 0;
  }

  /** Two-bone IK: place upper arm and forearm so the hand reaches `hand` (torso space). */
  private solveArm(a: { upper: any; fore: any; glove: any; shoulder: any; side: number }, hand: any) {
    const T = this.T;
    const L1 = 0.27, L2 = 0.27;
    const S = a.shoulder;
    const toH = hand.clone().sub(S);
    const d = Math.min(L1 + L2 - 1e-3, Math.max(0.05, toH.length()));
    toH.setLength(d);
    // Elbow bends down and outwards.
    const pole = new T.Vector3(0.6 * a.side, -1, 0.25).normalize();
    const dir = toH.clone().normalize();
    const along = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - along * along));
    const bend = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const E = S.clone().add(dir.clone().multiplyScalar(along)).add(bend.multiplyScalar(h));
    const H = S.clone().add(toH);
    const place = (mesh: any, from: any, to: any) => {
      const mid = from.clone().add(to).multiplyScalar(0.5);
      mesh.position.copy(mid);
      const v = to.clone().sub(from).normalize();
      mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v);
    };
    place(a.upper, S, E);
    place(a.fore, E, H);
    a.glove.position.copy(H);
  }

  /** Advance animation to `pose` (already interpolated by the client). */
  update(pose: AvatarPose, dt: number, camPos: any) {
    const T = this.T;
    this.pose = pose;
    const r = this.root;
    const p = new T.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]);

    // Death: topple backwards, then fade out until the server respawns them.
    if (!pose.alive) {
      if (this.deadT < 0) this.deadT = 0;
      this.deadT += dt;
      const k = Math.min(1, this.deadT / 0.55);
      const e = k * k * (3 - 2 * k);
      r.position.copy(p);
      r.rotation.set(-e * 1.45, pose.yaw, 0, "YXZ");
      r.position.y = p.y + 0.18 * e;
      this.tag.visible = false;
      r.visible = this.deadT < 2.4;
      return;
    }
    if (this.deadT >= 0) {
      this.deadT = -1;
      r.rotation.set(0, pose.yaw, 0, "YXZ");
      this.lastPos.copy(p);
    }
    r.visible = true;

    // Motion from the interpolated positions.
    const vx = (p.x - this.lastPos.x) / Math.max(dt, 1e-3);
    const vz = (p.z - this.lastPos.z) / Math.max(dt, 1e-3);
    const teleport = Math.hypot(vx, vz) > 25;
    this.lastPos.copy(p);
    const sp = teleport ? 0 : Math.hypot(vx, vz);
    this.speed = damp(this.speed, sp, 10, dt);
    this.speedNow = this.speed;
    if (sp > 0.3 && !teleport) {
      // Movement direction relative to facing: legs turn into strafes, backpedal reverses the cycle.
      const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
      const rx = Math.cos(pose.yaw), rz = -Math.sin(pose.yaw);
      const fwd = (vx * fx + vz * fz) / sp, side = (vx * rx + vz * rz) / sp;
      let ang = Math.atan2(-side, Math.abs(fwd) + 1e-3);
      ang = Math.max(-1.0, Math.min(1.0, ang));
      this.moveAngle = damp(this.moveAngle, fwd < -0.2 ? -ang : ang, 8, dt);
      const stride = this.speed > 5 ? 2.1 : 1.55;
      this.phase += ((fwd < -0.2 ? -1 : 1) * this.speed * dt) / stride;
      // One footfall per half stride cycle (each foot), for footstep sounds.
      const foot = Math.floor(this.phase * 2);
      if (foot !== this.lastFoot) {
        this.lastFoot = foot;
        this.steps++;
      }
    } else {
      this.moveAngle = damp(this.moveAngle, 0, 6, dt);
      this.phase = damp(this.phase, Math.round(this.phase * 2) / 2, 6, dt);
    }

    this.crouchK = damp(this.crouchK, pose.crouch ? 1 : 0, 12, dt);
    this.bodyHeight = lerp(STAND_HEIGHT, CROUCH_HEIGHT, this.crouchK);
    r.position.copy(p);
    r.rotation.set(0, pose.yaw, 0, "YXZ");

    const run = Math.min(1, this.speed / 3.8);
    const sprint = Math.max(0, Math.min(1, (this.speed - 4.2) / 2));
    const cyc = this.phase * Math.PI * 2;
    const bob = Math.abs(Math.sin(cyc)) * 0.035 * run;
    const ck = this.crouchK;
    this.hips.position.y = lerp(0.95, 0.62, ck) - bob * (1 - ck * 0.5);
    (this as any).legsRoot.rotation.y = this.moveAngle;

    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      const s = i === 0 ? 1 : -1;
      const swing = Math.sin(cyc + (i === 0 ? 0 : Math.PI)) * (0.55 + 0.25 * sprint) * run;
      const lift = Math.max(0, Math.sin(cyc + (i === 0 ? -0.6 : Math.PI - 0.6))) * (0.9 + 0.5 * sprint) * run;
      // Crouch: thighs forward, knees deep (one knee lower, like a kneeling stance).
      L.hip.rotation.x = lerp(swing, -1.05 - (s > 0 ? 0.25 : -0.1), ck);
      L.knee.rotation.x = lerp(lift + 0.05, 1.7 + (s > 0 ? 0.25 : -0.2), ck);
    }

    // Torso leans into a sprint and twists slightly against the step.
    const pitch = Math.max(-1.2, Math.min(1.2, pose.pitch));
    this.torso.rotation.x = -0.12 * sprint - 0.08 * ck + pitch * 0.18;
    this.torso.rotation.y = Math.sin(cyc) * 0.06 * run - this.moveAngle * 0.35;
    this.head.rotation.x = pitch * 0.55;

    // Rifle and arms follow the aim; recoil kicks the rifle back briefly.
    this.fireT += dt;
    const kick = Math.max(0, 1 - this.fireT / 0.09);
    this.aim.rotation.x = pitch * 0.82 + 0.05 * kick;
    this.aim.position.z = -0.02 + 0.03 * kick;
    const lowReady = sprint * 0.55;
    this.aim.rotation.x -= lowReady;
    this.aim.rotation.z = lowReady * 0.45;
    this.aim.updateMatrix();
    this.torso.updateMatrix();
    const gunM = this.gun.group;
    gunM.updateMatrix();
    const toTorso = (v: any) => v.applyMatrix4(gunM.matrix).applyMatrix4(this.aim.matrix);
    // Right hand on the pistol grip, left hand under the handguard.
    this.solveArm(this.arms[1], toTorso(new T.Vector3(0, -0.02, 0.03)));
    this.solveArm(this.arms[0], toTorso(new T.Vector3(0, -0.04, -0.3)));

    // Name tag: only when close and in front of the camera.
    if (camPos) {
      const d = camPos.distanceTo(p);
      this.tag.visible = this.tagWanted && d < 60;
      const s = Math.max(0.7, Math.min(1.5, d / 14));
      this.tag.scale.set(0.8 * s, 0.2 * s, 1);
      this.tag.position.y = this.bodyHeight + 0.18 + 0.1 * s;
    }
  }

  /** Ray against this player's body capsule and head sphere (same shapes the server judges). */
  raycast(o: any, d: any, max: number): { dist: number; head: boolean } | null {
    const pose = this.pose;
    if (!pose || !pose.alive || !this.root.visible) return null;
    const T = this.T;
    const base = new T.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]);
    const h = this.bodyHeight;
    const head = base.clone().setY(base.y + h - HEAD_RADIUS);
    const sphere = (c: any, r: number) => {
      const m = o.clone().sub(c);
      const b = m.dot(d);
      const cc = m.dot(m) - r * r;
      if (cc > 0 && b > 0) return null;
      const disc = b * b - cc;
      if (disc < 0) return null;
      return Math.max(0, -b - Math.sqrt(disc));
    };
    const th = sphere(head, HEAD_RADIUS);
    if (th != null && th <= max) return { dist: th, head: true };
    // Capsule: closest approach between the ray and the vertical segment.
    const a = base.clone().setY(base.y + BODY_RADIUS);
    const bTop = base.clone().setY(base.y + h - HEAD_RADIUS * 2);
    const ab = bTop.clone().sub(a);
    const ao = o.clone().sub(a);
    const abL2 = ab.dot(ab);
    const dab = d.dot(ab), dao = d.dot(ao), abao = ab.dot(ao);
    const den = abL2 - dab * dab;
    let t = den > 1e-6 ? (dab * abao - abL2 * dao) / den : 0;
    t = Math.max(0, Math.min(max, t));
    let u = abL2 > 0 ? (abao + t * dab) / abL2 : 0;
    u = Math.max(0, Math.min(1, u));
    const seg = a.clone().addScaledVector(ab, u);
    const ts = sphere(seg, BODY_RADIUS);
    if (ts != null && ts <= max) return { dist: ts, head: false };
    return null;
  }

  dispose() {
    this.root.parent && this.root.parent.remove(this.root);
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}

export { wrapAngle };
