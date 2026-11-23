import { useMemo } from 'react';
import * as THREE from 'three';
import type { Catalog, Product } from '../model/catalog';
import { productById } from '../model/catalog';
import { detectRooms, wallLength } from '../model/geometry';
import type { Building, FurnitureItem, Opening, Room, Wall } from '../model/types';
import type { Selection } from '../store';

export interface Pick {
  sel: NonNullable<Selection>;
}

const DEFAULT_WALL = '#f1efe9';
const DEFAULT_FLOOR = '#cfc8bb';
const HIGHLIGHT = new THREE.Color('#1f6feb');

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, opts: { roughness?: number; selected?: boolean } = {}): THREE.MeshStandardMaterial {
  const k = `${color}|${opts.roughness ?? 0.85}|${opts.selected ? 1 : 0}`;
  let m = matCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.85 });
    if (opts.selected) {
      m.emissive = HIGHLIGHT;
      m.emissiveIntensity = 0.35;
    }
    matCache.set(k, m);
  }
  return m;
}
const ceilingMat = new THREE.MeshStandardMaterial({ color: '#fbfaf7', side: THREE.BackSide, roughness: 0.95 });
const glass = new THREE.MeshPhysicalMaterial({ color: '#cfe6f5', transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0 });

interface Props {
  building: Building;
  catalog: Catalog;
  selection: Selection;
  showCeiling: boolean;
  onPick?: (sel: NonNullable<Selection>) => void;
}

export function BuildingMeshes({ building, catalog, selection, showCeiling, onPick }: Props) {
  const rooms = useMemo(() => detectRooms(building), [building]);
  const isSel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const click = (sel: NonNullable<Selection>) => (e: { stopPropagation: () => void; delta: number }) => {
    if (!onPick || e.delta > 4) return;
    e.stopPropagation();
    onPick(sel);
  };

  return (
    <group>
      {rooms.map((r) => (
        <Floor key={r.label.id} room={r} color={productById(catalog, r.label.floorProductId)?.color ?? DEFAULT_FLOOR} selected={isSel('room', r.label.id)} onClick={click({ kind: 'room', id: r.label.id })} />
      ))}
      {showCeiling && rooms.map((r) => <Ceiling key={`c-${r.label.id}`} room={r} height={Math.max(...building.walls.map((w) => w.height), 2.5)} />)}
      {building.walls.map((w) => (
        <WallMesh
          key={w.id}
          wall={w}
          openings={building.openings.filter((o) => o.wallId === w.id)}
          catalog={catalog}
          selected={isSel('wall', w.id)}
          selectedOpening={selection?.kind === 'opening' ? selection.id : null}
          onClick={click({ kind: 'wall', id: w.id })}
          onOpeningClick={(id) => click({ kind: 'opening', id })}
        />
      ))}
      {building.furniture.map((f) => {
        const p = productById(catalog, f.productId);
        return p ? <FurnitureMesh key={f.id} item={f} product={p} selected={isSel('furniture', f.id)} onClick={click({ kind: 'furniture', id: f.id })} /> : null;
      })}
    </group>
  );
}

type ClickHandler = (e: { stopPropagation: () => void; delta: number }) => void;

function shapeOf(room: Room): THREE.Shape {
  // (x, -y) puis rotation -90° autour de X : le point du plan (x, y) arrive en (x, 0, y).
  return new THREE.Shape(room.polygon.map((p) => new THREE.Vector2(p.x, -p.y)));
}

function Floor({ room, color, selected, onClick }: { room: Room; color: string; selected: boolean; onClick: ClickHandler }) {
  const geom = useMemo(() => new THREE.ShapeGeometry(shapeOf(room)), [room]);
  return (
    <mesh geometry={geom} rotation-x={-Math.PI / 2} material={mat(color, { selected, roughness: 0.7 })} userData={{ sel: { kind: 'room', id: room.label.id } }} onClick={onClick} receiveShadow />
  );
}

function Ceiling({ room, height }: { room: Room; height: number }) {
  const geom = useMemo(() => new THREE.ShapeGeometry(shapeOf(room)), [room]);
  return <mesh geometry={geom} rotation-x={-Math.PI / 2} position-y={height} material={ceilingMat} />;
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

function WallMesh({ wall, openings, catalog, selected, selectedOpening, onClick, onOpeningClick }: {
  wall: Wall;
  openings: Opening[];
  catalog: Catalog;
  selected: boolean;
  selectedOpening: string | null;
  onClick: ClickHandler;
  onOpeningClick: (id: string) => ClickHandler;
}) {
  const L = wallLength(wall);
  const angle = -Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
  const th = wall.thickness;
  const left = productById(catalog, wall.finish.gauche)?.color ?? DEFAULT_WALL;
  const right = productById(catalog, wall.finish.droite)?.color ?? DEFAULT_WALL;
  const edge = '#d9d5cc';
  // Ordre des faces d'une BoxGeometry : +x, -x, +y, -y, +z (gauche), -z (droite)
  const materials = [mat(edge, { selected }), mat(edge, { selected }), mat('#bdb7ab', { selected }), mat(edge), mat(left, { selected }), mat(right, { selected })];
  const pieces = useMemo(() => wallPieces(wall, openings), [wall, openings]);

  return (
    <group position={[wall.a.x, 0, wall.a.y]} rotation-y={angle}>
      {pieces.map((piece, i) => {
        // Les blocs en bout de mur débordent d'une demi-épaisseur pour fermer les angles.
        const p = { ...piece, x0: piece.x0 <= 0.001 ? -th / 2 : piece.x0, x1: piece.x1 >= L - 0.001 ? L + th / 2 : piece.x1 };
        return (
        <mesh
          key={i}
          position={[(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, 0]}
          material={materials}
          userData={{ sel: { kind: 'wall', id: wall.id } }}
          onClick={onClick}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[p.x1 - p.x0, p.y1 - p.y0, th]} />
        </mesh>
        );
      })}
      {openings.map((o) => (
        <OpeningMesh key={o.id} o={o} wallLength={L} th={th} catalog={catalog} selected={selectedOpening === o.id} onClick={onOpeningClick(o.id)} />
      ))}
    </group>
  );
}

function OpeningMesh({ o, th, catalog, selected, onClick }: { o: Opening; wallLength: number; th: number; catalog: Catalog; selected: boolean; onClick: ClickHandler }) {
  const p = productById(catalog, o.productId);
  const color = p?.color ?? '#ffffff';
  const frame = mat(color, { selected, roughness: 0.5 });
  const s = o.offset - o.width / 2;
  const f = 0.06; // section du cadre
  const ud = { sel: { kind: 'opening', id: o.id } };
  if (o.kind === 'porte') {
    // Vantail ouvert à 90° côté « gauche »
    return (
      <group>
        <mesh position={[s + 0.02, o.sill + o.height / 2, th / 2 + o.width / 2]} material={frame} userData={ud} onClick={onClick} castShadow>
          <boxGeometry args={[0.04, o.height, o.width - 0.02]} />
        </mesh>
        <mesh position={[o.offset, o.sill + o.height - f / 2, 0]} material={frame} userData={ud} onClick={onClick}>
          <boxGeometry args={[o.width, f, th + 0.02]} />
        </mesh>
      </group>
    );
  }
  const yMid = o.sill + o.height / 2;
  return (
    <group>
      <mesh position={[o.offset, yMid, 0]} material={glass} userData={ud} onClick={onClick}>
        <boxGeometry args={[o.width - 2 * f, o.height - 2 * f, 0.02]} />
      </mesh>
      {[
        [o.offset, o.sill + f / 2, o.width, f],
        [o.offset, o.sill + o.height - f / 2, o.width, f],
        [s + f / 2, yMid, f, o.height],
        [s + o.width - f / 2, yMid, f, o.height],
        [o.offset, yMid, f * 0.6, o.height - 2 * f],
      ].map(([x, y, w, h], i) => (
        <mesh key={i} position={[x, y, 0]} material={frame} userData={ud} onClick={onClick}>
          <boxGeometry args={[w, h, 0.08]} />
        </mesh>
      ))}
    </group>
  );
}

function Box({ size, pos, color, selected, roughness }: { size: [number, number, number]; pos: [number, number, number]; color: string; selected: boolean; roughness?: number }) {
  return (
    <mesh position={pos} material={mat(color, { selected, roughness })} castShadow receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

function shade(color: string, k: number): string {
  const c = new THREE.Color(color);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/** Meuble simplifié selon sa famille (assez pour juger volumes, couleurs et circulation). */
function FurnitureMesh({ item, product: p, selected, onClick }: { item: FurnitureItem; product: Product; selected: boolean; onClick: ClickHandler }) {
  const { w, d, h } = p.size ?? { w: 0.6, d: 0.6, h: 0.8 };
  const c = p.color;
  const dark = shade(c, 0.75);
  let parts: React.ReactNode;
  switch (p.subcategory) {
    case 'canape':
      parts = (
        <>
          <Box size={[w, 0.42, d]} pos={[0, 0.21, 0]} color={c} selected={selected} />
          <Box size={[w, 0.4, 0.2]} pos={[0, 0.6, -d / 2 + 0.1]} color={dark} selected={selected} />
          <Box size={[0.18, 0.25, d]} pos={[-w / 2 + 0.09, 0.54, 0]} color={dark} selected={selected} />
          <Box size={[0.18, 0.25, d]} pos={[w / 2 - 0.09, 0.54, 0]} color={dark} selected={selected} />
        </>
      );
      break;
    case 'table':
    case 'bureau': {
      const round = p.tags.includes('ronde');
      parts = (
        <>
          {round ? (
            <mesh position={[0, h - 0.02, 0]} material={mat(c, { selected })} castShadow>
              <cylinderGeometry args={[w / 2, w / 2, 0.04, 40]} />
            </mesh>
          ) : (
            <Box size={[w, 0.04, d]} pos={[0, h - 0.02, 0]} color={c} selected={selected} />
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
          <Box size={[w - 0.08, 0.22, d - 0.12]} pos={[0, 0.41, 0.04]} color="#f4f2ee" selected={selected} />
          <Box size={[w, h, 0.08]} pos={[0, h / 2, -d / 2 + 0.04]} color={dark} selected={selected} />
          <Box size={[w * 0.35, 0.12, 0.35]} pos={[-w * 0.22, 0.58, -d / 2 + 0.3]} color="#ffffff" selected={selected} />
          <Box size={[w * 0.35, 0.12, 0.35]} pos={[w * 0.22, 0.58, -d / 2 + 0.3]} color="#ffffff" selected={selected} />
        </>
      );
      break;
    case 'cuisine':
      parts = (
        <>
          <Box size={[w, h - 0.04, d - 0.02]} pos={[0, (h - 0.04) / 2, 0.01]} color={c} selected={selected} />
          <Box size={[w + 0.02, 0.04, d + 0.02]} pos={[0, h - 0.02, 0]} color="#5b5752" selected={selected} roughness={0.4} />
        </>
      );
      break;
    case 'salle-de-bain':
      parts = p.tags.includes('douche') ? (
        <>
          <Box size={[w, 0.04, d]} pos={[0, 0.02, 0]} color="#ffffff" selected={selected} />
          <mesh position={[w / 2 - 0.01, h / 2, 0]} material={glass}>
            <boxGeometry args={[0.01, h, d]} />
          </mesh>
        </>
      ) : (
        <>
          <Box size={[w, h - 0.05, d]} pos={[0, (h - 0.05) / 2, 0]} color={c} selected={selected} />
          <Box size={[w * 0.6, 0.05, d * 0.6]} pos={[0, h - 0.025, 0]} color="#ffffff" selected={selected} roughness={0.2} />
        </>
      );
      break;
    default:
      parts = <Box size={[w, h, d]} pos={[0, h / 2, 0]} color={c} selected={selected} />;
  }
  return (
    <group position={[item.x, 0, item.y]} rotation-y={(-item.rotation * Math.PI) / 180} userData={{ sel: { kind: 'furniture', id: item.id } }} onClick={onClick}>
      {parts}
    </group>
  );
}
