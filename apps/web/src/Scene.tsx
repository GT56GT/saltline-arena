import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { client, type Remote } from "./client";
import type { MapData } from "./protocol";

const CONTAINER_COLORS = ["#8a3b22", "#2f5d62", "#b8862b", "#4a5257", "#6b2f2a", "#36544f"];
const PLAYER_COLORS = ["#5ec8ff", "#9be36a", "#ff6fae", "#c79bff", "#ffd36a", "#6af0d0", "#ff8a5c"];

export function Scene() {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 74, near: 0.05, far: 400, position: [0, 1.6, 0] }}
      onCreated={({ gl, scene }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        scene.background = new THREE.Color("#1a2125");
        scene.fog = new THREE.Fog("#1a2125", 35, 120);
      }}
    >
      <Lights />
      {client.map && <Arena map={client.map} />}
      <LocalPlayer />
      <Remotes />
      <Tracers />
    </Canvas>
  );
}

function Lights() {
  return (
    <>
      <hemisphereLight args={["#c9d6dc", "#3a3128", 1.7]} />
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[-28, 45, 32]}
        intensity={2.6}
        color="#ffe2b8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0004}
      />
    </>
  );
}

function Arena({ map }: { map: MapData }) {
  const size: [number, number] = [map.max[0] - map.min[0], map.max[2] - map.min[2]];
  return (
    <group>
      {/* Wet asphalt yard with painted lane lines */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[size[0] + 40, size[1] + 40]} />
        <meshStandardMaterial color="#23272a" roughness={0.82} metalness={0.05} />
      </mesh>
      {[-15, 0, 15].map((x) => (
        <mesh key={x} rotation-x={-Math.PI / 2} position={[x, 0.005, 0]}>
          <planeGeometry args={[0.18, size[1]]} />
          <meshBasicMaterial color="#b8862b" transparent opacity={0.35} />
        </mesh>
      ))}
      {/* Boundary fence */}
      <BoundaryFence map={map} />
      {map.boxes.map((b, i) => {
        const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
        const isCrate = sy < 1.5;
        return (
          <mesh
            key={i}
            position={[(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial
              color={isCrate ? "#6d5a3d" : CONTAINER_COLORS[i % CONTAINER_COLORS.length]}
              roughness={isCrate ? 0.9 : 0.62}
              metalness={isCrate ? 0 : 0.35}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function BoundaryFence({ map }: { map: MapData }) {
  const w = map.max[0] - map.min[0], d = map.max[2] - map.min[2];
  const walls: [number, number, number, number][] = [
    [0, map.min[2], w, 0.1], [0, map.max[2], w, 0.1], [map.min[0], 0, 0.1, d], [map.max[0], 0, 0.1, d],
  ];
  return (
    <>
      {walls.map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, 1.5, z]}>
          <boxGeometry args={[sx, 3, sz]} />
          <meshStandardMaterial color="#8d9aa3" transparent opacity={0.25} />
        </mesh>
      ))}
    </>
  );
}

function LocalPlayer() {
  const { camera, gl, scene } = useThree();
  const gun = useRef<THREE.Group>(null);
  const recoil = useRef(0);
  const lastTracers = useRef(0);

  useEffect(() => {
    const el = gl.domElement;
    const onLock = () => {
      client.locked = document.pointerLockElement === el;
      client.notify();
    };
    const onMove = (e: MouseEvent) => client.onMouseMove(e.movementX, e.movementY);
    const onDown = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) {
        el.requestPointerLock();
        return;
      }
      if (e.button === 0) client.fireHeld = true;
    };
    const onUp = (e: MouseEvent) => {
      if (e.button === 0) client.fireHeld = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Tab") e.preventDefault();
      client.onKey(e.code, e.type === "keydown");
    };
    document.addEventListener("pointerlockchange", onLock);
    document.addEventListener("mousemove", onMove);
    el.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      document.removeEventListener("pointerlockchange", onLock);
      document.removeEventListener("mousemove", onMove);
      el.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [gl]);

  // The default camera is not part of the scene graph; add it so the gun attached to it renders.
  useEffect(() => {
    const g = gun.current!;
    scene.add(camera);
    camera.add(g);
    return () => {
      camera.remove(g);
      scene.remove(camera);
    };
  }, [camera, scene]);

  useFrame((_, dt) => {
    client.frame(dt);
    const a = client.alpha, p = client.prev, c = client.curr;
    camera.position.set(p[0] + (c[0] - p[0]) * a, p[1] + (c[1] - p[1]) * a + client.eyeHeight, p[2] + (c[2] - p[2]) * a);
    camera.rotation.set(client.pitch, client.yaw, 0, "YXZ");
    // View-model kick when our own tracer appears.
    const mine = client.tracers.filter((t) => t.mine).length;
    if (mine > lastTracers.current) recoil.current = 1;
    lastTracers.current = mine;
    recoil.current = Math.max(0, recoil.current - dt * 14);
    if (gun.current) {
      gun.current.visible = client.me.alive;
      gun.current.position.set(0.24, -0.26 + recoil.current * 0.01, -0.55 + recoil.current * 0.05);
      gun.current.scale.setScalar(0.75);
      gun.current.rotation.set(recoil.current * 0.06, 0, 0);
    }
  });

  return (
    <group ref={gun}>
      <mesh position={[0, 0, -0.18]}>
        <boxGeometry args={[0.07, 0.09, 0.6]} />
        <meshStandardMaterial color="#15181a" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, -0.09, -0.08]}>
        <boxGeometry args={[0.045, 0.14, 0.07]} />
        <meshStandardMaterial color="#1d2124" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.06, -0.12]}>
        <boxGeometry args={[0.03, 0.03, 0.14]} />
        <meshStandardMaterial color="#ffb347" emissive="#ffb347" emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

function Remotes() {
  const [ids, setIds] = useState<number[]>([]);
  useFrame(() => {
    const now = [...client.remotes.keys()];
    if (now.length !== ids.length || now.some((id, i) => id !== ids[i])) setIds(now);
  });
  return (
    <>
      {ids.map((id) => {
        const r = client.remotes.get(id);
        return r ? <Avatar key={id} r={r} color={PLAYER_COLORS[id % PLAYER_COLORS.length]} /> : null;
      })}
    </>
  );
}

function Avatar({ r, color }: { r: Remote; color: string }) {
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const arms = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const flash = useRef<THREE.Mesh>(null);
  const hp = useRef<HTMLDivElement>(null);
  const state = useRef({ phase: 0, lx: NaN, lz: NaN, fall: 0 });
  const mats = useMemo(
    () => ({
      suit: new THREE.MeshStandardMaterial({ color: "#2b3034", roughness: 0.85 }),
      plate: new THREE.MeshStandardMaterial({ color: "#4a5257", roughness: 0.6, metalness: 0.35 }),
      accent: new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4 }),
      gun: new THREE.MeshStandardMaterial({ color: "#15181a", metalness: 0.6, roughness: 0.4 }),
    }),
    [color],
  );

  useFrame((_, dt) => {
    const pose = client.remotePose(r, performance.now());
    if (!pose || !g.current) return;
    const s = state.current;
    g.current.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    g.current.rotation.y = pose.yaw;
    const sp = Number.isNaN(s.lx) || dt <= 0 ? 0 : Math.min(9, Math.hypot(pose.pos[0] - s.lx, pose.pos[2] - s.lz) / dt);
    s.lx = pose.pos[0];
    s.lz = pose.pos[2];
    s.phase += dt * (2 + sp * 1.6);
    const amp = Math.min(1, sp / 4) * 0.6, crouch = pose.crouch ? 1 : 0;
    legs.current.forEach((leg, i) => {
      if (leg) leg.rotation.x = Math.sin(s.phase + i * Math.PI) * amp - crouch * 0.9;
    });
    if (body.current) body.current.position.y = 0.92 - crouch * 0.32;
    if (arms.current) arms.current.rotation.x = pose.pitch;
    s.fall += ((pose.alive ? 0 : 1) - s.fall) * Math.min(1, dt * 6);
    g.current.rotation.x = -s.fall * 1.45;
    if (flash.current) flash.current.visible = performance.now() - r.firedAt < 70;
    if (hp.current) {
      hp.current.style.width = `${Math.max(0, r.hp)}%`;
      hp.current.style.background = r.hp < 30 ? "var(--alarm)" : "var(--bone)";
    }
  });

  return (
    <group ref={g}>
      <group ref={body} position={[0, 0.92, 0]}>
        <mesh position={[0, 0.3, 0]} material={mats.suit} castShadow>
          <boxGeometry args={[0.44, 0.52, 0.26]} />
        </mesh>
        <mesh position={[0, 0.36, 0]} material={mats.plate} castShadow>
          <boxGeometry args={[0.47, 0.34, 0.3]} />
        </mesh>
        <mesh position={[0, 0.2, 0]} material={mats.accent}>
          <boxGeometry args={[0.48, 0.05, 0.31]} />
        </mesh>
        <group position={[0, 0.66, 0]}>
          <mesh material={mats.plate} castShadow>
            <sphereGeometry args={[0.15, 14, 10]} />
          </mesh>
          <mesh position={[0, 0.01, -0.13]} material={mats.accent}>
            <boxGeometry args={[0.22, 0.07, 0.06]} />
          </mesh>
        </group>
        <group ref={arms} position={[0, 0.5, -0.04]}>
          <mesh position={[0.06, -0.08, -0.36]} material={mats.gun} castShadow>
            <boxGeometry args={[0.06, 0.1, 0.62]} />
          </mesh>
          <mesh ref={flash} position={[0.06, -0.08, -0.72]} visible={false}>
            <sphereGeometry args={[0.08, 8, 6]} />
            <meshBasicMaterial color="#ffd28a" />
          </mesh>
        </group>
        {[-0.11, 0.11].map((x, i) => (
          <group key={x} position={[x, 0, 0]} ref={(el) => { legs.current[i] = el; }}>
            <mesh position={[0, -0.45, 0]} material={mats.suit} castShadow>
              <boxGeometry args={[0.14, 0.9, 0.15]} />
            </mesh>
          </group>
        ))}
      </group>
      <Html position={[0, 2.15, 0]} center distanceFactor={9} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div className="tag">
          <span style={{ color }}>{r.name}</span>
          <i><b ref={hp} /></i>
        </div>
      </Html>
    </group>
  );
}

const MAX_TRACERS = 64;
function Tracers() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    return g;
  }, []);
  useFrame(() => {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const col = geo.getAttribute("color") as THREE.BufferAttribute;
    const now = performance.now();
    const list = client.tracers.slice(-MAX_TRACERS);
    list.forEach((t, i) => {
      const k = Math.max(0, 1 - (now - t.born) / 140);
      // Draw the back 70% of the line, so it reads as a streak travelling away.
      const sx = t.from[0] + (t.to[0] - t.from[0]) * (1 - k) * 0.7;
      const sy = t.from[1] + (t.to[1] - t.from[1]) * (1 - k) * 0.7;
      const sz = t.from[2] + (t.to[2] - t.from[2]) * (1 - k) * 0.7;
      pos.setXYZ(i * 2, sx, sy, sz);
      pos.setXYZ(i * 2 + 1, t.to[0], t.to[1], t.to[2]);
      const c = t.mine ? [1, 0.82, 0.5] : [1, 0.45, 0.3];
      col.setXYZ(i * 2, c[0] * k * 2, c[1] * k * 2, c[2] * k * 2);
      col.setXYZ(i * 2 + 1, c[0] * k * 2, c[1] * k * 2, c[2] * k * 2);
    });
    geo.setDrawRange(0, list.length * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  });
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}
