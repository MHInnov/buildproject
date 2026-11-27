import { alignFacades, alignWalls } from './plans';
import { levelBelow } from './levels';
import type { Building, Point } from './types';

/**
 * Calage d'un étage sur le niveau du dessous : déplacement, quart de tour, recalage automatique.
 * Tout ce qui appartient au niveau bouge ensemble (murs, pièces, sols, meubles, plan importé, fenêtres de toit).
 */
export function shiftLevel(b: Building, levelId: string, dx: number, dy: number): void {
  const mv = (p: Point) => ({ x: Math.round((p.x + dx) * 1000) / 1000, y: Math.round((p.y + dy) * 1000) / 1000 });
  for (const w of b.walls) if (w.levelId === levelId) Object.assign(w, { a: mv(w.a), b: mv(w.b) });
  for (const r of b.rooms) if (r.levelId === levelId) r.at = mv(r.at);
  for (const f of b.furniture) if (f.levelId === levelId) Object.assign(f, mv(f));
  for (const z of b.floorZones ?? []) if (z.levelId === levelId) Object.assign(z, mv(z));
  const l = b.levels.find((x) => x.id === levelId);
  if (l?.underlay) Object.assign(l.underlay, mv(l.underlay));
  if (b.roof?.levelId === levelId) {
    for (const w of b.roof.windows ?? []) Object.assign(w, mv(w));
    const bd = b.roof.bounds;
    if (bd) b.roof.bounds = { x0: bd.x0 + dx, x1: bd.x1 + dx, y0: bd.y0 + dy, y1: bd.y1 + dy };
  }
}

/** Centre de l'emprise des murs d'un niveau. */
export function levelCenter(b: Building, levelId: string): Point | null {
  const ws = b.walls.filter((w) => w.levelId === levelId);
  if (!ws.length) return null;
  const xs = ws.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ws.flatMap((w) => [w.a.y, w.b.y]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** Quart de tour (sens horaire sur le plan) autour du centre du niveau. Le plan importé dessous est masqué. */
export function turnLevel(b: Building, levelId: string): void {
  const c = levelCenter(b, levelId);
  if (!c) return;
  const rot = (p: Point) => ({ x: Math.round((c.x - (p.y - c.y)) * 1000) / 1000, y: Math.round((c.y + (p.x - c.x)) * 1000) / 1000 });
  for (const w of b.walls) if (w.levelId === levelId) Object.assign(w, { a: rot(w.a), b: rot(w.b) });
  for (const r of b.rooms) if (r.levelId === levelId) r.at = rot(r.at);
  for (const f of b.furniture)
    if (f.levelId === levelId) {
      Object.assign(f, rot(f));
      f.rotation = (f.rotation + 90) % 360;
    }
  for (const z of b.floorZones ?? [])
    if (z.levelId === levelId) {
      const p = rot({ x: z.x, y: z.y + z.h });
      Object.assign(z, { x: p.x, y: p.y, w: z.h, h: z.w });
    }
  const l = b.levels.find((x) => x.id === levelId);
  if (l?.underlay) l.underlay.visible = false;
}

/**
 * Recalage automatique sur le niveau du dessous (façades d'abord, puis tous les murs). Renvoie le déplacement
 * appliqué et la part des murs qui se superposent, ou null s'il n'y a rien dessous.
 */
export function autoAlignLevel(b: Building, levelId: string): { dx: number; dy: number; fit: number } | null {
  const below = levelBelow(b, levelId);
  if (!below) return null;
  const ref = b.walls.filter((w) => w.levelId === below.id);
  const own = b.walls.filter((w) => w.levelId === levelId);
  if (!ref.length || !own.length) return null;
  const fa = alignFacades(own, ref);
  const al = fa.fit >= 0.3 ? fa : alignWalls(own, ref, false);
  if (!al.fit) return null;
  if (Math.abs(al.dx) > 0.005 || Math.abs(al.dy) > 0.005) shiftLevel(b, levelId, al.dx, al.dy);
  return { dx: al.dx, dy: al.dy, fit: al.fit };
}
