// Other players as the "private military contractor" model (public/models/operator.glb, converted
// from the FBX in game/models by game/models/convert.html).
//
// The model is skinned on a Mixamo skeleton and ships with a single pose: SCAR-17 at high ready.
// Instead of canned clips, the skeleton is driven procedurally from what the server tells us:
//   - aim: the spine turns so the rifle's barrel follows the player's yaw/pitch exactly, and the
//     neck counter-rotates so the head looks where they look,
//   - legs: a stride cycle from the interpolated speed, turned into strafes and backpedals,
//     with the lowest foot kept on the ground (so the hips bob and crouches sink naturally),
//   - crouch, sprint lean, recoil kick and a death fall.
// Materials come from the original game's PBR library, so the model sits in the same light.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { CROUCH_HEIGHT, HEAD_RADIUS, BODY_RADIUS, STAND_HEIGHT, type AvatarPose, type Kit } from "./avatar";

const URL = "/models/operator.glb";
const B = (n: string) => "mixamorig" + n;

export interface OperatorKit {
  T: any;
  template: any;
  clone: (o: any) => any;
  mats: Record<string, any>;
  kit: Kit;
  /** Barrel direction (stock to muzzle) and muzzle point in model space, rest pose. */
  barrel: any;
  muzzle: any;
}

export async function loadOperatorKit(win: any, G: any, kit: Kit): Promise<OperatorKit | null> {
  const L = win.__arenaLoaders;
  if (!L) return null;
  const T = G.THREE;
  const gltf = await new L.GLTFLoader().loadAsync(URL);
  const template = gltf.scene;
  const m = (name: string, color?: number) => G.mats.get(name, color === undefined ? {} : { color });
  const skin = new T.MeshStandardMaterial({ color: 0x8c6b55, roughness: 0.62, metalness: 0 });
  const eyes = new T.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.15, metalness: 0 });
  const mats: Record<string, any> = {
    body: m("glove_fabric", 0x6b6652),
    vest: m("tarp", 0x56583f),
    mag_pouch: m("tarp", 0x6a5f45),
    helmet: m("armor_white", 0x5c604f),
    l_glove: m("glove_fabric", 0x272a28),
    r_glove: m("glove_fabric", 0x272a28),
    kneepad: m("polymer_black"),
    boots: m("polymer_black", 0x3d3326),
    facemask: m("glove_fabric", 0x2a2d2b),
    scar: m("polymer_tan"),
    face: skin,
    __default: eyes,
  };
  template.updateMatrixWorld(true);
  let barrel = new T.Vector3(0, 0, -1);
  let muzzle = new T.Vector3(0, 1.4, -0.8);
  template.traverse((o: any) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false; // skinned bounds are the rest pose; the death fall would cull wrongly
    const name = String((o.material && o.material.name) || "");
    o.material = mats[name] || mats.body;
    o.userData.part = name;
    if (o.name === "Gun_Low") {
      // Barrel axis: the two farthest-apart rifle vertices; the muzzle is the forward one.
      const pa = o.geometry.attributes.position, v = new T.Vector3(), pts: any[] = [];
      for (let i = 0; i < pa.count; i += 3) pts.push(v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).clone());
      let a = pts[0], b = pts[0], best = 0;
      for (let k = 0; k < 6; k++) {
        let far = a, fd = 0;
        for (const p of pts) { const d = p.distanceToSquared(a); if (d > fd) { fd = d; far = p; } }
        if (fd > best) { best = fd; b = far; }
        a = far;
      }
      const [front, back] = a.z < b.z ? [a, b] : [b, a];
      barrel = front.clone().sub(back).normalize();
      muzzle = front.clone();
    }
  });
  return { T, template, clone: (o: any) => L.SkeletonUtils.clone(o), mats, kit, barrel, muzzle };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (a: number, b: number, k: number, dt: number) => lerp(a, b, 1 - Math.exp(-k * dt));

interface Rig { bone: any; rest: any; parentRest: any; parentRestInv: any }

export class Operator {
  root: any;
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
  private T: any;
  private k: OperatorKit;
  private model: any;
  private rig = new Map<string, Rig>();
  private muzzleObj: any;
  private tag: any;
  private tagCanvas: HTMLCanvasElement;
  private tagText = "";
  private lookKey = "";
  private accent = "#ffb347";
  private parts: any[] = [];
  private restFootY = 0;
  private headFwd: any;
  // animation state
  private phase = 0;
  private crouchK = 0;
  private climbK = 0;
  private lastPos: any;
  private speed = 0;
  private moveAngle = 0;
  private deadT = -1;
  private fireT = 9;
  private q1: any; private v1: any; private v2: any;

  constructor(k: OperatorKit, name: string, doc: Document) {
    const T = (this.T = k.T);
    this.k = k;
    this.q1 = new T.Quaternion(); this.v1 = new T.Vector3(); this.v2 = new T.Vector3();
    this.root = new T.Group();
    this.root.name = "arena-player";
    this.model = k.clone(k.template);
    this.root.add(this.model);
    this.lastPos = new T.Vector3();
    this.model.traverse((o: any) => { if (o.isMesh) this.parts.push(o); });

    // Rest frames (model space, root at identity) for every bone we drive.
    this.model.updateMatrixWorld(true);
    const inv = new T.Matrix4().copy(this.model.matrixWorld).invert();
    const rootQ = new T.Quaternion();
    new T.Matrix4().copy(inv).decompose(new T.Vector3(), rootQ, new T.Vector3());
    for (const n of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg", "LeftFoot", "RightFoot", "RightHand"]) {
      const bone = this.model.getObjectByName(B(n));
      if (!bone) continue;
      const pq = new T.Quaternion();
      bone.parent.getWorldQuaternion(pq);
      pq.premultiply(rootQ);
      this.rig.set(n, { bone, rest: bone.quaternion.clone(), parentRest: pq, parentRestInv: pq.clone().invert() });
    }
    this.restFootY = this.footY();
    const head = this.rig.get("Head");
    this.headFwd = new T.Vector3(0, 0, -1);
    if (head) {
      // The head's "look" axis in model space: from the head bone toward the face (forward, -Z).
      this.headFwd.set(0, 0, -1);
    }

    // Muzzle marker riding the rifle (which is pinned to the right hand).
    this.muzzleObj = new T.Object3D();
    const gun = this.model.getObjectByName("Gun_Low");
    if (gun) {
      gun.updateMatrixWorld(true);
      this.muzzleObj.position.copy(k.muzzle).applyMatrix4(new T.Matrix4().copy(gun.matrixWorld).invert());
      gun.add(this.muzzleObj);
    } else this.model.add(this.muzzleObj);

    // Name tag (occluded by walls, only drawn when reasonably close).
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
    this.setLook(null, null, null, false);
  }

  private footY() {
    this.model.updateMatrixWorld(true);
    let y = Infinity;
    for (const n of ["LeftFoot", "RightFoot"]) {
      const r = this.rig.get(n);
      if (r) { r.bone.getWorldPosition(this.v1); y = Math.min(y, this.v1.y - this.root.position.y); }
    }
    return Number.isFinite(y) ? y : 0;
  }

  /** Set a bone to rest, then apply model-space rotation `d` (expressed in its rest parent frame). */
  private setBone(n: string, d: any | null) {
    const r = this.rig.get(n);
    if (!r) return;
    r.bone.quaternion.copy(r.rest);
    if (d) {
      // local' = (P^-1 · D · P) · rest
      this.q1.copy(r.parentRestInv).multiply(d).multiply(r.parentRest);
      r.bone.quaternion.premultiply(this.q1);
    }
  }
  private axis(x: number, y: number, z: number, a: number) {
    return new this.T.Quaternion().setFromAxisAngle(new this.T.Vector3(x, y, z), a);
  }

  setName(name: string) {
    if (name === this.tagText) return;
    this.tagText = name;
    this.drawTag();
  }

  private drawTag() {
    const name = this.tagText;
    const c = this.tagCanvas.getContext("2d")!;
    c.clearRect(0, 0, 256, 64);
    c.font = '600 30px "Barlow Condensed", "Arial Narrow", sans-serif';
    c.textAlign = "center";
    c.textBaseline = "middle";
    const w = Math.min(240, c.measureText(name).width + 28);
    c.fillStyle = "rgba(8,10,12,0.62)";
    c.fillRect(128 - w / 2, 14, w, 36);
    c.fillStyle = this.accent;
    c.fillRect(128 - w / 2, 14, 3, 36);
    c.fillStyle = "#eef2f0";
    c.fillText(name.toUpperCase(), 130, 33);
    this.tag.material.map.needsUpdate = true;
  }

  /**
   * Look: cosmetics ("plates" recolour the plate carrier and helmet, "visor" lights the goggles),
   * then the team colour on top (team rooms). Teammates' name tags show through walls.
   */
  setLook(id: string | null, look: { slot: "visor" | "plates"; color: string } | null, teamColor: string | null, ally: boolean) {
    const key = `${id}|${teamColor}|${ally}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    const plateColor = teamColor || (look && look.slot === "plates" ? look.color : null);
    const plates = plateColor ? this.k.kit.plates(plateColor) : null;
    for (const o of this.parts) {
      const p = o.userData.part;
      if (p === "vest" || p === "helmet") o.material = plates || this.k.mats[p];
      if (p === "googles") o.material = this.k.kit.visor(look && look.slot === "visor" ? look.color : null);
    }
    this.accent = teamColor || "#ffb347";
    this.tag.material.depthTest = !ally;
    this.drawTag();
  }

  muzzleWorld(out: any) {
    this.root.updateMatrixWorld(true);
    return this.muzzleObj.getWorldPosition(out);
  }

  fired() {
    this.fireT = 0;
  }

  update(pose: AvatarPose, dt: number, camPos: any) {
    const T = this.T;
    this.pose = pose;
    const r = this.root;
    const p = this.v2.set(pose.pos[0], pose.pos[1], pose.pos[2]);

    if (!pose.alive) {
      // Death: buckle at the knees and fall backwards, then fade out until the respawn.
      if (this.deadT < 0) this.deadT = 0;
      this.deadT += dt;
      const k = Math.min(1, this.deadT / 0.6);
      const e = k * k * (3 - 2 * k);
      this.setBone("LeftUpLeg", this.axis(1, 0, 0, 0.6 * e));
      this.setBone("RightUpLeg", this.axis(1, 0, 0, 0.3 * e));
      this.setBone("LeftLeg", this.axis(1, 0, 0, -1.1 * e));
      this.setBone("RightLeg", this.axis(1, 0, 0, -0.7 * e));
      r.position.copy(p);
      r.rotation.set(-e * 1.42, pose.yaw, 0, "YXZ");
      r.position.y = p.y + 0.12 * e;
      this.tag.visible = false;
      r.visible = this.deadT < 2.4;
      return;
    }
    if (this.deadT >= 0) {
      this.deadT = -1;
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
    let back = false;
    if (sp > 0.3 && !teleport) {
      const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
      const rx = Math.cos(pose.yaw), rz = -Math.sin(pose.yaw);
      const fwd = (vx * fx + vz * fz) / sp, side = (vx * rx + vz * rz) / sp;
      back = fwd < -0.2;
      let ang = Math.atan2(-side, Math.abs(fwd) + 1e-3);
      ang = Math.max(-1.0, Math.min(1.0, ang));
      this.moveAngle = damp(this.moveAngle, back ? -ang : ang, 8, dt);
      const stride = this.speed > 5 ? 2.2 : 1.6;
      this.phase += ((back ? -1 : 1) * this.speed * dt) / stride;
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
    this.climbK = damp(this.climbK, pose.climb ? 1 : 0, 14, dt);
    this.bodyHeight = lerp(STAND_HEIGHT, CROUCH_HEIGHT, this.crouchK);

    const run = Math.min(1, this.speed / 3.8);
    const sprint = Math.max(0, Math.min(1, (this.speed - 4.2) / 2));
    const ck = this.crouchK;
    const cyc = this.phase * Math.PI * 2;

    // --- legs: stride around the body's right axis; hips turn into strafes.
    const hipsYaw = this.axis(0, 1, 0, this.moveAngle * 0.8);
    this.setBone("Hips", hipsYaw);
    for (const [i, side] of [[0, "Left"], [1, "Right"]] as const) {
      const ph = cyc + (i === 0 ? 0 : Math.PI);
      const swing = Math.sin(ph) * (0.5 + 0.25 * sprint) * run;
      const lift = Math.max(0, Math.sin(ph - 0.6)) * (0.85 + 0.5 * sprint) * run;
      const crouchHip = i === 0 ? 1.15 : 0.55;
      const crouchKnee = i === 0 ? 1.95 : 1.6;
      // Climbing: lead knee driven up onto the ledge, the other leg pushing off.
      const climbHip = i === 0 ? 1.45 : 0.35;
      const climbKnee = i === 0 ? 1.9 : 0.5;
      const hip = lerp(lerp(swing, crouchHip, ck), climbHip, this.climbK);
      const knee = lerp(lerp(lift, crouchKnee, ck), climbKnee, this.climbK);
      this.setBone(`${side}UpLeg`, this.axis(1, 0, 0, hip));
      this.setBone(`${side}Leg`, this.axis(1, 0, 0, -knee));
    }

    // --- upper body: line the rifle's barrel up with the aim, spread over the three spine bones.
    const pitch = Math.max(-1.25, Math.min(1.25, pose.pitch));
    const kick = Math.max(0, 1 - this.fireT / 0.09);
    this.fireT += dt;
    // Rifle drops to low ready when sprinting, and hangs while climbing.
    const lowReady = Math.max(sprint * 0.6, this.climbK * 1.0);
    const aim = this.v1.set(0, Math.sin(pitch - lowReady + 0.06 * kick), -Math.cos(pitch - lowReady + 0.06 * kick)).normalize();
    const R = new T.Quaternion().setFromUnitVectors(this.k.barrel, aim);
    // Undo the hips' strafe turn for the upper body, then split what is left between the bones.
    const Q = hipsYaw.clone().invert().multiply(R);
    const third = new T.Quaternion().slerp(Q, 1 / 3);
    const I = new T.Quaternion();
    this.setBone("Spine", third);
    this.setBone("Spine1", third);
    this.setBone("Spine2", third);
    // Head looks along the aim: undo what the spine did to it.
    const want = aim.clone().applyQuaternion(R.clone().invert());
    this.setBone("Neck", I.clone().slerp(new T.Quaternion().setFromUnitVectors(this.headFwd, want), 0.5));
    this.setBone("Head", I.clone().slerp(new T.Quaternion().setFromUnitVectors(this.headFwd, want), 0.5));

    // --- place: feet on the ground (stance foot planted), facing the aim yaw.
    r.position.copy(p);
    r.rotation.set(0, pose.yaw, 0, "YXZ");
    // Feet stay planted on the ground (hips bob, crouches sink) — except mid-climb, where the
    // server's climb path already carries the body up the ledge.
    const footNow = this.footY();
    r.position.y = p.y + (this.restFootY - footNow) * (1 - this.climbK);

    if (camPos) {
      const d = camPos.distanceTo(p);
      this.tag.visible = this.tagWanted && d < 60;
      const s = Math.max(0.7, Math.min(1.5, d / 14));
      this.tag.scale.set(0.8 * s, 0.2 * s, 1);
      this.tag.position.y = this.bodyHeight + 0.18 + 0.1 * s;
    }
  }

  /** Ray against the server's hit shapes for this pose (body capsule + head sphere). */
  raycast(o: any, d: any, max: number): { dist: number; head: boolean } | null {
    const pose = this.pose;
    if (!pose || !pose.alive || !this.root.visible) return null;
    const T = this.T;
    const base = new T.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]);
    const h = this.bodyHeight;
    const sphere = (c: any, rad: number) => {
      const m = o.clone().sub(c);
      const b = m.dot(d);
      const cc = m.dot(m) - rad * rad;
      if (cc > 0 && b > 0) return null;
      const disc = b * b - cc;
      if (disc < 0) return null;
      return Math.max(0, -b - Math.sqrt(disc));
    };
    const th = sphere(base.clone().setY(base.y + h - HEAD_RADIUS), HEAD_RADIUS);
    if (th != null && th <= max) return { dist: th, head: true };
    const a = base.clone().setY(base.y + BODY_RADIUS);
    const ab = new T.Vector3(0, h - HEAD_RADIUS * 2 - BODY_RADIUS, 0);
    const ao = o.clone().sub(a);
    const abL2 = ab.dot(ab), dab = d.dot(ab), dao = d.dot(ao), abao = ab.dot(ao);
    const den = abL2 - dab * dab;
    let t = den > 1e-6 ? (dab * abao - abL2 * dao) / den : 0;
    t = Math.max(0, Math.min(max, t));
    let u = abL2 > 0 ? (abao + t * dab) / abL2 : 0;
    u = Math.max(0, Math.min(1, u));
    const ts = sphere(a.clone().addScaledVector(ab, u), BODY_RADIUS);
    if (ts != null && ts <= max) return { dist: ts, head: false };
    return null;
  }

  dispose() {
    this.root.parent && this.root.parent.remove(this.root);
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}
