import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { useAsset } from '../assets';
import type { Catalog } from '../model/catalog';
import { detectRooms, lerp, pointInPolygon, wallLength } from '../model/geometry';
import { levelById } from '../model/levels';
import type { Building, Viewpoint } from '../model/types';
import { useBuilding, useStore, type Selection } from '../store';
import { useUi } from '../uiState';
import { BuildingMeshes, switchSpots } from './BuildingMeshes';
import { GRASS, surfaceMaterial, skyTexture } from './materials';
import { blocked, groundAt, walkWorld, type WalkWorld } from './physics';

type Mode = 'orbit' | 'perso' | 'walk' | 'photo';
const EYE = 1.62;

function bounds(b: Building) {
  const xs = b.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = b.walls.flatMap((w) => [w.a.y, w.b.y]);
  if (!xs.length) return { cx: 0, cy: 0, size: 10 };
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, size: Math.max(maxX - minX, maxY - minY, 4) };
}

/** Éclairage d'ambiance réaliste : reflets d'un intérieur neutre (calculé une fois, sans image à charger). */
function Environment({ night }: { night: boolean }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => {
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  useEffect(() => {
    scene.environmentIntensity = night ? 0.06 : 0.55;
    scene.background = skyTexture(night);
    scene.backgroundIntensity = night ? 1 : 1;
  }, [night, scene]);
  return null;
}

function Sun({ building, night }: { building: Building; night: boolean }) {
  const bb = useMemo(() => bounds(building), [building]);
  const ref = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    l.target.position.set(bb.cx, 0, bb.cy);
    scene.add(l.target);
    const s = bb.size * 0.9 + 4;
    Object.assign(l.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 80 });
    l.shadow.camera.updateProjectionMatrix();
    return () => void scene.remove(l.target);
  }, [bb, scene]);
  return (
    <directionalLight
      ref={ref}
      position={[bb.cx + 14, 18, bb.cy + 9]}
      intensity={night ? 0.12 : 2.6}
      color={night ? '#9fb4ff' : '#fff1dc'}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.02}
    />
  );
}

function Ground() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(160, 160);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 160, uv.getY(i) * 160);
    return g;
  }, []);
  return <mesh geometry={geo} rotation-x={-Math.PI / 2} position-y={-0.02} material={surfaceMaterial(GRASS)} receiveShadow />;
}

function OrbitRig({ building }: { building: Building }) {
  const { camera, gl } = useThree();
  const bb = useMemo(() => bounds(building), [building]);
  useEffect(() => {
    camera.position.set(bb.cx + bb.size * 0.6, bb.size * 0.85, bb.cy + bb.size * 1.15);
    (camera as THREE.PerspectiveCamera).fov = 50;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    const c = new OrbitControls(camera, gl.domElement);
    c.target.set(bb.cx, 1.2, bb.cy);
    c.maxPolarAngle = Math.PI / 2.02;
    c.enableDamping = true;
    c.update();
    let raf = 0;
    const loop = () => {
      c.update();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      c.dispose();
    };
    // On ne recadre pas à chaque modification du projet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);
  return null;
}

function startPoint(building: Building) {
  const rooms = detectRooms(building)
    .filter((r) => (levelById(building, r.label.levelId)?.elevation ?? 0) === Math.max(...building.levels.filter((l) => l.elevation <= 0).map((l) => l.elevation), Math.min(...building.levels.map((l) => l.elevation))))
    .sort((a, b) => b.area - a.area);
  const r = rooms[0];
  const at = r?.label.at ?? { x: bounds(building).cx, y: bounds(building).cy };
  return { at, room: r, elevation: r ? (levelById(building, r.label.levelId)?.elevation ?? 0) : 0 };
}

/** Point de départ libre : au centre de la plus grande pièce, ou à côté s'il y a un meuble. */
function freeStart(world: WalkWorld) {
  const s = startPoint(world.b);
  const open = () => true;
  for (let rad = 0; rad < 4; rad += 0.25) {
    const n = rad === 0 ? 1 : Math.ceil(rad * 12);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = { x: s.at.x + Math.cos(a) * rad, y: s.at.y + Math.sin(a) * rad };
      if (s.room && !pointInPolygon(p, s.room.polygon)) continue;
      if (!blocked(world, p, s.elevation, open)) return { ...s, at: p };
    }
  }
  return s;
}

interface Interactive {
  id: string;
  kind: 'opening' | 'light';
  pos: THREE.Vector3;
  label: string;
}

function interactives(b: Building): Interactive[] {
  const out: Interactive[] = [];
  for (const o of b.openings) {
    const w = b.walls.find((x) => x.id === o.wallId);
    const l = w && levelById(b, w.levelId);
    if (!w || !l) continue;
    const p = lerp(w.a, w.b, o.offset / wallLength(w));
    out.push({ id: o.id, kind: 'opening', pos: new THREE.Vector3(p.x, l.elevation + o.sill + Math.min(1, o.height / 2), p.y), label: o.kind === 'porte' ? 'la porte' : 'la fenêtre' });
  }
  for (const s of switchSpots(b, detectRooms(b))) out.push({ id: s.roomId, kind: 'light', pos: s.pos.clone(), label: 'la lumière' });
  return out;
}

function useKeys() {
  const keys = useRef(new Set<string>());
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      keys.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);
  return keys;
}

function axis(k: Set<string>) {
  const fwd = Number(k.has('KeyW') || k.has('KeyZ') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
  const side = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('KeyQ') || k.has('ArrowLeft'));
  const run = k.has('ShiftLeft') || k.has('ShiftRight');
  return { fwd, side, run };
}

/** Avance en glissant le long des murs, et suit le sol (escaliers, étages). */
function step(world: WalkWorld, pos: THREE.Vector3, dx: number, dz: number, isOpen: (id: string) => boolean) {
  // Si l'on est déjà coincé (porte refermée sur soi, départ dans un meuble), on peut toujours en sortir.
  const stuck = blocked(world, { x: pos.x, y: pos.z }, pos.y, isOpen);
  const tryMove = (nx: number, nz: number) => {
    const g = groundAt(world, { x: nx, y: nz }, pos.y);
    if (!stuck && blocked(world, { x: nx, y: nz }, g, isOpen)) return false;
    pos.x = nx;
    pos.z = nz;
    pos.y = g;
    return true;
  };
  if (!tryMove(pos.x + dx, pos.z + dz)) {
    tryMove(pos.x + dx, pos.z);
    tryMove(pos.x, pos.z + dz);
  }
}

/** Petit personnage de 1,75 m, pour juger l'échelle des pièces et du mobilier. */
function Character({ groupRef, legL, legR, armL, armR }: { groupRef: React.RefObject<THREE.Group | null>; legL: React.RefObject<THREE.Group | null>; legR: React.RefObject<THREE.Group | null>; armL: React.RefObject<THREE.Group | null>; armR: React.RefObject<THREE.Group | null> }) {
  const mats = useMemo(
    () => ({
      skin: new THREE.MeshStandardMaterial({ color: '#d9a98a', roughness: 0.7 }),
      shirt: new THREE.MeshStandardMaterial({ color: '#2f6db5', roughness: 0.85 }),
      pants: new THREE.MeshStandardMaterial({ color: '#2e3440', roughness: 0.9 }),
      shoes: new THREE.MeshStandardMaterial({ color: '#1b1b1b', roughness: 0.6 }),
      hair: new THREE.MeshStandardMaterial({ color: '#3b2a20', roughness: 0.9 }),
    }),
    [],
  );
  const ud = { noCam: true };
  return (
    <group ref={groupRef} userData={ud}>
      {[
        [legL, -0.1],
        [legR, 0.1],
      ].map(([ref, x], i) => (
        <group key={i} ref={ref as React.RefObject<THREE.Group>} position={[x as number, 0.92, 0]}>
          <mesh position-y={-0.44} material={mats.pants} castShadow userData={ud}>
            <capsuleGeometry args={[0.075, 0.74, 4, 10]} />
          </mesh>
          <mesh position={[0, -0.88, 0.05]} material={mats.shoes} castShadow userData={ud}>
            <boxGeometry args={[0.11, 0.08, 0.27]} />
          </mesh>
        </group>
      ))}
      <mesh position-y={1.2} material={mats.shirt} castShadow userData={ud}>
        <capsuleGeometry args={[0.18, 0.42, 4, 14]} />
      </mesh>
      {[
        [armL, -0.25],
        [armR, 0.25],
      ].map(([ref, x], i) => (
        <group key={i} ref={ref as React.RefObject<THREE.Group>} position={[x as number, 1.45, 0]}>
          <mesh position-y={-0.3} material={mats.shirt} castShadow userData={ud}>
            <capsuleGeometry args={[0.055, 0.5, 4, 10]} />
          </mesh>
          <mesh position-y={-0.62} material={mats.skin} userData={ud}>
            <sphereGeometry args={[0.055, 10, 8]} />
          </mesh>
        </group>
      ))}
      <mesh position-y={1.6} material={mats.skin} userData={ud}>
        <cylinderGeometry args={[0.05, 0.06, 0.1, 10]} />
      </mesh>
      <mesh position-y={1.7} material={mats.skin} castShadow userData={ud}>
        <sphereGeometry args={[0.11, 20, 16]} />
      </mesh>
      <mesh position={[0, 1.75, -0.015]} scale={[1.02, 0.75, 1.05]} material={mats.hair} userData={ud}>
        <sphereGeometry args={[0.11, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
    </group>
  );
}

/** Visite avec personnage : la caméra le suit de dos, on garde le pointeur pour cliquer sur les éléments. */
function PersoRig({ world, onHint }: { world: WalkWorld; onHint: (h: string | null) => void }) {
  const { camera, gl, scene } = useThree();
  const keys = useKeys();
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const worldRef = useRef(world);
  worldRef.current = world;
  const st = useRef({ pos: new THREE.Vector3(), heading: 0, yaw: 0, pitch: 0.32, dist: 3.2, phase: 0, near: null as Interactive | null, lastHint: 0, hint: null as string | null });
  const items = useMemo(() => interactives(world.b), [world]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const s = freeStart(world);
    st.current.pos.set(s.at.x, s.elevation, s.at.y);
    (camera as THREE.PerspectiveCamera).fov = 60;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => (drag = { x: e.clientX, y: e.clientY });
    const move = (e: PointerEvent) => {
      if (!drag) return;
      st.current.yaw -= (e.clientX - drag.x) * 0.006;
      st.current.pitch = Math.min(1.2, Math.max(-0.2, st.current.pitch + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => (drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      st.current.dist = Math.min(7, Math.max(1.2, st.current.dist * Math.exp(e.deltaY * 0.001)));
    };
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.code !== 'KeyE') return;
      const n = st.current.near;
      if (!n) return;
      if (n.kind === 'opening') useUi.getState().toggle(n.id);
      else useUi.getState().toggleLight(n.id);
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
      onHint(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);

  const ray = useMemo(() => new THREE.Raycaster(), []);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const s = st.current;
    const { fwd, side, run } = axis(keys.current);
    const ui = useUi.getState();
    const isOpen = (id: string) => {
      const o = worldRef.current.b.openings.find((x) => x.id === id);
      return o?.kind === 'porte' ? !ui.toggled[id] : !!ui.toggled[id];
    };
    let moving = false;
    if (fwd || side) {
      const speed = (run ? 3 : 1.4) * dt;
      // Avancer = s'éloigner de la caméra
      const f = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const m = f.multiplyScalar(fwd).add(r.multiplyScalar(side)).normalize().multiplyScalar(speed);
      step(worldRef.current, s.pos, m.x, m.z, isOpen);
      const target = Math.atan2(m.x, m.z);
      let d = target - s.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.heading += d * Math.min(1, dt * 10);
      s.phase += dt * (run ? 11 : 7);
      moving = true;
    } else {
      s.pos.y = groundAt(worldRef.current, { x: s.pos.x, y: s.pos.z }, s.pos.y);
    }
    // Animation de marche
    const swing = moving ? Math.sin(s.phase) * 0.55 : 0;
    const k = Math.min(1, dt * 12);
    if (legL.current) legL.current.rotation.x += (swing - legL.current.rotation.x) * k;
    if (legR.current) legR.current.rotation.x += (-swing - legR.current.rotation.x) * k;
    if (armL.current) armL.current.rotation.x += (-swing * 0.8 - armL.current.rotation.x) * k;
    if (armR.current) armR.current.rotation.x += (swing * 0.8 - armR.current.rotation.x) * k;
    if (body.current) {
      body.current.position.copy(s.pos);
      body.current.position.y += moving ? Math.abs(Math.cos(s.phase)) * 0.03 : 0;
      body.current.rotation.y = s.heading;
    }
    // Caméra derrière le personnage, rapprochée si un mur s'interpose
    const head = s.pos.clone().add(new THREE.Vector3(0, 1.55, 0));
    const dir = new THREE.Vector3(Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), Math.cos(s.yaw) * Math.cos(s.pitch));
    ray.set(head, dir);
    ray.far = s.dist;
    const hit = ray.intersectObjects(scene.children, true).find((h) => {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData?.noCam) return false;
        o = o.parent;
      }
      const m = (h.object as THREE.Mesh).material as THREE.Material;
      return !(m && !Array.isArray(m) && m.transparent);
    });
    const d = hit ? Math.max(0.3, hit.distance - 0.2) : s.dist;
    camera.position.copy(head).addScaledVector(dir, d);
    camera.lookAt(head);
    // Élément à portée (touche E)
    const now = performance.now();
    if (now - s.lastHint > 150) {
      s.lastHint = now;
      let best: Interactive | null = null;
      let bestD = 1.8;
      const chest = s.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
      for (const it of itemsRef.current) {
        const dd = it.pos.distanceTo(chest);
        if (dd < bestD) {
          bestD = dd;
          best = it;
        }
      }
      s.near = best;
      const text = !best ? null : best.kind === 'light' ? `E : ${ui.lights[best.id] ? 'éteindre' : 'allumer'} ${best.label}` : `E : ouvrir ou fermer ${best.label}`;
      if (text !== s.hint) {
        s.hint = text;
        onHint(text);
      }
    }
  });

  return <Character groupRef={body} legL={legL} legR={legR} armL={armL} armR={armR} />;
}

/** Promenade à hauteur d'yeux (vue subjective). */
function WalkRig({ world, onPick, onUnlock }: { world: WalkWorld; onPick: (s: NonNullable<Selection>) => void; onUnlock: () => void }) {
  const { camera, gl, scene } = useThree();
  const keys = useKeys();
  const pos = useRef(new THREE.Vector3());
  const worldRef = useRef(world);
  worldRef.current = world;

  useEffect(() => {
    const s = freeStart(world);
    pos.current.set(s.at.x, s.elevation, s.at.y);
    camera.position.set(s.at.x, s.elevation + EYE, s.at.y);
    camera.rotation.set(0, 0, 0);
    (camera as THREE.PerspectiveCamera).fov = 70;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    const far = s.room?.polygon.reduce((m, p) => (Math.hypot(p.x - s.at.x, p.y - s.at.y) > Math.hypot(m.x - s.at.x, m.y - s.at.y) ? p : m), s.at);
    if (far) camera.lookAt(far.x, s.elevation + EYE * 0.85, far.y);
    const c = new PointerLockControls(camera, gl.domElement);
    const lock = () => c.lock();
    gl.domElement.addEventListener('click', lock);
    c.addEventListener('unlock', onUnlock);
    const ray = new THREE.Raycaster();
    const click = () => {
      if (!c.isLocked) return;
      ray.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = ray.intersectObjects(scene.children, true);
      for (const h of hits) {
        const act = findData(h.object, 'action') as { kind: string; id: string } | null;
        if (act?.kind === 'light') {
          useUi.getState().toggleLight(act.id);
          return;
        }
        const sel = findData(h.object, 'sel') as NonNullable<Selection> | null;
        if (sel) {
          onPick(sel);
          c.unlock();
          return;
        }
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'KeyE' || !c.isLocked) return;
      ray.setFromCamera(new THREE.Vector2(0, 0), camera);
      ray.far = 2.5;
      const h = ray.intersectObjects(scene.children, true).map((x) => findData(x.object, 'action') as { kind: string; id: string } | null).find(Boolean);
      ray.far = Infinity;
      if (h?.kind === 'light') useUi.getState().toggleLight(h.id);
      else if (h) useUi.getState().toggle(h.id);
    };
    document.addEventListener('mousedown', click);
    window.addEventListener('keydown', key);
    return () => {
      gl.domElement.removeEventListener('click', lock);
      c.removeEventListener('unlock', onUnlock);
      document.removeEventListener('mousedown', click);
      window.removeEventListener('keydown', key);
      c.unlock();
      c.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl, scene]);

  useFrame((_, dt) => {
    const { fwd, side, run } = axis(keys.current);
    const ui = useUi.getState();
    const isOpen = (id: string) => {
      const o = worldRef.current.b.openings.find((x) => x.id === id);
      return o?.kind === 'porte' ? !ui.toggled[id] : !!ui.toggled[id];
    };
    if (fwd || side) {
      const speed = (run ? 3 : 1.5) * Math.min(dt, 0.05);
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      const move = dir.multiplyScalar(fwd * speed).add(right.multiplyScalar(side * speed));
      step(worldRef.current, pos.current, move.x, move.z, isOpen);
    } else pos.current.y = groundAt(worldRef.current, { x: pos.current.x, y: pos.current.z }, pos.current.y);
    camera.position.set(pos.current.x, camera.position.y + (pos.current.y + EYE - camera.position.y) * Math.min(1, dt * 10), pos.current.z);
  });
  return null;
}

/** Caméra placée exactement comme la photo du point de vue, pour comparer. */
function PhotoRig({ building, v, aspect }: { building: Building; v: Viewpoint; aspect: number }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const elev = levelById(building, v.levelId)?.elevation ?? 0;
    cam.position.set(v.x, elev + v.eye, v.y);
    const a = (v.direction * Math.PI) / 180;
    cam.lookAt(v.x + Math.cos(a), elev + v.eye, v.y + Math.sin(a));
    // Même champ horizontal que la photo, sur toute la largeur de l'écran
    const tanH = Math.tan((v.fov * Math.PI) / 360);
    cam.fov = (2 * Math.atan(tanH / (size.width / size.height)) * 180) / Math.PI;
    cam.updateProjectionMatrix();
  }, [camera, building, v, size, aspect]);
  return null;
}

function findData(o: THREE.Object3D | null, key: string): unknown {
  while (o) {
    if (o.userData?.[key]) return o.userData[key];
    o = o.parent;
  }
  return null;
}

function levelChoices(b: Building) {
  return [...b.levels].sort((m, n) => m.elevation - n.elevation);
}

/** Étape 3 : visite du projet en 3D, vue d'ensemble, avec personnage ou à hauteur d'yeux. */
export function Visit3D() {
  const building = useBuilding('projet');
  const catalog = useStore((s) => s.catalog);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const viewpoints = useStore((s) => s.project.viewpoints);
  const viewFrom = useUi((s) => s.viewFrom);
  const setUi = useUi((s) => s.set);
  const vp = viewpoints.find((v) => v.id === viewFrom) ?? null;
  const photo = useAsset(vp?.assetId);
  const [mode, setMode] = useState<Mode>(vp ? 'photo' : 'orbit');
  const [locked, setLocked] = useState(false);
  const [night, setNight] = useState(false);
  const [upTo, setUpTo] = useState<string>('all');
  const [roofOn, setRoofOn] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0.5);
  const [photoAspect, setPhotoAspect] = useState(4 / 3);

  useEffect(() => {
    const onChange = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);
  useEffect(() => {
    if (vp) setMode('photo');
  }, [vp]);

  const world = useMemo(() => walkWorld(building, catalog as Catalog), [building, catalog]);
  const levels = levelChoices(building);
  const visibleLevels = useMemo(() => {
    if (mode !== 'orbit' || upTo === 'all') return new Set(building.levels.map((l) => l.id));
    const limit = levelById(building, upTo)?.elevation ?? Infinity;
    return new Set(building.levels.filter((l) => l.elevation <= limit).map((l) => l.id));
  }, [building, mode, upTo]);
  const showRoof = mode !== 'orbit' || (upTo === 'all' && roofOn);

  const switchNight = (n: boolean) => {
    setNight(n);
    // À la tombée de la nuit, on allume partout ; au matin, on éteint.
    const all = Object.fromEntries(detectRooms(building).map((r) => [r.label.id, n]));
    setUi({ lights: all });
  };

  const changeMode = (m: Mode) => {
    if (m !== 'photo') setUi({ viewFrom: null });
    setMode(m);
  };

  return (
    <div className="visit">
      <Canvas shadows="soft" dpr={[1, 1.75]} camera={{ fov: 60, near: 0.05, far: 400 }} gl={{ antialias: true }} onPointerMissed={() => mode !== 'walk' && select(null)}>
        <Environment night={night} />
        <hemisphereLight args={[night ? '#28314a' : '#dfeaff', night ? '#0d0f14' : '#8a7d6a', night ? 0.12 : 0.55]} />
        <Sun building={building} night={night} />
        <Ground />
        <BuildingMeshes
          building={building}
          catalog={catalog}
          selection={selection}
          visibleLevels={visibleLevels}
          showRoof={showRoof}
          showCeiling={mode !== 'orbit'}
          night={night}
          onPick={mode === 'walk' ? undefined : select}
        />
        {mode === 'orbit' && <OrbitRig building={building} />}
        {mode === 'perso' && <PersoRig world={world} onHint={setHint} />}
        {mode === 'walk' && <WalkRig world={world} onPick={select} onUnlock={() => setLocked(false)} />}
        {mode === 'photo' && vp && <PhotoRig building={building} v={vp} aspect={photoAspect} />}
      </Canvas>

      {mode === 'photo' && photo && (
        <img className="visit__photo" src={photo} alt="" style={{ opacity: photoOpacity }} onLoad={(e) => setPhotoAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
      )}

      <div className="visit__bar">
        <div className="segmented">
          <button className={mode === 'orbit' ? 'is-active' : ''} onClick={() => changeMode('orbit')}>
            Vue d'ensemble
          </button>
          <button className={mode === 'perso' ? 'is-active' : ''} onClick={() => changeMode('perso')}>
            Avec personnage
          </button>
          <button className={mode === 'walk' ? 'is-active' : ''} onClick={() => changeMode('walk')}>
            À hauteur d'yeux
          </button>
          {vp && (
            <button className={mode === 'photo' ? 'is-active' : ''} onClick={() => setMode('photo')}>
              Photo
            </button>
          )}
        </div>
        <div className="segmented">
          <button className={!night ? 'is-active' : ''} onClick={() => switchNight(false)}>
            Jour
          </button>
          <button className={night ? 'is-active' : ''} onClick={() => switchNight(true)}>
            Nuit
          </button>
        </div>
        {mode === 'orbit' && (
          <div className="segmented">
            <select value={upTo} onChange={(e) => setUpTo(e.target.value)} aria-label="Niveaux affichés">
              <option value="all">Toute la maison</option>
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  Jusqu'à : {l.name}
                </option>
              ))}
            </select>
            {upTo === 'all' && building.roof && (
              <label className="toggle">
                <input type="checkbox" checked={roofOn} onChange={(e) => setRoofOn(e.target.checked)} /> Toit
              </label>
            )}
          </div>
        )}
        {mode === 'photo' && (
          <div className="segmented">
            <label className="toggle">
              Photo <input type="range" min={0} max={1} step={0.05} value={photoOpacity} onChange={(e) => setPhotoOpacity(Number(e.target.value))} /> 3D
            </label>
          </div>
        )}
      </div>
      {mode === 'walk' && !locked && (
        <div className="visit__hint">
          <strong>Cliquez dans la scène pour entrer dans la maison.</strong>
          <span>Avancer : Z/W ou ↑ · Reculer : S ou ↓ · Côtés : Q/A, D · Courir : Maj · E : ouvrir, allumer</span>
          <span>Visez un sol, un mur, une fenêtre ou un meuble et cliquez pour le modifier. Échap pour reprendre la souris.</span>
        </div>
      )}
      {mode === 'walk' && locked && <div className="visit__crosshair" />}
      {mode === 'perso' && (
        <div className="visit__hint visit__hint--small">
          {hint ? <strong>{hint}</strong> : null}
          <span>Marcher : ZQSD ou flèches (Maj pour courir) · Glisser : tourner la caméra · Molette : zoom · Clic : modifier un élément · Double-clic : ouvrir une porte</span>
        </div>
      )}
      {mode === 'orbit' && (
        <div className="visit__hint visit__hint--small">Faites tourner avec la souris. Clic : modifier un élément · Double-clic sur une porte ou une fenêtre : l'ouvrir · Clic sur un interrupteur : la lumière.</div>
      )}
      {mode === 'photo' && vp && (
        <div className="visit__hint visit__hint--small">
          Comparaison avec la photo « {vp.caption || 'point de vue'} » : faites glisser le curseur pour passer de la photo à la maquette.
        </div>
      )}
    </div>
  );
}
