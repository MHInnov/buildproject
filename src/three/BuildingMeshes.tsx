import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Catalog, Product } from '../model/catalog';
import { productById } from '../model/catalog';
import { detectRooms, lerp, wallLength, wallNormal, wallSideFacingRoom } from '../model/geometry';
import { floorToFloor, levelAbove, levelBelow, levelById } from '../model/levels';
import type { Building, FurnitureItem, Level, Opening, Point, Room, Wall, WallSide } from '../model/types';
import type { Selection } from '../store';
import { useUi } from '../uiState';
import { CEILING, ceramic, chrome, FACADE, fromProduct, glassMaterial, meterBox, plain, PLASTER, RAW_FLOOR, surfaceMaterial, type Surface } from './materials';
import { RoofMesh } from './RoofMesh';

export interface Pick {
  sel: NonNullable<Selection>;
}

interface Props {
  building: Building;
  catalog: Catalog;
  selection: Selection;
  /** Niveaux affichés (coupe par étage). */
  visibleLevels: Set<string>;
  showRoof: boolean;
  showCeiling: boolean;
  night: boolean;
  onPick?: (sel: NonNullable<Selection>) => void;
}

type ClickHandler = (e: { stopPropagation: () => void; delta: number }) => void;

/** Interrupteur d'une pièce : à côté de la première porte, côté pièce, à 1,10 m. */
export interface SwitchSpot {
  roomId: string;
  levelId: string;
  pos: THREE.Vector3;
  rotY: number;
}

export function switchSpots(b: Building, rooms: Room[]): SwitchSpot[] {
  const out: SwitchSpot[] = [];
  for (const r of rooms) {
    const level = levelById(b, r.label.levelId);
    if (!level) continue;
    for (const id of r.wallIds) {
      const w = b.walls.find((x) => x.id === id);
      if (!w) continue;
      const door = b.openings.find((o) => o.wallId === w.id && o.kind === 'porte');
      if (!door) continue;
      const side = wallSideFacingRoom(w, r);
      if (!side) continue;
      const L = wallLength(w);
      const along = Math.min(L - 0.1, door.offset + door.width / 2 + 0.18);
      const p = lerp(w.a, w.b, along / L);
      const n = wallNormal(w, side);
      out.push({
        roomId: r.label.id,
        levelId: r.label.levelId,
        pos: new THREE.Vector3(p.x + n.x * (w.thickness / 2 + 0.006), level.elevation + 1.1, p.y + n.y * (w.thickness / 2 + 0.006)),
        rotY: Math.atan2(n.x, n.y),
      });
      break;
    }
  }
  return out;
}

export function BuildingMeshes({ building, catalog, selection, visibleLevels, showRoof, showCeiling, night, onPick }: Props) {
  const rooms = useMemo(() => detectRooms(building), [building]);
  const toggled = useUi((s) => s.toggled);
  const lights = useUi((s) => s.lights);
  const toggle = useUi((s) => s.toggle);
  const toggleLight = useUi((s) => s.toggleLight);
  const isSel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const click = (sel: NonNullable<Selection>): ClickHandler => (e) => {
    if (!onPick || e.delta > 4) return;
    e.stopPropagation();
    onPick(sel);
  };

  // Faces de mur tournées vers une pièce (les autres sont des façades).
  const facing = useMemo(() => {
    const m = new Map<string, Set<WallSide>>();
    for (const r of rooms) {
      for (const id of r.wallIds) {
        const w = building.walls.find((x) => x.id === id);
        const side = w && wallSideFacingRoom(w, r);
        if (!side) continue;
        if (!m.has(id)) m.set(id, new Set());
        m.get(id)!.add(side);
      }
    }
    return m;
  }, [rooms, building.walls]);

  // Trémies : emprise des escaliers du niveau inférieur, à découper dans le plancher.
  const holes = useMemo(() => {
    const m = new Map<string, Point[][]>();
    for (const f of building.furniture) {
      const p = productById(catalog, f.productId);
      if (p?.category !== 'escalier') continue;
      const up = levelAbove(building, f.levelId);
      if (!up) continue;
      const s = p.size ?? { w: 0.8, d: 3.6, h: 2.8 };
      const a = (f.rotation * Math.PI) / 180;
      const corners = [
        [-s.w / 2, -s.d / 2],
        [s.w / 2, -s.d / 2],
        [s.w / 2, s.d / 2],
        [-s.w / 2, s.d / 2],
      ].map(([x, y]) => ({ x: f.x + x * Math.cos(a) - y * Math.sin(a), y: f.y + x * Math.sin(a) + y * Math.cos(a) }));
      if (!m.has(up.id)) m.set(up.id, []);
      m.get(up.id)!.push(corners);
    }
    return m;
  }, [building, catalog]);

  const spots = useMemo(() => switchSpots(building, rooms), [building, rooms]);
  const lowest = Math.min(...building.levels.map((l) => l.elevation));
  const roofLevel = building.roof?.levelId;

  return (
    <group>
      {building.levels
        .filter((l) => visibleLevels.has(l.id))
        .map((level) => {
          const lRooms = rooms.filter((r) => r.label.levelId === level.id);
          const below = levelBelow(building, level.id);
          const floorThickness = level.elevation > lowest && below ? below.slab : 0;
          const underRoof = roofLevel === level.id && building.roof?.type !== 'plat';
          return (
            <group key={level.id}>
              {lRooms.map((r) => (
                <Floor
                  key={r.label.id}
                  room={r}
                  elevation={level.elevation}
                  thickness={floorThickness}
                  holes={holes.get(level.id) ?? []}
                  surface={fromProduct(productById(catalog, r.label.floorProductId), RAW_FLOOR)}
                  selected={isSel('room', r.label.id)}
                  onClick={click({ kind: 'room', id: r.label.id })}
                />
              ))}
              {showCeiling && !underRoof && lRooms.map((r) => <Ceiling key={`c-${r.label.id}`} room={r} height={level.elevation + level.height} />)}
              {building.walls
                .filter((w) => w.levelId === level.id)
                .map((w) => (
                  <WallMesh
                    key={w.id}
                    wall={w}
                    elevation={level.elevation}
                    openings={building.openings.filter((o) => o.wallId === w.id)}
                    catalog={catalog}
                    facing={facing.get(w.id)}
                    selected={isSel('wall', w.id)}
                    selectedOpening={selection?.kind === 'opening' ? selection.id : null}
                    toggled={toggled}
                    onClick={click({ kind: 'wall', id: w.id })}
                    onOpeningClick={(id) => click({ kind: 'opening', id })}
                    onOpeningToggle={toggle}
                  />
                ))}
              {building.furniture
                .filter((f) => f.levelId === level.id)
                .map((f) => {
                  const p = productById(catalog, f.productId);
                  return p ? (
                    <FurnitureMesh key={f.id} item={f} product={p} level={level} selected={isSel('furniture', f.id)} onClick={click({ kind: 'furniture', id: f.id })} />
                  ) : null;
                })}
              {lRooms.map((r) => (
                <Lamp key={`lamp-${r.label.id}`} room={r} level={level} underRoof={underRoof} on={!!lights[r.label.id]} night={night} />
              ))}
              {spots
                .filter((s) => s.levelId === level.id)
                .map((s) => (
                  <mesh
                    key={`sw-${s.roomId}`}
                    position={s.pos}
                    rotation-y={s.rotY}
                    material={plain(lights[s.roomId] ? '#fffbe6' : '#f4f4f2', 0.35)}
                    userData={{ action: { kind: 'light', id: s.roomId } }}
                    onClick={(e) => {
                      if (e.delta > 4) return;
                      e.stopPropagation();
                      toggleLight(s.roomId);
                    }}
                  >
                    <boxGeometry args={[0.085, 0.085, 0.014]} />
                  </mesh>
                ))}
            </group>
          );
        })}
      {showRoof && building.roof && (
        <RoofMesh building={building} catalog={catalog} selected={selection?.kind === 'roof'} onClick={click({ kind: 'roof', id: 'roof' })} />
      )}
    </group>
  );
}

function shapeOf(poly: Point[], holes: Point[][] = []): THREE.Shape {
  // (x, -y) puis rotation -90° autour de X : le point du plan (x, y) arrive en (x, 0, y).
  const s = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.y)));
  for (const h of holes) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, -p.y))));
  return s;
}

function Floor({ room, elevation, thickness, holes, surface, selected, onClick }: { room: Room; elevation: number; thickness: number; holes: Point[][]; surface: Surface; selected: boolean; onClick: ClickHandler }) {
  // Trémies entièrement contenues dans la pièce
  const inside = holes.filter((h) => h.every((p) => pointInside(p, room.polygon)));
  const geom = useMemo(() => {
    const shape = shapeOf(room.polygon, inside);
    return thickness > 0 ? new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }) : new THREE.ShapeGeometry(shape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, thickness, JSON.stringify(inside)]);
  const mats = thickness > 0 ? [surfaceMaterial(surface, selected), surfaceMaterial(CEILING)] : surfaceMaterial(surface, selected);
  return (
    <mesh
      geometry={geom}
      rotation-x={-Math.PI / 2}
      position-y={elevation - thickness + 0.001}
      material={mats}
      userData={{ sel: { kind: 'room', id: room.label.id } }}
      onClick={onClick}
      receiveShadow
      castShadow={thickness > 0}
    />
  );
}

function pointInside(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function Ceiling({ room, height }: { room: Room; height: number }) {
  const geom = useMemo(() => new THREE.ShapeGeometry(shapeOf(room.polygon)), [room]);
  return <mesh geometry={geom} rotation-x={Math.PI / 2} position-y={height} material={surfaceMaterial(CEILING, false, { side: THREE.FrontSide })} receiveShadow />;
}

/** Suspension au plafond + lumière de la pièce (éteinte = intensité nulle, sans recompiler les shaders). */
function Lamp({ room, level, underRoof, on, night }: { room: Room; level: Level; underRoof: boolean; on: boolean; night: boolean }) {
  const top = level.elevation + (underRoof ? Math.min(level.height + 1.2, 2.4) : level.height);
  const y = top - 0.45;
  const bulb = useMemo(() => new THREE.MeshStandardMaterial({ color: '#fff7e0', emissive: new THREE.Color('#ffd48a'), emissiveIntensity: 0, roughness: 0.4 }), []);
  bulb.emissiveIntensity = on ? 2.2 : 0;
  return (
    <group position={[room.label.at.x, 0, room.label.at.y]}>
      {!underRoof && (
        <mesh position-y={top - 0.2} material={plain('#2b2b2b', 0.6)}>
          <cylinderGeometry args={[0.004, 0.004, 0.4, 4]} />
        </mesh>
      )}
      <mesh position-y={y} material={plain('#e9e4da', 0.6)} castShadow={false}>
        <cylinderGeometry args={[0.06, 0.18, 0.16, 20, 1, true]} />
      </mesh>
      <mesh position-y={y - 0.03} material={bulb}>
        <sphereGeometry args={[0.045, 12, 8]} />
      </mesh>
      <pointLight position-y={y - 0.08} intensity={on ? (night ? 9 : 4) : 0} distance={0} decay={2} color="#ffe2b8" />
    </group>
  );
}

interface Piece {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Découpe un mur en blocs pleins autour des ouvertures. */
export function wallPieces(w: Wall, openings: Opening[]): Piece[] {
  const L = wallLength(w);
  const ops = openings
    .map((o) => ({ s: Math.max(0, o.offset - o.width / 2), e: Math.min(L, o.offset + o.width / 2), o }))
    .sort((a, b) => a.s - b.s);
  const pieces: Piece[] = [];
  let cur = 0;
  for (const { s, e, o } of ops) {
    if (s > cur) pieces.push({ x0: cur, x1: s, y0: 0, y1: w.height });
    if (o.sill > 0) pieces.push({ x0: s, x1: e, y0: 0, y1: o.sill });
    const top = Math.min(w.height, o.sill + o.height);
    if (top < w.height) pieces.push({ x0: s, x1: e, y0: top, y1: w.height });
    cur = Math.max(cur, e);
  }
  if (cur < L) pieces.push({ x0: cur, x1: L, y0: 0, y1: w.height });
  return pieces.filter((p) => p.x1 - p.x0 > 0.001 && p.y1 - p.y0 > 0.001);
}

function WallMesh({ wall, elevation, openings, catalog, facing, selected, selectedOpening, toggled, onClick, onOpeningClick, onOpeningToggle }: {
  wall: Wall;
  elevation: number;
  openings: Opening[];
  catalog: Catalog;
  facing?: Set<WallSide>;
  selected: boolean;
  selectedOpening: string | null;
  toggled: Record<string, boolean>;
  onClick: ClickHandler;
  onOpeningClick: (id: string) => ClickHandler;
  onOpeningToggle: (id: string) => void;
}) {
  const L = wallLength(wall);
  const angle = -Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
  const th = wall.thickness;
  const faceSurface = (side: WallSide): Surface => {
    const p = productById(catalog, wall.finish[side]);
    if (p) return fromProduct(p, PLASTER);
    // Face sans pièce = façade : brique pour un mur porteur, enduit sinon.
    if (!facing?.has(side)) return wall.kind === 'porteur' ? FACADE : PLASTER;
    return PLASTER;
  };
  const left = surfaceMaterial(faceSurface('gauche'), selected);
  const right = surfaceMaterial(faceSurface('droite'), selected);
  const edge = surfaceMaterial(facing && facing.size === 0 ? FACADE : PLASTER, selected);
  // Ordre des faces d'une BoxGeometry : +x, -x, +y, -y, +z (gauche), -z (droite)
  const materials = [edge, edge, edge, edge, left, right];
  const pieces = useMemo(
    () =>
      wallPieces(wall, openings).map((piece) => {
        // Les blocs en bout de mur débordent d'une demi-épaisseur pour fermer les angles.
        const p = { ...piece, x0: piece.x0 <= 0.001 ? -th / 2 : piece.x0, x1: piece.x1 >= L - 0.001 ? L + th / 2 : piece.x1 };
        return { p, geo: meterBox(p.x1 - p.x0, p.y1 - p.y0, th, p.x0, p.y0) };
      }),
    [wall, openings, th, L],
  );
  useEffect(() => () => pieces.forEach((x) => x.geo.dispose()), [pieces]);
  // Côté où s'ouvrent les portes et fenêtres : vers une pièce si possible.
  const inward: 1 | -1 = facing?.has('gauche') ? 1 : facing?.has('droite') ? -1 : 1;

  return (
    <group position={[wall.a.x, elevation, wall.a.y]} rotation-y={angle}>
      {pieces.map(({ p, geo }, i) => {
        return (
          <mesh
            key={`${i}-${p.x0}-${p.x1}-${p.y0}`}
            position={[(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, 0]}
            geometry={geo}
            material={materials}
            userData={{ sel: { kind: 'wall', id: wall.id } }}
            onClick={onClick}
            castShadow
            receiveShadow
          />
        );
      })}
      {openings.map((o) => {
        const isOpen = o.kind === 'porte' ? !toggled[o.id] : !!toggled[o.id];
        const handle = onOpeningClick(o.id);
        return (
          <OpeningMesh
            key={o.id}
            o={o}
            th={th}
            product={productById(catalog, o.productId)}
            selected={selectedOpening === o.id}
            open={isOpen}
            inward={inward}
            onClick={handle}
            onToggle={() => onOpeningToggle(o.id)}
          />
        );
      })}
    </group>
  );
}

/** Battant animé : la rotation suit l'état ouvert / fermé en douceur. */
function Swing({ target, children, position }: { target: number; children: React.ReactNode; position: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y += (target - g.rotation.y) * Math.min(1, dt * 6);
  });
  return (
    <group ref={ref} position={position} rotation-y={target}>
      {children}
    </group>
  );
}

function OpeningMesh({ o, th, product, selected, open, inward, onClick, onToggle }: {
  o: Opening;
  th: number;
  product: Product | undefined;
  selected: boolean;
  open: boolean;
  inward: 1 | -1;
  onClick: ClickHandler;
  onToggle: () => void;
}) {
  const color = product?.color ?? '#f3f3f0';
  const surface: Surface = { color, pattern: product?.pattern, roughness: product?.roughness ?? 0.5 };
  const frame = surfaceMaterial(surface, selected);
  const casing = plain(product?.existingOnly ? color : '#f5f4f0', 0.5, selected);
  const s = o.offset - o.width / 2;
  const f = 0.06; // section du cadre
  const ud = { sel: { kind: 'opening', id: o.id }, action: { kind: 'opening', id: o.id } };
  const events = {
    userData: ud,
    onClick,
    onDoubleClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onToggle();
    },
  };

  if (o.kind === 'porte') {
    const leafW = o.width - 0.02;
    const leafH = o.height - 0.02;
    const glazed = product?.tags.includes('vitré');
    return (
      <group>
        {/* Chambranles sur les deux faces */}
        {[1, -1].map((side) => (
          <group key={side} position-z={side * (th / 2 + 0.008)}>
            <mesh position={[s - 0.035, o.height / 2, 0]} material={casing}>
              <boxGeometry args={[0.07, o.height + 0.07, 0.016]} />
            </mesh>
            <mesh position={[s + o.width + 0.035, o.height / 2, 0]} material={casing}>
              <boxGeometry args={[0.07, o.height + 0.07, 0.016]} />
            </mesh>
            <mesh position={[o.offset, o.height + 0.035, 0]} material={casing}>
              <boxGeometry args={[o.width + 0.14, 0.07, 0.016]} />
            </mesh>
          </group>
        ))}
        {/* Vantail pivotant sur ses paumelles */}
        <Swing target={open ? -inward * Math.PI * 0.48 : 0} position={[s + 0.01, 0, 0]}>
          <LeafMesh w={leafW} h={leafH} material={glazed ? [frame, frame, frame, frame, glassMaterial, glassMaterial] : frame} events={events} />
          {glazed &&
            [0.25, 0.5, 0.75].map((k) => (
              <mesh key={k} position={[leafW / 2, leafH * k, 0]} material={frame} {...events}>
                <boxGeometry args={[leafW, 0.03, 0.045]} />
              </mesh>
            ))}
          {[1, -1].map((side) => (
            <mesh key={side} position={[leafW - 0.08, 1.02, side * 0.045]} material={chrome}>
              <boxGeometry args={[0.13, 0.02, 0.02]} />
            </mesh>
          ))}
        </Swing>
      </group>
    );
  }

  const yMid = o.sill + o.height / 2;
  const sashW = o.width - 2 * f;
  const sashH = o.height - 2 * f;
  return (
    <group>
      {/* Dormant */}
      {[
        [o.offset, o.sill + f / 2, o.width, f],
        [o.offset, o.sill + o.height - f / 2, o.width, f],
        [s + f / 2, yMid, f, o.height],
        [s + o.width - f / 2, yMid, f, o.height],
      ].map(([x, y, w, h], i) => (
        <mesh key={i} position={[x, y, 0]} material={frame} castShadow {...events}>
          <boxGeometry args={[w, h, 0.08]} />
        </mesh>
      ))}
      {/* Tablette intérieure et seuil extérieur */}
      <mesh position={[o.offset, o.sill - 0.015, inward * (th / 2 + 0.03)]} material={plain('#ece9e2', 0.5)} receiveShadow>
        <boxGeometry args={[o.width + 0.1, 0.03, 0.1]} />
      </mesh>
      <mesh position={[o.offset, o.sill - 0.03, -inward * (th / 2 + 0.02)]} material={plain('#8d8a84', 0.8)} receiveShadow>
        <boxGeometry args={[o.width + 0.08, 0.05, 0.08]} />
      </mesh>
      {/* Ouvrant : vitrage + petit bois, pivote vers l'intérieur */}
      <Swing target={open ? inward * -1.2 : 0} position={[s + f, 0, inward * 0.02]}>
        <mesh position={[sashW / 2, yMid, 0]} material={glassMaterial} {...events}>
          <boxGeometry args={[sashW - 0.06, sashH - 0.06, 0.012]} />
        </mesh>
        {[
          [sashW / 2, o.sill + f + 0.025, sashW, 0.05],
          [sashW / 2, o.sill + o.height - f - 0.025, sashW, 0.05],
          [0.025, yMid, 0.05, sashH],
          [sashW - 0.025, yMid, 0.05, sashH],
        ].map(([x, y, w, h], i) => (
          <mesh key={i} position={[x, y, 0]} material={frame} castShadow {...events}>
            <boxGeometry args={[w, h, 0.06]} />
          </mesh>
        ))}
        <mesh position={[sashW - 0.05, yMid, inward * 0.04]} material={chrome}>
          <boxGeometry args={[0.02, 0.12, 0.02]} />
        </mesh>
      </Swing>
    </group>
  );
}

function Box({ size, pos, color, selected, roughness, material }: { size: [number, number, number]; pos: [number, number, number]; color?: string; selected?: boolean; roughness?: number; material?: THREE.Material }) {
  return (
    <mesh position={pos} material={material ?? plain(color ?? '#cccccc', roughness ?? 0.8, selected)} castShadow receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

function shade(color: string, k: number): string {
  const c = new THREE.Color(color);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/** Escalier droit : marches, limons et main courante ; monte vers -y local (haut du symbole en plan). */
function Stair({ w, d, rise, color, selected }: { w: number; d: number; rise: number; color: string; selected: boolean }) {
  const n = Math.max(3, Math.round(rise / 0.18));
  const h = rise / n;
  const g = d / n;
  const tread = surfaceMaterial({ color, pattern: { kind: 'planks', w: 0.2, h: 1.2 }, roughness: 0.6 }, selected);
  const slope = Math.atan2(rise, d);
  const len = Math.hypot(rise, d);
  const dark = shade(color, 0.7);
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[0, (i + 1) * h - 0.02, d / 2 - (i + 0.5) * g]} material={tread} castShadow receiveShadow>
          <boxGeometry args={[w - 0.08, 0.04, g + 0.03]} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (w / 2 - 0.02), rise / 2 - 0.05, 0]} rotation-x={slope} material={plain(dark, 0.6, selected)} castShadow>
          <boxGeometry args={[0.04, 0.25, len]} />
        </mesh>
      ))}
      {/* Main courante */}
      <mesh position={[w / 2 - 0.02, rise / 2 + 0.85, 0]} rotation-x={slope} material={plain(dark, 0.5, selected)}>
        <boxGeometry args={[0.04, 0.04, len]} />
      </mesh>
      {[0.15, 0.5, 0.85].map((k) => (
        <mesh key={k} position={[w / 2 - 0.02, k * rise + 0.45, d / 2 - k * d]} material={plain(dark, 0.5, selected)}>
          <boxGeometry args={[0.025, 0.9, 0.025]} />
        </mesh>
      ))}
    </group>
  );
}

/** Meuble simplifié selon sa famille (assez pour juger volumes, couleurs et circulation). */
function FurnitureMesh({ item, product: p, level, selected, onClick }: { item: FurnitureItem; product: Product; level: Level; selected: boolean; onClick: ClickHandler }) {
  const { w, d, h } = p.size ?? { w: 0.6, d: 0.6, h: 0.8 };
  const c = p.color;
  const dark = shade(c, 0.75);
  const white = selected ? plain('#fbfbfa', 0.15, true) : ceramic;
  let parts: React.ReactNode;
  if (p.category === 'escalier') {
    parts = <Stair w={w} d={d} rise={floorToFloor(level)} color={c} selected={selected} />;
  } else
    switch (p.subcategory) {
      case 'canape':
        parts = (
          <>
            <Box size={[w, 0.42, d]} pos={[0, 0.21, 0]} color={c} selected={selected} roughness={0.95} />
            <Box size={[w, 0.4, 0.2]} pos={[0, 0.6, -d / 2 + 0.1]} color={dark} selected={selected} roughness={0.95} />
            <Box size={[0.18, 0.25, d]} pos={[-w / 2 + 0.09, 0.54, 0]} color={dark} selected={selected} roughness={0.95} />
            <Box size={[0.18, 0.25, d]} pos={[w / 2 - 0.09, 0.54, 0]} color={dark} selected={selected} roughness={0.95} />
          </>
        );
        break;
      case 'table':
      case 'bureau': {
        const round = p.tags.includes('ronde');
        const wood = surfaceMaterial({ color: c, pattern: p.tags.includes('bois') ? { kind: 'planks', w: 0.3, h: 2 } : undefined, roughness: 0.5 }, selected);
        parts = (
          <>
            {round ? (
              <mesh position={[0, h - 0.02, 0]} material={wood} castShadow>
                <cylinderGeometry args={[w / 2, w / 2, 0.04, 40]} />
              </mesh>
            ) : (
              <Box size={[w, 0.04, d]} pos={[0, h - 0.02, 0]} material={wood} />
            )}
            {round ? (
              <Box size={[0.08, h - 0.04, 0.08]} pos={[0, (h - 0.04) / 2, 0]} color={dark} selected={selected} />
            ) : (
              [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
                <Box key={i} size={[0.05, h - 0.04, 0.05]} pos={[sx * (w / 2 - 0.06), (h - 0.04) / 2, sz * (d / 2 - 0.06)]} color={dark} selected={selected} />
              ))
            )}
          </>
        );
        break;
      }
      case 'chaise':
        parts = (
          <>
            <Box size={[w, 0.04, d]} pos={[0, 0.45, 0]} color={c} selected={selected} />
            <Box size={[w, 0.4, 0.04]} pos={[0, 0.66, -d / 2 + 0.02]} color={c} selected={selected} />
            {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
              <Box key={i} size={[0.03, 0.45, 0.03]} pos={[sx * (w / 2 - 0.03), 0.225, sz * (d / 2 - 0.03)]} color={dark} selected={selected} />
            ))}
          </>
        );
        break;
      case 'lit':
        parts = (
          <>
            <Box size={[w, 0.3, d]} pos={[0, 0.15, 0]} color={c} selected={selected} />
            <Box size={[w - 0.08, 0.22, d - 0.12]} pos={[0, 0.41, 0.04]} color="#f4f2ee" selected={selected} roughness={0.95} />
            <Box size={[w - 0.06, 0.06, d * 0.6]} pos={[0, 0.54, d * 0.18]} color="#c9d3da" selected={selected} roughness={0.95} />
            <Box size={[w, h, 0.08]} pos={[0, h / 2, -d / 2 + 0.04]} color={dark} selected={selected} />
            <Box size={[w * 0.35, 0.12, 0.35]} pos={[-w * 0.22, 0.58, -d / 2 + 0.3]} color="#ffffff" selected={selected} />
            <Box size={[w * 0.35, 0.12, 0.35]} pos={[w * 0.22, 0.58, -d / 2 + 0.3]} color="#ffffff" selected={selected} />
          </>
        );
        break;
      case 'cuisine':
        parts = (
          <>
            <Box size={[w, h - 0.04, d - 0.02]} pos={[0, (h - 0.04) / 2, 0.01]} color={c} selected={selected} roughness={0.4} />
            <Box size={[w + 0.02, 0.04, d + 0.02]} pos={[0, h - 0.02, 0]} color="#5b5752" selected={selected} roughness={0.3} />
            {Array.from({ length: Math.max(1, Math.round(w / 0.6)) - 1 }, (_, i) => (
              <Box key={i} size={[0.004, h - 0.12, 0.004]} pos={[-w / 2 + (i + 1) * (w / Math.round(w / 0.6)), (h - 0.04) / 2, d / 2 - 0.005]} color={dark} />
            ))}
            {!p.tags.includes('îlot') && (
              <mesh position={[w * 0.2, h + 0.01, 0]} material={chrome}>
                <boxGeometry args={[0.5, 0.02, 0.4]} />
              </mesh>
            )}
          </>
        );
        break;
      case 'wc':
        parts = p.id === 'lave-mains' ? (
          <>
            <Box size={[w, 0.14, d]} pos={[0, 0.78, 0]} material={white} />
            <mesh position={[0, 0.92, -d / 2 + 0.05]} material={chrome}>
              <cylinderGeometry args={[0.012, 0.012, 0.16, 8]} />
            </mesh>
          </>
        ) : (
          <>
            <mesh position={[0, p.id === 'wc-suspendu' ? 0.32 : 0.2, 0.05]} material={white} castShadow>
              <cylinderGeometry args={[0.18, 0.14, p.id === 'wc-suspendu' ? 0.18 : 0.4, 24]} />
            </mesh>
            <Box size={[0.36, 0.03, 0.42]} pos={[0, p.id === 'wc-suspendu' ? 0.42 : 0.41, 0.06]} material={white} />
            {p.id === 'wc-suspendu' ? (
              <Box size={[w + 0.24, 1.1, 0.2]} pos={[0, 0.55, -d / 2 - 0.02]} color="#f1efe9" selected={selected} />
            ) : (
              <Box size={[0.36, 0.38, 0.18]} pos={[0, 0.6, -d / 2 + 0.09]} material={white} />
            )}
          </>
        );
        break;
      case 'chauffage':
        parts = (
          <>
            {Array.from({ length: Math.max(4, Math.round(w / 0.05)) }, (_, i) => (
              <Box key={i} size={[0.03, h, d * 0.8]} pos={[-w / 2 + 0.025 + i * (w / Math.max(4, Math.round(w / 0.05))), 0.15 + h / 2, 0]} color={c} selected={selected} roughness={0.3} />
            ))}
          </>
        );
        break;
      case 'salle-de-bain':
        if (p.tags.includes('douche'))
          parts = (
            <>
              <Box size={[w, 0.04, d]} pos={[0, 0.02, 0]} material={white} />
              <mesh position={[w / 2 - 0.01, h / 2, 0]} material={glassMaterial}>
                <boxGeometry args={[0.01, h, d]} />
              </mesh>
              <mesh position={[-w / 2 + 0.2, 1.9, -d / 2 + 0.25]} material={chrome}>
                <cylinderGeometry args={[0.1, 0.1, 0.015, 24]} />
              </mesh>
            </>
          );
        else if (p.tags.includes('baignoire'))
          parts = (
            <>
              <Box size={[w, h, d]} pos={[0, h / 2, 0]} material={white} />
              <Box size={[w - 0.12, 0.02, d - 0.12]} pos={[0, h - 0.06, 0]} color="#dfe7ea" roughness={0.1} />
              <mesh position={[-w / 2 + 0.12, h + 0.1, 0]} material={chrome}>
                <cylinderGeometry args={[0.015, 0.015, 0.2, 8]} />
              </mesh>
            </>
          );
        else if (p.tags.includes('radiateur'))
          parts = (
            <>
              {Array.from({ length: 8 }, (_, i) => (
                <mesh key={i} position={[0, 0.35 + (i * h) / 8, 0]} rotation-z={Math.PI / 2} material={chrome}>
                  <cylinderGeometry args={[0.012, 0.012, w, 8]} />
                </mesh>
              ))}
            </>
          );
        else
          parts = (
            <>
              <Box size={[w, h - 0.05, d]} pos={[0, (h - 0.05) / 2, 0]} color={c} selected={selected} roughness={0.4} />
              <Box size={[w * 0.6, 0.05, d * 0.6]} pos={[0, h - 0.025, 0]} material={white} />
              <Box size={[w * 0.9, 0.7, 0.02]} pos={[0, h + 0.55, -d / 2 + 0.01]} color="#cfdde4" roughness={0.02} />
            </>
          );
        break;
      default:
        parts = <Box size={[w, h, d]} pos={[0, h / 2, 0]} color={c} selected={selected} />;
    }
  return (
    <group position={[item.x, level.elevation, item.y]} rotation-y={(-item.rotation * Math.PI) / 180} userData={{ sel: { kind: 'furniture', id: item.id } }} onClick={onClick}>
      {parts}
    </group>
  );
}

function LeafMesh({ w, h, material, events }: { w: number; h: number; material: THREE.Material | THREE.Material[]; events: Record<string, unknown> }) {
  const geo = useMemo(() => meterBox(w, h, 0.04), [w, h]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh position={[w / 2, h / 2 + 0.01, 0]} geometry={geo} material={material} castShadow {...events} />;
}
