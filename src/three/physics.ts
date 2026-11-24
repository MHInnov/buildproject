import type { Catalog } from '../model/catalog';
import { productById } from '../model/catalog';
import { detectRooms, pointInPolygon, projectOnSegment, wallLength, wallSideFacingRoom } from '../model/geometry';
import { floorToFloor, levelById } from '../model/levels';
import type { Building, Point, Room } from '../model/types';

/**
 * Déplacements dans la visite : hauteur du sol sous les pieds (étages, escaliers)
 * et collisions avec les murs, les portes et les meubles (on passe par les portes ouvertes).
 */
export const BODY_RADIUS = 0.22;

export interface StairInfo {
  id: string;
  x: number;
  y: number;
  rotation: number;
  w: number;
  d: number;
  base: number;
  rise: number;
}

/** Boîte orientée au sol (meuble, vantail de porte ouvert). */
export interface Obstacle {
  x: number;
  y: number;
  /** Axes unitaires de la boîte (u : largeur, v : profondeur). */
  ux: number;
  uy: number;
  hw: number;
  hd: number;
  bottom: number;
  top: number;
  /** Vantail de porte : ne compte que lorsque la porte est ouverte. */
  doorId?: string;
}

export interface WalkWorld {
  b: Building;
  rooms: (Room & { elevation: number })[];
  stairs: StairInfo[];
  obstacles: Obstacle[];
}

/** En dessous de cette hauteur (tapis, seuils), on enjambe. */
const STEP_OVER = 0.15;

export function walkWorld(b: Building, catalog: Catalog): WalkWorld {
  const rooms = detectRooms(b).map((r) => ({ ...r, elevation: levelById(b, r.label.levelId)?.elevation ?? 0 }));
  const stairs: StairInfo[] = b.furniture.flatMap((f) => {
    const p = productById(catalog, f.productId);
    const l = levelById(b, f.levelId);
    if (p?.category !== 'escalier' || !l) return [];
    const s = p.size ?? { w: 0.8, d: 3.6, h: 2.8 };
    return [{ id: f.id, x: f.x, y: f.y, rotation: f.rotation, w: s.w, d: s.d, base: l.elevation, rise: floorToFloor(l) }];
  });
  const obstacles: Obstacle[] = [];
  for (const f of b.furniture) {
    const p = productById(catalog, f.productId);
    const l = levelById(b, f.levelId);
    if (!p?.size || !l || p.category === 'escalier' || p.size.h < STEP_OVER) continue;
    const a = (f.rotation * Math.PI) / 180;
    obstacles.push({ x: f.x, y: f.y, ux: Math.cos(a), uy: Math.sin(a), hw: p.size.w / 2, hd: p.size.d / 2, bottom: l.elevation, top: l.elevation + p.size.h });
  }
  // Vantaux de porte : une porte ouverte se rabat dans la pièce, perpendiculaire au mur.
  const facing = new Map<string, Set<string>>();
  for (const r of rooms)
    for (const id of r.wallIds) {
      const w = b.walls.find((x) => x.id === id);
      const side = w && wallSideFacingRoom(w, r);
      if (side) facing.set(id, (facing.get(id) ?? new Set()).add(side));
    }
  for (const o of b.openings) {
    if (o.kind !== 'porte') continue;
    const w = b.walls.find((x) => x.id === o.wallId);
    const l = w && levelById(b, w.levelId);
    if (!w || !l) continue;
    const L = wallLength(w);
    const dx = (w.b.x - w.a.x) / L;
    const dy = (w.b.y - w.a.y) / L;
    const f = facing.get(w.id);
    const inward = f?.has('gauche') ? 1 : f?.has('droite') ? -1 : 1;
    const nx = -dy * inward;
    const ny = dx * inward;
    const leaf = o.width - 0.02;
    const s = o.offset - o.width / 2 + 0.01;
    obstacles.push({
      x: w.a.x + dx * s + nx * (leaf / 2),
      y: w.a.y + dy * s + ny * (leaf / 2),
      ux: dx,
      uy: dy,
      hw: 0.03,
      hd: leaf / 2,
      bottom: l.elevation + o.sill,
      top: l.elevation + o.sill + o.height,
      doorId: o.id,
    });
  }
  return { b, rooms, stairs, obstacles };
}

function hitsObstacle(o: Obstacle, p: Point, y: number): boolean {
  if (y + 1.7 < o.bottom || y + STEP_OVER > o.top) return false;
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const lu = dx * o.ux + dy * o.uy;
  const lv = -dx * o.uy + dy * o.ux;
  // Distance du cercle du corps à la boîte
  const cu = Math.max(0, Math.abs(lu) - o.hw);
  const cv = Math.max(0, Math.abs(lv) - o.hd);
  return cu * cu + cv * cv < BODY_RADIUS * BODY_RADIUS;
}

/** Coordonnées locales d'un point dans le repère de l'escalier (y local : +d/2 = départ, -d/2 = arrivée). */
export function stairLocal(s: StairInfo, p: Point): { lx: number; ly: number } {
  const a = (-s.rotation * Math.PI) / 180;
  const dx = p.x - s.x;
  const dy = p.y - s.y;
  return { lx: dx * Math.cos(a) - dy * Math.sin(a), ly: dx * Math.sin(a) + dy * Math.cos(a) };
}

const inStair = (s: StairInfo, p: Point, margin = 0) => {
  const { lx, ly } = stairLocal(s, p);
  return Math.abs(lx) <= s.w / 2 + margin && Math.abs(ly) <= s.d / 2 + margin;
};

/** Hauteur du sol au point p, en partant de la hauteur actuelle (on ne saute pas d'un étage à l'autre). */
export function groundAt(world: WalkWorld, p: Point, currentY: number): number {
  const candidates: number[] = [];
  for (const s of world.stairs) {
    const { lx, ly } = stairLocal(s, p);
    if (Math.abs(lx) > s.w / 2 || Math.abs(ly) > s.d / 2) continue;
    const t = (s.d / 2 - ly) / s.d;
    const h = s.base + t * s.rise;
    if (Math.abs(h - currentY) < 0.45) candidates.push(h);
  }
  for (const r of world.rooms) {
    if (!pointInPolygon(p, r.polygon)) continue;
    // Trémie : pas de plancher au-dessus d'un escalier du niveau inférieur.
    const hole = world.stairs.some((s) => Math.abs(s.base + s.rise - r.elevation) < 0.05 && inStair(s, p, -0.05));
    if (!hole) candidates.push(r.elevation);
  }
  const lowest = Math.min(0, ...world.b.levels.map((l) => l.elevation));
  if (!candidates.length) candidates.push(currentY < 0.5 ? Math.max(lowest, 0) : currentY);
  const ok = candidates.filter((h) => h <= currentY + 0.4);
  return ok.length ? Math.max(...ok) : Math.min(...candidates);
}

/** Collision avec les murs, les portes fermées, les vantaux ouverts et les meubles. */
export function blocked(world: WalkWorld, p: Point, y: number, isOpen: (openingId: string) => boolean): boolean {
  const { b } = world;
  for (const w of b.walls) {
    const l = levelById(b, w.levelId);
    if (!l) continue;
    const bottom = l.elevation;
    if (y + 0.3 < bottom || y + 0.1 > bottom + w.height) continue;
    const pr = projectOnSegment(p, w.a, w.b);
    if (pr.d > w.thickness / 2 + BODY_RADIUS) continue;
    const along = pr.t * wallLength(w);
    const inDoor = b.openings.some(
      (o) => o.wallId === w.id && o.kind === 'porte' && isOpen(o.id) && Math.abs(along - o.offset) < o.width / 2 - BODY_RADIUS * 0.6,
    );
    if (!inDoor) return true;
  }
  return world.obstacles.some((o) => (!o.doorId || isOpen(o.doorId)) && hitsObstacle(o, p, y));
}
