import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Catalog, Product } from '../model/catalog';
import { itemProduct, leavesOf } from '../model/generic';
import { productById } from '../model/catalog';
import { detectRooms, lerp, wallLength, wallNormal, wallSideFacingRoom } from '../model/geometry';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { floorToFloor, levelAbove, levelBelow, levelById } from '../model/levels';
import type { Building, FloorZone, FurnitureItem, Level, Opening, Point, Room, Wall, WallSide } from '../model/types';
import type { Selection } from '../store';
import { useUi } from '../uiState';
import { CEILING, ceramic, chrome, FACADE, fromProduct, glassMaterial, meterBox, plain, PLASTER, RAW_FLOOR, surfaceMaterial, type Surface } from './materials';
import { RoofMesh } from './RoofMesh';
import { atticProfiles, clipUnderRoof, prismGeometry, type WallProfile } from './attic';
import { floorOffsetAt } from './physics';
import { levelOutline } from '../model/footprint';

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
  onMenu?: (t: MenuTarget) => void;
}

type ClickHandler = (e: { stopPropagation: () => void; delta: number; face?: { materialIndex: number } | null }) => void;

/** Face d'un mur touchée : les boîtes de mur portent la face gauche en matériau 4, la droite en 5. */
const faceSide = (face?: { materialIndex: number } | null): WallSide | undefined =>
  face?.materialIndex === 4 ? 'gauche' : face?.materialIndex === 5 ? 'droite' : undefined;

/** Élément visé par un clic droit dans la visite. */
export interface MenuTarget {
  sel: NonNullable<Selection>;
  /** Point touché, en coordonnées du plan (mètres). */
  at: Point;
  screen: { x: number; y: number };
}

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

export function BuildingMeshes({ building, catalog, selection, visibleLevels, showRoof, showCeiling, night, onPick, onMenu }: Props) {
  const rooms = useMemo(() => detectRooms(building), [building]);
  const toggled = useUi((s) => s.toggled);
  const lights = useUi((s) => s.lights);
  const toggle = useUi((s) => s.toggle);
  const toggleLight = useUi((s) => s.toggleLight);
  const isSel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const click = (sel: NonNullable<Selection>): ClickHandler => (e) => {
    if (!onPick || e.delta > 4) return;
    e.stopPropagation();
    onPick(sel.kind === 'wall' ? { ...sel, side: faceSide(e.face) } : sel);
  };
  const contextMenu = (e: ThreeEvent<MouseEvent>) => {
    if (!onMenu) return;
    let o: THREE.Object3D | null = e.object;
    let sel: NonNullable<Selection> | null = null;
    while (o && !sel) {
      sel = (o.userData?.sel as NonNullable<Selection> | undefined) ?? null;
      o = o.parent;
    }
    if (!sel) return;
    e.stopPropagation();
    e.nativeEvent.preventDefault();
    if (sel.kind === 'wall') sel = { ...sel, side: faceSide(e.face) };
    onMenu({ sel, at: { x: e.point.x, y: e.point.z }, screen: { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } });
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
      const p = itemProduct(catalog, f);
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
  // Combles aménagés : murs mansardés et pignons qui suivent la pente du toit
  const profiles = useMemo(() => {
    const fn = atticProfiles(building);
    return fn ? new Map(building.walls.map((w) => [w.id, fn(w)])) : null;
  }, [building]);
  // Planchers : sous chaque étage, une dalle sur toute l'emprise du niveau du dessous (murs compris)
  const outlines = useMemo(() => {
    const m = new Map<string, Point[][]>();
    for (const l of building.levels) {
      const below = levelBelow(building, l.id);
      if (!below) continue;
      m.set(l.id, levelOutline(building.walls.filter((w) => w.levelId === below.id)));
    }
    return m;
  }, [building.levels, building.walls]);
  const lowest = Math.min(...building.levels.map((l) => l.elevation));
  const roofLevel = building.roof?.levelId;

  return (
    <group onContextMenu={contextMenu}>
      {building.levels
        .filter((l) => visibleLevels.has(l.id))
        .map((level) => {
          const lRooms = rooms.filter((r) => r.label.levelId === level.id);
          const below = levelBelow(building, level.id);
          const floorThickness = level.elevation > lowest && below ? below.slab : 0;
          const underRoof = roofLevel === level.id && building.roof?.type !== 'plat';
          return (
            <group key={level.id}>
              {below && floorThickness > 0.02 && (outlines.get(level.id) ?? []).map((o, i) => (
                <Slab key={`slab-${i}`} outline={o} top={level.elevation - 0.01} thickness={floorThickness - 0.014} holes={holes.get(level.id) ?? []} />
              ))}
              {lRooms.map((r) => (
                <Floor
                  key={r.label.id}
                  room={r}
                  elevation={level.elevation}
                  offset={r.label.floorOffset ?? 0}
                  thickness={floorThickness}
                  holes={holes.get(level.id) ?? []}
                  surface={fromProduct(productById(catalog, r.label.floorProductId), RAW_FLOOR)}
                  selected={isSel('room', r.label.id)}
                  onClick={click({ kind: 'room', id: r.label.id })}
                />
              ))}
              {(building.floorZones ?? [])
                .filter((z) => z.levelId === level.id && z.productId)
                .map((z) => (
                  <ZoneFloor
                    key={z.id}
                    zone={z}
                    elevation={level.elevation + floorOffsetAt(lRooms, level.id, { x: z.x + z.w / 2, y: z.y + z.h / 2 })}
                    surface={fromProduct(productById(catalog, z.productId), RAW_FLOOR)}
                    selected={isSel('zone', z.id)}
                    onClick={click({ kind: 'zone', id: z.id })}
                  />
                ))}
              {showCeiling && (!underRoof || building.roof?.eave != null) && lRooms.map((r) => <Ceiling key={`c-${r.label.id}`} room={r} height={level.elevation + roomCeiling(r, level) - 0.004} />)}
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
                    profile={profiles?.get(w.id) ?? null}
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
                  const p = itemProduct(catalog, f);
                  const lift = floorOffsetAt(lRooms, level.id, f);
                  return p ? (
                    <FurnitureMesh key={f.id} item={f} product={p} level={lift ? { ...level, elevation: level.elevation + lift } : level} selected={isSel('furniture', f.id)} onClick={click({ kind: 'furniture', id: f.id })} />
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
        <RoofMesh
          building={building}
          catalog={catalog}
          selected={selection?.kind === 'roof'}
          onClick={click({ kind: 'roof', id: 'roof' })}
          selectedWindow={selection?.kind === 'roofWindow' ? selection.id : null}
          onWindowClick={(id) => click({ kind: 'roofWindow', id })}
        />
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

/** Hauteur du plafond d'une pièce au-dessus du niveau (sol décalé + hauteur propre). */
export function roomCeiling(r: Room, level: Level): number {
  return (r.label.floorOffset ?? 0) + (r.label.ceilingHeight ?? level.height);
}

function Floor({ room, elevation, offset, thickness, holes, surface, selected, onClick }: { room: Room; elevation: number; offset: number; thickness: number; holes: Point[][]; surface: Surface; selected: boolean; onClick: ClickHandler }) {
  // Trémies entièrement contenues dans la pièce
  const inside = [...holes.filter((h) => h.every((p) => pointInside(p, room.polygon))), ...(room.holes ?? [])];
  const depth = Math.max(0, thickness + offset);
  const geom = useMemo(() => {
    const shape = shapeOf(room.polygon, inside);
    // Sol décalé : la dalle s'épaissit (estrade) ou descend (pièce en contrebas).
    return depth > 0.001 ? new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }) : new THREE.ShapeGeometry(shape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, depth, JSON.stringify(inside)]);
  const mats = depth > 0.001 ? [surfaceMaterial(surface, selected), surfaceMaterial(CEILING)] : surfaceMaterial(surface, selected);
  return (
    <mesh
      geometry={geom}
      rotation-x={-Math.PI / 2}
      position-y={elevation + offset - depth + 0.001}
      material={mats}
      userData={{ sel: { kind: 'room', id: room.label.id } }}
      onClick={onClick}
      receiveShadow
      castShadow={depth > 0.001}
    />
  );
}

const SLAB_EDGE = plain('#d8d2c8', 0.9);

/** Dalle de plancher entre deux niveaux, trémies d'escalier découpées. */
function Slab({ outline, top, thickness, holes }: { outline: Point[]; top: number; thickness: number; holes: Point[][] }) {
  const geom = useMemo(() => {
    const inside = holes.filter((h) => h.every((p) => pointInside(p, outline)));
    return new THREE.ExtrudeGeometry(shapeOf(outline, inside), { depth: thickness, bevelEnabled: false });
  }, [outline, thickness, holes]);
  return <mesh geometry={geom} rotation-x={-Math.PI / 2} position-y={top - thickness} material={[surfaceMaterial(RAW_FLOOR), SLAB_EDGE]} receiveShadow castShadow />;
}

/** Sol posé sur une partie de pièce : légèrement au-dessus du sol de la pièce. */
function ZoneFloor({ zone, elevation, surface, selected, onClick }: { zone: FloorZone; elevation: number; surface: Surface; selected: boolean; onClick: ClickHandler }) {
  const geom = useMemo(() => {
    const { x, y, w, h } = zone;
    return new THREE.ShapeGeometry(shapeOf([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]));
  }, [zone]);
  return (
    <mesh
      geometry={geom}
      rotation-x={-Math.PI / 2}
      position-y={elevation + 0.005}
      material={surfaceMaterial(surface, selected)}
      userData={{ sel: { kind: 'zone', id: zone.id } }}
      onClick={onClick}
      receiveShadow
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
  // Plan (x, y) tel quel puis rotation +90° autour de X : le point (x, y) arrive en (x, 0, y), face tournée vers le bas.
  const geom = useMemo(() => {
    const s = new THREE.Shape(room.polygon.map((p) => new THREE.Vector2(p.x, p.y)));
    for (const h of room.holes ?? []) s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    return new THREE.ShapeGeometry(s);
  }, [room]);
  return <mesh geometry={geom} rotation-x={Math.PI / 2} position-y={height} material={surfaceMaterial(CEILING, false, { side: THREE.FrontSide })} receiveShadow />;
}

/** Suspension au plafond + lumière de la pièce (éteinte = intensité nulle, sans recompiler les shaders). */
function Lamp({ room, level, underRoof, on, night }: { room: Room; level: Level; underRoof: boolean; on: boolean; night: boolean }) {
  const h = roomCeiling(room, level);
  const top = level.elevation + (underRoof ? Math.min(h + 1.2, 2.4) : h);
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
      {/* Lumière montée seulement quand elle est allumée : chaque lumière coûte à chaque image. */}
      {on && <pointLight position-y={y - 0.08} intensity={night ? 9 : 4} distance={0} decay={2} color="#ffe2b8" />}
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

function WallMesh({ wall, elevation, openings, catalog, facing, profile, selected, selectedOpening, toggled, onClick, onOpeningClick, onOpeningToggle }: {
  wall: Wall;
  profile?: WallProfile | null;
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
      wallPieces(profile ? { ...wall, height: profile.height } : wall, openings).flatMap((piece) => {
        // Les blocs en bout de mur débordent d'une demi-épaisseur pour fermer les angles.
        const p = { ...piece, x0: piece.x0 <= 0.001 ? -th / 2 : piece.x0, x1: piece.x1 >= L - 0.001 ? L + th / 2 : piece.x1 };
        // Sous un rampant : le haut du bloc suit la pente
        const clip = profile ? clipUnderRoof(p.x0, p.x1, p.y0, p.y1, profile) : 'box';
        if (clip === 'none') return [];
        if (clip === 'box') return [{ p, geo: meterBox(p.x1 - p.x0, p.y1 - p.y0, th, p.x0, p.y0), placed: false }];
        return [{ p, geo: prismGeometry(clip, th), placed: true }];
      }),
    [wall, openings, th, L, profile],
  );
  useEffect(() => () => pieces.forEach((x) => x.geo.dispose()), [pieces]);
  // Côté où s'ouvrent les portes et fenêtres : vers une pièce si possible.
  const inward: 1 | -1 = facing?.has('gauche') ? 1 : facing?.has('droite') ? -1 : 1;

  return (
    <group position={[wall.a.x, elevation, wall.a.y]} rotation-y={angle}>
      {pieces.map(({ p, geo, placed }, i) => {
        return (
          <mesh
            key={`${i}-${p.x0}-${p.x1}-${p.y0}`}
            position={placed ? [0, 0, 0] : [(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, 0]}
            geometry={geo}
            material={materials}
            userData={{ sel: { kind: 'wall', id: wall.id } }}
            onClick={onClick}
            castShadow
            receiveShadow
          />
        );
      })}
      {/* Plinthes au pied des faces tournées vers une pièce (pas dans les baies de porte) */}
      {[...(facing ?? [])].flatMap((side) =>
        pieces
          .filter(({ p }) => p.y0 <= 0.001)
          .map(({ p }, i) => {
            const x0 = Math.max(p.x0, th / 2);
            const x1 = Math.min(p.x1, L - th / 2);
            if (x1 - x0 < 0.05) return null;
            const z = (side === 'gauche' ? 1 : -1) * (th / 2 + 0.006);
            return (
              <mesh key={`pl-${side}-${i}`} position={[(x0 + x1) / 2, 0.04, z]} material={BASEBOARD} receiveShadow>
                <boxGeometry args={[x1 - x0, 0.08, 0.012]} />
              </mesh>
            );
          }),
      )}
      {openings.map((o) => {
        // Portes ouvertes par défaut, sauf les portes de garage (fermées : on les voit de dehors)
        const isOpen = o.kind === 'porte' && !isGarage(o) ? !toggled[o.id] : !!toggled[o.id];
        const handle = onOpeningClick(o.id);
        return (
          <OpeningMesh
            key={o.id}
            o={o}
            th={th}
            product={itemProduct(catalog, o)}
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

const isGarage = (o: Opening) => !!o.productId?.includes('garage');

/** Tablier qui monte ou descend en douceur. */
function Lift({ target, children }: { target: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.y += (target - g.position.y) * Math.min(1, dt * 1.4);
  });
  return (
    <group ref={ref} position-y={target}>
      {children}
    </group>
  );
}

/** Battant animé : la rotation suit l'état ouvert / fermé en douceur. */
function Swing({ target, children, position }: { target: number; children: React.ReactNode; position: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y += (target - g.rotation.y) * Math.min(1, dt * 2.6);
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

  const tags = product?.tags ?? [];
  const leaves = Math.max(1, leavesOf(product, o.options));
  // Chambranles des portes, sur les deux faces
  const casings = (
    <>
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
    </>
  );

  if (o.kind === 'porte' && isGarage(o) && !tags.includes('battante')) {
    // Sectionnelle : panneaux horizontaux ; enroulable : lames fines ; basculante : un seul panneau nervuré.
    // Le tablier remonte sous le plafond quand on l'ouvre.
    const roll = tags.includes('enroulable');
    const tilt = tags.includes('basculante');
    const panels = tilt ? 1 : roll ? Math.max(8, Math.round(o.height / 0.08)) : Math.max(3, Math.round(o.height / 0.5));
    const ph = (o.height - 0.04) / panels;
    const ribs = tilt ? Math.max(6, Math.round(o.width / 0.12)) : 0;
    return (
      <group>
        {casings}
        <Lift target={open ? o.height - 0.25 : 0}>
          {Array.from({ length: panels }, (_, i) => (
            <mesh key={i} position={[o.offset, 0.02 + ph * (i + 0.5), 0]} material={frame} castShadow receiveShadow {...events}>
              <boxGeometry args={[o.width - 0.02, ph - (roll ? 0.006 : 0.015), roll ? 0.03 : 0.045]} />
            </mesh>
          ))}
          {Array.from({ length: ribs }, (_, i) =>
            [1, -1].map((side) => (
              <mesh key={`${i}${side}`} position={[s + 0.06 + ((o.width - 0.12) * (i + 0.5)) / ribs, o.height / 2, side * 0.026]} material={frame} {...events}>
                <boxGeometry args={[0.025, o.height - 0.12, 0.012]} />
              </mesh>
            )),
          )}
          {tilt && (
            <mesh position={[o.offset, 1.0, -inward * 0.035]} material={chrome}>
              <boxGeometry args={[0.18, 0.025, 0.025]} />
            </mesh>
          )}
        </Lift>
      </group>
    );
  }

  if (o.kind === 'porte') {
    // Simple ou double vantail (porte de garage battante : toujours deux vantaux)
    const n = isGarage(o) ? 2 : Math.min(2, leaves);
    const leafW = (o.width - 0.02) / n - (n > 1 ? 0.005 : 0);
    const leafH = o.height - 0.02;
    const glazed = tags.includes('vitré');
    const moulded = tags.includes('moulures');
    // Sens d'ouverture lu sur le plan (ou réglé) : côté du débattement et charnière ; sinon vers la pièce, charnière côté a
    const towards = o.swing ? (o.swing.side === 'gauche' ? 1 : -1) : inward;
    const angle = -towards * Math.PI * (n > 1 ? 0.46 : 0.48);
    const atB = n === 1 && o.swing?.hinge === 'b';
    // Vantail dessiné de x0 à x0 + leafW (x0 < 0 pour le vantail de droite, qui pivote sur l'autre bord)
    const leaf = (x0: number, handleX: number) => (
      <>
        <LeafMesh w={leafW} h={leafH} x0={x0} material={glazed ? [frame, frame, frame, frame, glassMaterial, glassMaterial] : frame} events={events} />
        {glazed &&
          [0.25, 0.5, 0.75].map((k) => (
            <mesh key={k} position={[x0 + leafW / 2, leafH * k, 0]} material={frame} {...events}>
              <boxGeometry args={[leafW, 0.03, 0.045]} />
            </mesh>
          ))}
        {moulded &&
          !glazed &&
          [0.3, 0.73].map((k) => (
            <mesh key={k} position={[x0 + leafW / 2, leafH * k, 0]} material={frame} castShadow {...events}>
              <boxGeometry args={[Math.max(0.1, leafW - 0.22), leafH * (k < 0.5 ? 0.42 : 0.34), 0.052]} />
            </mesh>
          ))}
        {handleX >= 0 &&
          [1, -1].map((side) => (
            <mesh key={side} position={[x0 + handleX, 1.02, side * 0.045]} material={chrome}>
              <boxGeometry args={[0.13, 0.02, 0.02]} />
            </mesh>
          ))}
      </>
    );
    return (
      <group>
        {casings}
        {atB ? (
          <Swing target={open ? -angle : 0} position={[s + o.width - 0.01, 0, 0]}>
            {leaf(-leafW, 0.08)}
          </Swing>
        ) : (
          <Swing target={open ? angle : 0} position={[s + 0.01, 0, 0]}>
            {leaf(0, n > 1 ? -1 : leafW - 0.08)}
          </Swing>
        )}
        {n > 1 && (
          <Swing target={open ? -angle : 0} position={[s + o.width - 0.01, 0, 0]}>
            {leaf(-leafW, 0.08)}
          </Swing>
        )}
      </group>
    );
  }

  const yMid = o.sill + o.height / 2;
  const sashW = o.width - 2 * f;
  const sashH = o.height - 2 * f;
  const fixed = tags.includes('fixe');
  const sliding = tags.includes('coulissant');
  const nSash = fixed ? 1 : sliding ? Math.max(2, leaves) : leaves;
  const w1 = sashW / nSash;
  // Un ouvrant : vitrage + cadre, de x0 à x0 + w1 (repère du dormant)
  const sash = (x0: number, z: number, handle: number | null) => (
    <group position-z={z}>
      <mesh position={[x0 + w1 / 2, yMid, 0]} material={glassMaterial} {...events}>
        <boxGeometry args={[w1 - 0.06, sashH - 0.06, 0.012]} />
      </mesh>
      {!fixed &&
        [
          [x0 + w1 / 2, o.sill + f + 0.025, w1, 0.05],
          [x0 + w1 / 2, o.sill + o.height - f - 0.025, w1, 0.05],
          [x0 + 0.025, yMid, 0.05, sashH],
          [x0 + w1 - 0.025, yMid, 0.05, sashH],
        ].map(([x, y, w, h], i) => (
          <mesh key={i} position={[x, y, 0]} material={frame} castShadow {...events}>
            <boxGeometry args={[w, h, 0.06]} />
          </mesh>
        ))}
      {handle !== null && (
        <mesh position={[x0 + handle, yMid, inward * 0.04]} material={chrome}>
          <boxGeometry args={[0.02, 0.12, 0.02]} />
        </mesh>
      )}
    </group>
  );
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
      {/* Montants entre les ouvrants d'un châssis fixe à plusieurs vitrages */}
      {fixed &&
        Array.from({ length: leaves - 1 }, (_, i) => (
          <mesh key={i} position={[s + f + (sashW * (i + 1)) / leaves, yMid, 0]} material={frame} {...events}>
            <boxGeometry args={[0.06, sashH, 0.08]} />
          </mesh>
        ))}
      {/* Tablette intérieure et seuil extérieur */}
      <mesh position={[o.offset, o.sill - 0.015, inward * (th / 2 + 0.03)]} material={plain('#ece9e2', 0.5)} receiveShadow>
        <boxGeometry args={[o.width + 0.1, 0.03, 0.1]} />
      </mesh>
      <mesh position={[o.offset, o.sill - 0.03, -inward * (th / 2 + 0.02)]} material={plain('#8d8a84', 0.8)} receiveShadow>
        <boxGeometry args={[o.width + 0.08, 0.05, 0.08]} />
      </mesh>
      {fixed ? (
        <group position={[s + f, 0, 0]}>{sash(0, 0, null)}</group>
      ) : sliding ? (
        // Coulissant : deux vantaux sur deux rails ; ouvert, le premier glisse derrière le second
        <group position={[s + f, 0, 0]}>
          <Slide target={open ? w1 * 0.92 : 0}>{sash(0, inward * 0.025, w1 - 0.05)}</Slide>
          {Array.from({ length: nSash - 1 }, (_, i) => (
            <group key={i}>{sash(w1 * (i + 1), -inward * 0.025, i === nSash - 2 ? 0.05 : null)}</group>
          ))}
        </group>
      ) : (
        // À la française : ouvrants qui pivotent vers l'intérieur, par paires depuis chaque bord
        Array.from({ length: nSash }, (_, i) => {
          const left = nSash === 1 || i < nSash / 2 || (nSash === 3 && i === 1 && false);
          const hingeX = left ? s + f + w1 * i : s + f + w1 * (i + 1);
          return (
            <Swing key={i} target={open ? inward * (left ? -1.2 : 1.2) : 0} position={[hingeX, 0, inward * 0.02]}>
              {sash(left ? 0 : -w1, 0, left ? (i === Math.ceil(nSash / 2) - 1 || nSash === 1 ? w1 - 0.05 : null) : i === Math.ceil(nSash / 2) ? 0.05 : null)}
            </Swing>
          );
        })
      )}
    </group>
  );
}

/** Vantail coulissant : glisse en douceur le long du rail. */
function Slide({ target, children }: { target: number; children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.x += (target - g.position.x) * Math.min(1, dt * 2.4);
  });
  return (
    <group ref={ref} position-x={target}>
      {children}
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

const BASEBOARD = new THREE.MeshStandardMaterial({ color: '#f6f5f1', roughness: 0.45 });

const rboxCache = new Map<string, THREE.BufferGeometry>();
/** Volume aux arêtes arrondies (coussins, plateaux, façades) : bien plus naturel qu'un cube. */
function RBox({ size, pos, radius = 0.03, material, rot }: { size: [number, number, number]; pos: [number, number, number]; radius?: number; material: THREE.Material; rot?: [number, number, number] }) {
  const r = Math.min(radius, size[0] / 2 - 0.001, size[1] / 2 - 0.001, size[2] / 2 - 0.001);
  const key = `${size.map((v) => v.toFixed(3)).join('x')}:${r.toFixed(3)}`;
  let geo = rboxCache.get(key);
  if (!geo) {
    geo = new RoundedBoxGeometry(size[0], size[1], size[2], 3, Math.max(0.001, r));
    rboxCache.set(key, geo);
  }
  return <mesh geometry={geo} position={pos} rotation={rot} material={material} castShadow receiveShadow />;
}

const fabric = (color: string, selected: boolean) => surfaceMaterial({ color, pattern: { kind: 'carpet', photo: 'fabric' }, roughness: 0.95 }, selected);
const woodMat = (color: string, selected: boolean, w = 0.25) => surfaceMaterial({ color, pattern: { kind: 'planks', w, h: 2 }, roughness: 0.55 }, selected);
const metal = (color: string, selected: boolean) => plain(color, 0.35, selected, 0.6);

function Legs({ w, d, h, inset = 0.06, r = 0.02, material, tapered }: { w: number; d: number; h: number; inset?: number; r?: number; material: THREE.Material; tapered?: boolean }) {
  return (
    <>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <mesh key={i} position={[sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset)]} material={material} castShadow>
          <cylinderGeometry args={[r, tapered ? r * 0.6 : r, h, 10]} />
        </mesh>
      ))}
    </>
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
      case 'canape': {
        const f = fabric(c, selected);
        const f2 = fabric(shade(c, 0.92), selected);
        const n = Math.max(1, Math.round((w - 0.36) / 0.7));
        const cw = (w - 0.36) / n;
        const legs = metal('#2b2b2b', selected);
        parts = (
          <>
            {/* Socle, accoudoirs et dossier */}
            <RBox size={[w, 0.24, d]} pos={[0, 0.2, 0]} radius={0.04} material={f2} />
            <RBox size={[0.18, 0.36, d]} pos={[-w / 2 + 0.09, 0.4, 0]} radius={0.07} material={f} />
            <RBox size={[0.18, 0.36, d]} pos={[w / 2 - 0.09, 0.4, 0]} radius={0.07} material={f} />
            <RBox size={[w - 0.04, 0.45, 0.18]} pos={[0, 0.5, -d / 2 + 0.09]} radius={0.06} material={f} />
            {/* Coussins d'assise et de dossier */}
            {Array.from({ length: n }, (_, i) => {
              const x = -w / 2 + 0.18 + cw * (i + 0.5);
              return (
                <group key={i}>
                  <RBox size={[cw - 0.015, 0.14, d - 0.24]} pos={[x, 0.39, 0.06]} radius={0.05} material={f} />
                  <RBox size={[cw - 0.03, 0.4, 0.16]} pos={[x, 0.63, -d / 2 + 0.24]} radius={0.07} material={f} rot={[-0.12, 0, 0]} />
                </group>
              );
            })}
            <Legs w={w - 0.1} d={d - 0.1} h={0.08} r={0.018} material={legs} />
          </>
        );
        break;
      }
      case 'table':
      case 'bureau': {
        const round = p.tags.includes('ronde');
        const top = p.tags.includes('bois') ? woodMat(c, selected, 0.3) : plain(c, 0.35, selected);
        const legMat = p.tags.includes('bois') ? woodMat(dark, selected, 0.1) : metal(dark, selected);
        parts = round ? (
          <>
            <mesh position={[0, h - 0.02, 0]} material={top} castShadow receiveShadow>
              <cylinderGeometry args={[w / 2, w / 2 - 0.01, 0.035, 48]} />
            </mesh>
            <mesh position={[0, (h - 0.04) / 2 + 0.02, 0]} material={legMat} castShadow>
              <cylinderGeometry args={[0.04, 0.05, h - 0.06, 16]} />
            </mesh>
            <mesh position={[0, 0.015, 0]} material={legMat} castShadow receiveShadow>
              <cylinderGeometry args={[w * 0.22, w * 0.24, 0.03, 32]} />
            </mesh>
          </>
        ) : (
          <>
            <RBox size={[w, 0.035, d]} pos={[0, h - 0.0175, 0]} radius={0.012} material={top} />
            <Legs w={w} d={d} h={h - 0.035} inset={0.07} r={0.022} material={legMat} tapered />
            {p.subcategory === 'bureau' && <RBox size={[0.4, 0.14, d - 0.1]} pos={[w / 2 - 0.25, h - 0.11, 0]} radius={0.01} material={plain(shade(c, 0.97), 0.4, selected)} />}
          </>
        );
        break;
      }
      case 'chaise': {
        const m = p.tags.includes('métal') ? metal(c, selected) : woodMat(c, selected, 0.12);
        parts = (
          <>
            <RBox size={[w, 0.035, d]} pos={[0, 0.45, 0]} radius={0.012} material={m} />
            <RBox size={[w - 0.04, 0.22, 0.025]} pos={[0, 0.72, -d / 2 + 0.03]} radius={0.01} material={m} rot={[-0.08, 0, 0]} />
            <Legs w={w} d={d} h={0.435} inset={0.035} r={0.016} material={m} tapered />
            {[-1, 1].map((sx) => (
              <mesh key={sx} position={[sx * (w / 2 - 0.035), 0.66, -d / 2 + 0.035]} material={m} castShadow>
                <cylinderGeometry args={[0.014, 0.016, 0.46, 8]} />
              </mesh>
            ))}
          </>
        );
        break;
      }
      case 'lit': {
        const frame = p.tags.includes('bois') ? woodMat(c, selected, 0.2) : fabric(c, selected);
        const linen = fabric('#f3f1ec', selected);
        const duvet = fabric('#d9dfe3', selected);
        parts = (
          <>
            <RBox size={[w, 0.26, d]} pos={[0, 0.17, 0]} radius={0.03} material={frame} />
            <RBox size={[w - 0.06, 0.2, d - 0.1]} pos={[0, 0.39, 0.03]} radius={0.06} material={linen} />
            <RBox size={[w - 0.02, 0.09, d * 0.62]} pos={[0, 0.5, d * 0.17]} radius={0.04} material={duvet} />
            <RBox size={[w + 0.02, h, 0.08]} pos={[0, h / 2, -d / 2 + 0.04]} radius={0.03} material={frame} />
            {[-1, 1].map((sx) => (
              <RBox key={sx} size={[w * 0.4, 0.13, 0.36]} pos={[sx * w * 0.23, 0.55, -d / 2 + 0.3]} radius={0.06} material={linen} rot={[-0.25, 0, 0]} />
            ))}
            <Legs w={w} d={d} h={0.05} r={0.02} material={metal('#2a2a2a', selected)} />
          </>
        );
        break;
      }
      case 'armoire': {
        const body = p.tags.includes('bois') || (!p.generic && c !== '#f2f2ef') ? woodMat(c, selected, 0.3) : plain(c, 0.45, selected);
        const n = Math.max(2, Math.round(w / 0.5));
        parts = (
          <>
            <RBox size={[w, h - 0.06, d]} pos={[0, (h - 0.06) / 2 + 0.06, 0]} radius={0.008} material={body} />
            <Box size={[w - 0.04, 0.06, d - 0.04]} pos={[0, 0.03, -0.01]} color={shade(c, 0.6)} selected={selected} />
            {Array.from({ length: n }, (_, i) => {
              const x = -w / 2 + (w / n) * (i + 0.5);
              return (
                <group key={i}>
                  <Box size={[0.003, h - 0.1, 0.004]} pos={[-w / 2 + (w / n) * i, h / 2 + 0.03, d / 2 + 0.001]} color={shade(c, 0.55)} />
                  <mesh position={[x + (i % 2 ? -1 : 1) * (w / n / 2 - 0.05), h * 0.55, d / 2 + 0.02]} material={chrome}>
                    <boxGeometry args={[0.012, 0.22, 0.02]} />
                  </mesh>
                </group>
              );
            })}
          </>
        );
        break;
      }
      case 'rangement': {
        const shelf = p.tags.includes('métal') || (!p.generic && c === '#262626') ? metal(c, selected) : woodMat(c, selected, 0.3);
        const open = h > 1.2;
        const books = ['#8b3a3a', '#2f4f6f', '#c9a227', '#4e6b4a', '#d8d2c4', '#6b4f7a'];
        parts = open ? (
          <>
            {[-1, 1].map((sx) => (
              <Box key={sx} size={[0.025, h, d]} pos={[sx * (w / 2 - 0.0125), h / 2, 0]} material={shelf} />
            ))}
            {Array.from({ length: 5 }, (_, i) => (
              <Box key={i} size={[w, 0.022, d]} pos={[0, 0.03 + (i * (h - 0.05)) / 4, 0]} material={shelf} />
            ))}
            {Array.from({ length: 4 }, (_, i) =>
              Array.from({ length: Math.floor((w - 0.1) / 0.045) }, (_, j) => {
                const bh = 0.2 + ((i * 7 + j * 13) % 5) * 0.02;
                return j % 9 === 8 ? null : (
                  <Box key={`${i}-${j}`} size={[0.035, bh, d * 0.75]} pos={[-w / 2 + 0.06 + j * 0.045, 0.04 + (i * (h - 0.05)) / 4 + bh / 2, 0]} color={books[(i * 3 + j) % books.length]} roughness={0.85} />
                );
              }),
            )}
          </>
        ) : (
          <>
            <RBox size={[w, h - 0.08, d]} pos={[0, (h - 0.08) / 2 + 0.08, 0]} radius={0.01} material={shelf} />
            {Array.from({ length: 3 }, (_, i) => (
              <Box key={i} size={[0.003, h - 0.14, 0.004]} pos={[-w / 2 + ((i + 1) * w) / 4, h / 2 + 0.04, d / 2 + 0.001]} color={shade(c, 0.55)} />
            ))}
            <Legs w={w} d={d} h={0.08} r={0.015} material={metal('#222222', selected)} />
          </>
        );
        break;
      }
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

function LeafMesh({ w, h, x0 = 0, material, events }: { w: number; h: number; x0?: number; material: THREE.Material | THREE.Material[]; events: Record<string, unknown> }) {
  const geo = useMemo(() => meterBox(w, h, 0.04), [w, h]);
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh position={[x0 + w / 2, h / 2 + 0.01, 0]} geometry={geo} material={material} castShadow {...events} />;
}
