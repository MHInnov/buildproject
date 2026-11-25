import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { useAsset } from '../assets';
import type { Catalog } from '../model/catalog';
import { detectRooms, lerp, inRoom, wallLength } from '../model/geometry';
import { levelById } from '../model/levels';
import type { Building, Viewpoint } from '../model/types';
import { useBuilding, useStore, type Selection } from '../store';
import { useUi } from '../uiState';
import { BuildingMeshes, switchSpots, type MenuTarget } from './BuildingMeshes';
import { VisitMenu } from './VisitMenu';
import { GRASS, surfaceMaterial, type Surface } from './materials';
import { Garden } from './Garden';
import { Avatar, preloadAvatar } from './Avatar';
import { blocked, groundAt, walkWorld, type WalkWorld } from './physics';
import { HdrEnvironment, PostEffects } from './Realism';
import { PhotoComposite } from './PhotoComposite';

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

/** Champ autour de la maison ; plus terne quand le jardin (la parcelle) est tracé. */
const FIELD: Surface = { ...GRASS, color: '#7b8455' };

function Ground({ building }: { building: Building }) {
  const parcel = building.site?.parcel;
  const size = parcel ? Math.max(160, 3 * Math.max(...parcel.map((p) => Math.hypot(p.x, p.y)))) : 160;
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(size, size);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size, uv.getY(i) * size);
    return g;
  }, [size]);
  return (
    <>
      <mesh geometry={geo} rotation-x={-Math.PI / 2} position-y={-0.02} material={surfaceMaterial(parcel ? FIELD : GRASS)} receiveShadow />
      {building.site && <Garden site={building.site} />}
    </>
  );
}

function OrbitRig({ building }: { building: Building }) {
  const { camera, gl } = useThree();
  const bb = useMemo(() => bounds(building), [building]);
  const controls = useRef<OrbitControls | null>(null);
  // Mise à jour dans la boucle de rendu (pas de seconde boucle d'animation)
  useFrame(() => controls.current?.update());
  useEffect(() => {
    camera.position.set(bb.cx + bb.size * 0.6, bb.size * 0.85, bb.cy + bb.size * 1.15);
    (camera as THREE.PerspectiveCamera).fov = 50;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    const c = new OrbitControls(camera, gl.domElement);
    c.target.set(bb.cx, 1.2, bb.cy);
    c.maxPolarAngle = Math.PI / 2.02;
    c.enableDamping = true;
    c.update();
    controls.current = c;
    return () => {
      controls.current = null;
      c.dispose();
    };
    // On ne recadre pas à chaque modification du projet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);
  return null;
}

/**
 * Résolution adaptative : si les images ralentissent, on coupe d'abord l'occlusion ambiante,
 * puis on baisse la définition ; on la remonte quand tout redevient fluide.
 */
function AdaptiveQuality({ max, canDropAo, onDropAo }: { max: number; canDropAo: boolean; onDropAo: () => void }) {
  const setDpr = useThree((s) => s.setDpr);
  const st = useRef({ t: 0, n: 0, dpr: Math.min(window.devicePixelRatio || 1, max), calm: 0 });
  useFrame((_, dt) => {
    const s = st.current;
    if (dt > 0.5) return; // onglet en arrière-plan
    s.t += dt;
    s.n++;
    if (s.t < 1.5) return;
    const fps = s.n / s.t;
    s.t = 0;
    s.n = 0;
    if (fps < 40) {
      s.calm = 0;
      if (canDropAo) onDropAo();
      else if (s.dpr > 0.75) setDpr((s.dpr = Math.max(0.75, s.dpr - 0.25)));
    } else if (fps > 57 && s.dpr < max && ++s.calm >= 3) {
      s.calm = 0;
      setDpr((s.dpr = Math.min(max, s.dpr + 0.25)));
    }
  });
  return null;
}

/** Niveau de départ par défaut : le rez-de-chaussée (le plus haut des niveaux à 0 m ou en dessous). */
function groundLevelId(b: Building): string {
  const sorted = [...b.levels].sort((x, y) => x.elevation - y.elevation);
  return [...sorted].reverse().find((l) => l.elevation <= 0.01)?.id ?? sorted[0]?.id ?? 'rdc';
}

function startPoint(building: Building, levelId: string) {
  const rooms = detectRooms(building)
    .filter((r) => r.label.levelId === levelId)
    .sort((a, b) => b.area - a.area);
  const r = rooms[0];
  const at = r?.label.at ?? { x: bounds(building).cx, y: bounds(building).cy };
  return { at, room: r, elevation: levelById(building, levelId)?.elevation ?? 0 };
}

/** Point de départ libre : au centre de la plus grande pièce, ou à côté s'il y a un meuble. */
function freeStart(world: WalkWorld, levelId: string) {
  const s = startPoint(world.b, levelId);
  const open = () => true;
  for (let rad = 0; rad < 4; rad += 0.25) {
    const n = rad === 0 ? 1 : Math.ceil(rad * 12);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = { x: s.at.x + Math.cos(a) * rad, y: s.at.y + Math.sin(a) * rad };
      if (s.room && !inRoom(p, s.room)) continue;
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
function PersoRig({ world, levelId, onHint }: { world: WalkWorld; levelId: string; onHint: (h: string | null) => void }) {
  const { camera, gl, scene } = useThree();
  const keys = useKeys();
  const body = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const inner = useRef<THREE.Group>(null);
  const speedRef = useRef(0);
  const worldRef = useRef(world);
  worldRef.current = world;
  const st = useRef({ pos: new THREE.Vector3(), heading: 0, yaw: Math.PI, look: 0, dragging: false, frame: 0, camDist: null as number | null, pitch: 0.3, dist: 2.8, phase: 0, near: null as Interactive | null, lastHint: 0, hint: null as string | null });
  const items = useMemo(() => interactives(world.b), [world]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const s = freeStart(world, levelId);
    st.current.pos.set(s.at.x, s.elevation, s.at.y);
    // Le personnage regarde vers le fond de la pièce, la caméra se place dans son dos.
    const far = s.room?.polygon.reduce((m, p) => (Math.hypot(p.x - s.at.x, p.y - s.at.y) > Math.hypot(m.x - s.at.x, m.y - s.at.y) ? p : m), s.at);
    if (far && (far.x !== s.at.x || far.y !== s.at.y)) st.current.heading = Math.atan2(far.x - s.at.x, far.y - s.at.y);
    st.current.yaw = st.current.heading + Math.PI;
    st.current.look = 0;
    (camera as THREE.PerspectiveCamera).fov = 60;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    const el = gl.domElement;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY };
      st.current.dragging = true;
    };
    // Glisser : regarder autour du personnage ; la caméra revient ensuite dans son dos.
    const move = (e: PointerEvent) => {
      if (!drag) return;
      st.current.look -= (e.clientX - drag.x) * 0.006;
      st.current.pitch = Math.min(1.2, Math.max(-0.2, st.current.pitch + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      drag = null;
      st.current.dragging = false;
    };
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
    // Gauche / droite : le personnage tourne sur lui-même ; avancer / reculer : dans le sens où il regarde.
    if (side) s.heading -= side * (run ? 2.6 : 2.1) * dt;
    if (fwd) {
      const speed = (fwd > 0 ? (run ? 3 : 1.4) : 0.9) * dt * fwd;
      const bx = s.pos.x;
      const bz = s.pos.z;
      step(worldRef.current, s.pos, Math.sin(s.heading) * speed, Math.cos(s.heading) * speed, isOpen);
      // Vitesse réelle (bloqué contre un mur = sur place)
      const real = Math.hypot(s.pos.x - bx, s.pos.z - bz) / Math.max(dt, 1e-3);
      speedRef.current += (real - speedRef.current) * Math.min(1, dt * 10);
      s.phase += dt * (run ? 11 : 7);
      moving = true;
    } else {
      s.pos.y = groundAt(worldRef.current, { x: s.pos.x, y: s.pos.z }, s.pos.y);
      speedRef.current += ((side ? 0.6 : 0) - speedRef.current) * Math.min(1, dt * 10);
    }
    // La caméra reste dans le dos du personnage (le regard libre à la souris revient doucement).
    if (!s.dragging) s.look *= Math.max(0, 1 - dt * (moving || side ? 4 : 1.2));
    let dy = s.heading + Math.PI + s.look - s.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    s.yaw += dy * Math.min(1, dt * 8);
    // Animation de marche (silhouette de repli, le temps que le personnage réaliste se charge)
    const swing = moving ? Math.sin(s.phase) * 0.55 : 0;
    const k = Math.min(1, dt * 12);
    if (legL.current) legL.current.rotation.x += (swing - legL.current.rotation.x) * k;
    if (legR.current) legR.current.rotation.x += (-swing - legR.current.rotation.x) * k;
    if (armL.current) armL.current.rotation.x += (-swing * 0.8 - armL.current.rotation.x) * k;
    if (armR.current) armR.current.rotation.x += (swing * 0.8 - armR.current.rotation.x) * k;
    if (body.current) {
      body.current.position.copy(s.pos);
      if (inner.current?.visible && moving) body.current.position.y += Math.abs(Math.cos(s.phase)) * 0.03;
      body.current.rotation.y = s.heading;
    }
    // Caméra derrière le personnage, rapprochée si un mur s'interpose
    const head = s.pos.clone().add(new THREE.Vector3(0, 1.55, 0));
    const dir = new THREE.Vector3(Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), Math.cos(s.yaw) * Math.cos(s.pitch));
    // Obstacle entre la tête et la caméra : recherché une image sur trois (le lancer de rayon coûte cher)
    s.frame = (s.frame + 1) % 3;
    if (s.frame === 0 || s.camDist === null) {
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
    s.camDist = hit ? Math.max(0.3, hit.distance - 0.2) : s.dist;
    }
    const d = s.camDist ?? s.dist;
    camera.position.copy(head).addScaledVector(dir, d);
    // On vise un peu devant le personnage pour voir où il va.
    camera.lookAt(head.x - dir.x * 0.6, head.y - 0.1, head.z - dir.z * 0.6);
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

  return (
    <group ref={body} userData={{ noCam: true }}>
      <Avatar speed={speedRef} fallback={<Character groupRef={inner} legL={legL} legR={legR} armL={armL} armR={armR} />} />
    </group>
  );
}

/** Promenade à hauteur d'yeux (vue subjective). */
function WalkRig({ world, levelId, onPick, onUnlock, onMenu }: { world: WalkWorld; levelId: string; onPick: (s: NonNullable<Selection>) => void; onUnlock: () => void; onMenu: (t: MenuTarget) => void }) {
  const { camera, gl, scene } = useThree();
  const keys = useKeys();
  const pos = useRef(new THREE.Vector3());
  const worldRef = useRef(world);
  worldRef.current = world;

  useEffect(() => {
    const s = freeStart(world, levelId);
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
    const click = (e: MouseEvent) => {
      if (!c.isLocked) return;
      ray.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = ray.intersectObjects(scene.children, true);
      if (e.button === 2) {
        // Clic droit : menu d'actions sur l'élément visé par le viseur
        for (const h of hits) {
          let sel = findData(h.object, 'sel') as NonNullable<Selection> | null;
          if (!sel) continue;
          const mi = h.face?.materialIndex;
          if (sel.kind === 'wall') sel = { ...sel, side: mi === 4 ? 'gauche' : mi === 5 ? 'droite' : undefined };
          const r = gl.domElement.getBoundingClientRect();
          c.unlock();
          onMenu({ sel, at: { x: h.point.x, y: h.point.z }, screen: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
          return;
        }
        return;
      }
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

  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);
  useFrame((_, dt) => {
    const { fwd, side, run } = axis(keys.current);
    const ui = useUi.getState();
    const isOpen = (id: string) => {
      const o = worldRef.current.b.openings.find((x) => x.id === id);
      return o?.kind === 'porte' ? !ui.toggled[id] : !!ui.toggled[id];
    };
    const k = keys.current;
    // Tourner et regarder au clavier : pas besoin de la souris en marchant (pavé tactile bloqué pendant la frappe).
    const look = Number(k.has('PageUp') || k.has('KeyR')) - Number(k.has('PageDown') || k.has('KeyF'));
    if (side || look) {
      euler.setFromQuaternion(camera.quaternion);
      euler.y -= side * (run ? 2.4 : 1.8) * Math.min(dt, 0.05);
      euler.x = Math.max(-1.3, Math.min(1.3, euler.x + look * 1.2 * Math.min(dt, 0.05)));
      camera.quaternion.setFromEuler(euler);
    }
    if (fwd) {
      const speed = (run ? 3 : 1.5) * Math.min(dt, 0.05);
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      const move = dir.multiplyScalar(fwd * speed);
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
    // Même cadrage que la photo affichée en « cover » (rognée en haut/bas ou sur les côtés)
    const tanH = Math.tan((v.fov * Math.PI) / 360);
    cam.fov = (2 * Math.atan(tanH / Math.max(size.width / size.height, aspect)) * 180) / Math.PI;
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
  const existingBuilding = useBuilding('existant');
  const existingRef = useRef<THREE.Group>(null);
  const projectRef = useRef<THREE.Group>(null);
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
  const [quality, setQuality] = useState<'haute' | 'standard'>(() => {
    try {
      return localStorage.getItem('construprojet:qualite3d') === 'standard' ? 'standard' : 'haute';
    } catch {
      return 'haute';
    }
  });
  const changeQuality = (q: 'haute' | 'standard') => {
    setQuality(q);
    try {
      localStorage.setItem('construprojet:qualite3d', q);
    } catch {
      /* stockage indisponible */
    }
  };
  const [upTo, setUpTo] = useState<string>('all');
  const [startLevel, setStartLevel] = useState<string | null>(null);
  const walkLevel = startLevel && levelById(building, startLevel) ? startLevel : groundLevelId(building);
  const [roofOn, setRoofOn] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0.5);
  // Photo du projet (photo réelle + modifications) ou superposition de la maquette
  const [photoView, setPhotoView] = useState<'projet' | 'maquette'>('projet');
  const [after, setAfter] = useState(1);
  const [photoAspect, setPhotoAspect] = useState(4 / 3);
  useEffect(() => {
    if (!photo) return;
    const im = new Image();
    im.onload = () => im.naturalHeight && setPhotoAspect(im.naturalWidth / im.naturalHeight);
    im.src = photo;
  }, [photo]);

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // Occlusion ambiante coupée automatiquement si l'ordinateur peine (images saccadées)
  const [aoOff, setAoOff] = useState(false);
  useEffect(() => {
    const onChange = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);
  useEffect(() => {
    if (vp) setMode('photo');
  }, [vp]);
  // Le personnage réaliste se télécharge en arrière-plan dès l'ouverture de la visite
  useEffect(() => {
    const t = setTimeout(() => void preloadAvatar().catch(() => undefined), 800);
    return () => clearTimeout(t);
  }, []);

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
    setMenu(null);
    setMode(m);
  };

  return (
    <div className="visit" onContextMenu={(e) => e.preventDefault()}>
      <Canvas
        shadows="soft"
        dpr={[0.75, quality === 'haute' ? 1.5 : 1.15]}
        camera={{ fov: 60, near: 0.05, far: 400 }}
        gl={{ antialias: true }}
        onCreated={({ gl }) => {
          // Tons neutres : les couleurs des produits restent fidèles au catalogue
          gl.toneMapping = THREE.NeutralToneMapping;
          gl.toneMappingExposure = 1.12;
        }}
        onPointerMissed={() => mode !== 'walk' && select(null)}
      >
        <HdrEnvironment preset="apartment" night={night} />
        {quality === 'haute' && !aoOff && !(mode === 'photo' && photoView === 'projet') && <PostEffects />}
        {mode === 'photo' && photoView === 'projet' && vp && photo && (
          <PhotoComposite photo={photo} photoAspect={photoAspect} existing={existingRef} project={projectRef} amount={after} exposure={1.12} />
        )}
        <AdaptiveQuality key={quality} max={quality === 'haute' ? 1.5 : 1.15} canDropAo={quality === 'haute' && !aoOff} onDropAo={() => setAoOff(true)} />
        <hemisphereLight args={[night ? '#28314a' : '#dfeaff', night ? '#0d0f14' : '#8a7d6a', night ? 0.12 : 0.55]} />
        <Sun building={building} night={night} />
        <Ground building={building} />
        {mode === 'photo' && photoView === 'projet' && (
          <group ref={existingRef} visible={false}>
            <BuildingMeshes building={existingBuilding} catalog={catalog} selection={null} visibleLevels={visibleLevels} showRoof showCeiling night={night} />
          </group>
        )}
        <group ref={projectRef}>
        <BuildingMeshes
          building={building}
          catalog={catalog}
          selection={selection}
          visibleLevels={visibleLevels}
          showRoof={showRoof}
          showCeiling={mode !== 'orbit'}
          night={night}
          onPick={mode === 'walk' ? undefined : select}
          onMenu={mode === 'walk' || mode === 'photo' ? undefined : setMenu}
        />
        </group>
        {mode === 'orbit' && <OrbitRig building={building} />}
        {mode === 'perso' && <PersoRig key={walkLevel} world={world} levelId={walkLevel} onHint={setHint} />}
        {mode === 'walk' && <WalkRig key={walkLevel} world={world} levelId={walkLevel} onPick={select} onUnlock={() => setLocked(false)} onMenu={setMenu} />}
        {mode === 'photo' && vp && <PhotoRig building={building} v={vp} aspect={photoAspect} />}
      </Canvas>

      {mode === 'photo' && photo && photoView === 'maquette' && (
        <img className="visit__photo" src={photo} alt="" style={{ opacity: photoOpacity }} />
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
        <div className="segmented">
          <select value={quality} onChange={(e) => changeQuality(e.target.value as 'haute' | 'standard')} aria-label="Qualité du rendu" title="Qualité haute : ombres de contact et rendu plus fin (ordinateur récent)">
            <option value="haute">Qualité haute</option>
            <option value="standard">Qualité standard</option>
          </select>
        </div>
        {(mode === 'perso' || mode === 'walk') && levels.length > 1 && (
          <div className="segmented">
            <select value={walkLevel} onChange={(e) => setStartLevel(e.target.value)} aria-label="Niveau visité">
              {levels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
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
            <button className={photoView === 'projet' ? 'is-active' : ''} onClick={() => setPhotoView('projet')} title="La photo réelle, avec les modifications du projet appliquées">
              Photo du projet
            </button>
            <button className={photoView === 'maquette' ? 'is-active' : ''} onClick={() => setPhotoView('maquette')} title="Superposer la maquette 3D à la photo pour vérifier le calage">
              Calage maquette
            </button>
          </div>
        )}
        {mode === 'photo' && photoView === 'projet' && (
          <div className="segmented">
            <label className="toggle">
              Avant <input type="range" min={0} max={1} step={0.05} value={after} onChange={(e) => setAfter(Number(e.target.value))} aria-label="Avant / après" /> Après
            </label>
          </div>
        )}
        {mode === 'photo' && photoView === 'maquette' && (
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
          <span>Avancer : Z/W ou ↑ · Reculer : S ou ↓ · Tourner : Q/A, D ou ← → · Regarder en haut / en bas : R, F · Courir : Maj · E : ouvrir, allumer</span>
          <span>Le clavier suffit pour se déplacer ; la souris sert à viser. Clic : modifier l'élément visé · Clic droit : actions. Échap pour reprendre la souris.</span>
        </div>
      )}
      {mode === 'walk' && locked && <div className="visit__crosshair" />}
      {mode === 'perso' && (
        <div className="visit__hint visit__hint--small">
          {hint ? <strong>{hint}</strong> : null}
          <span>Avancer / reculer : Z/W, S ou ↑ ↓ · Tourner : Q/A, D ou ← → · Maj : courir · Glisser : regarder autour · Molette : zoom · Clic : modifier un élément · Double-clic : ouvrir une porte</span>
        </div>
      )}
      {mode === 'orbit' && (
        <div className="visit__hint visit__hint--small">Faites tourner avec la souris. Clic : modifier un élément · Double-clic sur une porte ou une fenêtre : l'ouvrir · Clic sur un interrupteur : la lumière.</div>
      )}
      {mode === 'photo' && vp && (
        <div className="visit__hint visit__hint--small">
          {photoView === 'projet'
            ? `Photo « ${vp.caption || 'point de vue'} » avec les modifications du projet : glissez le curseur pour comparer avant et après. Les zones inchangées restent celles de la photo.`
            : `Calage : faites glisser le curseur pour passer de la photo à la maquette ; si elles ne se superposent pas, ajustez le point de vue dans la situation existante.`}
        </div>
      )}
      {menu && <VisitMenu target={menu} building={building} onClose={() => setMenu(null)} />}
    </div>
  );
}
