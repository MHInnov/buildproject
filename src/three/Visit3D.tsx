import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { detectRooms, projectOnSegment, wallLength } from '../model/geometry';
import type { Building, Point } from '../model/types';
import { useBuilding, useStore, type Selection } from '../store';
import { BuildingMeshes } from './BuildingMeshes';

type Mode = 'orbit' | 'walk';
const EYE = 1.65;
const RADIUS = 0.22;

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

/** Collision simple avec les murs ; on passe par les portes. */
function blocked(b: Building, p: Point): boolean {
  for (const w of b.walls) {
    const pr = projectOnSegment(p, w.a, w.b);
    if (pr.d > w.thickness / 2 + RADIUS) continue;
    const along = pr.t * wallLength(w);
    const inDoor = b.openings.some(
      (o) => o.wallId === w.id && o.kind === 'porte' && Math.abs(along - o.offset) < o.width / 2 - RADIUS * 0.6,
    );
    if (!inDoor) return true;
  }
  return false;
}

function OrbitRig({ building }: { building: Building }) {
  const { camera, gl } = useThree();
  const bb = useMemo(() => bounds(building), [building]);
  useEffect(() => {
    camera.position.set(bb.cx + bb.size * 0.35, bb.size * 1.0, bb.cy + bb.size * 1.05);
    const c = new OrbitControls(camera, gl.domElement);
    c.target.set(bb.cx, 0, bb.cy);
    c.maxPolarAngle = Math.PI / 2.05;
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

function WalkRig({ building, onPick, onUnlock }: { building: Building; onPick: (s: NonNullable<Selection>) => void; onUnlock: () => void }) {
  const { camera, gl, scene } = useThree();
  const keys = useRef(new Set<string>());
  const controls = useRef<PointerLockControls | null>(null);
  const buildingRef = useRef(building);
  buildingRef.current = building;

  useEffect(() => {
    // Départ au centre de la plus grande pièce
    const rooms = detectRooms(building).sort((a, b) => b.area - a.area);
    const start = rooms[0]?.label.at ?? { x: bounds(building).cx, y: bounds(building).cy };
    camera.position.set(start.x, EYE, start.y);
    camera.rotation.set(0, 0, 0);
    // On regarde vers le coin le plus éloigné de la pièce pour la voir en entier.
    const far = rooms[0]?.polygon.reduce((m, p) => (Math.hypot(p.x - start.x, p.y - start.y) > Math.hypot(m.x - start.x, m.y - start.y) ? p : m), start);
    if (far) camera.lookAt(far.x, EYE * 0.85, far.y);
    const c = new PointerLockControls(camera, gl.domElement);
    controls.current = c;
    const lock = () => c.lock();
    gl.domElement.addEventListener('click', lock);
    c.addEventListener('unlock', onUnlock);

    const down = (e: KeyboardEvent) => keys.current.add(e.code);
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const ray = new THREE.Raycaster();
    const click = () => {
      if (!c.isLocked) return;
      ray.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hit = ray.intersectObjects(scene.children, true).find((h) => findSel(h.object));
      if (hit) {
        onPick(findSel(hit.object)!);
        c.unlock();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    document.addEventListener('mousedown', click);
    return () => {
      gl.domElement.removeEventListener('click', lock);
      c.removeEventListener('unlock', onUnlock);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      document.removeEventListener('mousedown', click);
      c.unlock();
      c.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl, scene]);

  useFrame((_, dt) => {
    const k = keys.current;
    const speed = (k.has('ShiftLeft') || k.has('ShiftRight') ? 3.2 : 1.6) * Math.min(dt, 0.05);
    const fwd = Number(k.has('KeyW') || k.has('KeyZ') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown'));
    const side = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('KeyQ') || k.has('ArrowLeft'));
    if (!fwd && !side) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const move = dir.multiplyScalar(fwd * speed).add(right.multiplyScalar(side * speed));
    const b = buildingRef.current;
    const p = camera.position;
    // Glissement le long des murs : on teste chaque axe séparément.
    if (!blocked(b, { x: p.x + move.x, y: p.z })) p.x += move.x;
    if (!blocked(b, { x: p.x, y: p.z + move.z })) p.z += move.z;
    p.y = EYE;
  });
  return null;
}

function findSel(o: THREE.Object3D | null): NonNullable<Selection> | null {
  while (o) {
    if (o.userData?.sel) return o.userData.sel as NonNullable<Selection>;
    o = o.parent;
  }
  return null;
}

/** Étape 3 : visite du projet en 3D, vue d'ensemble ou promenade à hauteur d'yeux. */
export function Visit3D() {
  const building = useBuilding('projet');
  const catalog = useStore((s) => s.catalog);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const [mode, setMode] = useState<Mode>('orbit');
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const onChange = () => setLocked(!!document.pointerLockElement);
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  return (
    <div className="visit">
      <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 65, near: 0.05, far: 200 }} onPointerMissed={() => mode === 'orbit' && select(null)}>
        <color attach="background" args={['#e9eef3']} />
        <hemisphereLight args={['#ffffff', '#c9c2b6', 1.5]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[8, 14, 6]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-15} shadow-camera-right={15} shadow-camera-top={15} shadow-camera-bottom={-15} />
        <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#dfe6d8" />
        </mesh>
        <BuildingMeshes building={building} catalog={catalog} selection={selection} showCeiling={mode === 'walk'} onPick={mode === 'orbit' ? select : undefined} />
        {mode === 'orbit' ? <OrbitRig building={building} /> : <WalkRig building={building} onPick={select} onUnlock={() => setLocked(false)} />}
      </Canvas>

      <div className="visit__bar">
        <div className="segmented">
          <button className={mode === 'orbit' ? 'is-active' : ''} onClick={() => setMode('orbit')}>
            Vue d'ensemble
          </button>
          <button className={mode === 'walk' ? 'is-active' : ''} onClick={() => setMode('walk')}>
            Se promener
          </button>
        </div>
      </div>
      {mode === 'walk' && !locked && (
        <div className="visit__hint">
          <strong>Cliquez dans la scène pour entrer dans la maison.</strong>
          <span>Avancer : Z/W ou ↑ · Reculer : S ou ↓ · Côtés : Q/A, D · Courir : Maj</span>
          <span>Visez un sol, un mur, une fenêtre ou un meuble et cliquez pour le modifier. Échap pour reprendre la souris.</span>
        </div>
      )}
      {mode === 'walk' && locked && <div className="visit__crosshair" />}
      {mode === 'orbit' && (
        <div className="visit__hint visit__hint--small">Faites tourner avec la souris, cliquez sur un élément pour le modifier.</div>
      )}
    </div>
  );
}
