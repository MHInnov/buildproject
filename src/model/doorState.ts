import { pointInPolygon, wallNormal } from './geometry';
import { levelOutline } from './footprint';
import type { Building, Opening } from './types';

const cache = new WeakMap<Building, Set<string>>();

/** Portes percées dans une façade (un côté dans la maison, l'autre dehors), calculées une fois par état. */
function facadeDoors(b: Building): Set<string> {
  const hit = cache.get(b);
  if (hit) return hit;
  const out = new Set<string>();
  const outlines = new Map<string, ReturnType<typeof levelOutline>>();
  for (const o of b.openings) {
    if (o.kind !== 'porte') continue;
    const w = b.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    let outline = outlines.get(w.levelId);
    if (!outline) {
      outline = levelOutline(b.walls.filter((x) => x.levelId === w.levelId));
      outlines.set(w.levelId, outline);
    }
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const t = o.offset / L;
    const p = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
    const n = wallNormal(w);
    const d = w.thickness / 2 + 0.15;
    const inside = (q: { x: number; y: number }) => outline!.some((poly) => pointInPolygon(q, poly));
    if (inside({ x: p.x + n.x * d, y: p.y + n.y * d }) !== inside({ x: p.x - n.x * d, y: p.y - n.y * d })) out.add(o.id);
  }
  cache.set(b, out);
  return out;
}

/**
 * Une porte est-elle ouverte, compte tenu du choix de l'utilisateur ? Les portes intérieures sont ouvertes
 * par défaut (on circule) ; les portes de garage et d'entrée fermées (on les voit de dehors).
 */
export function isDoorOpen(b: Building, o: Opening | undefined, toggled: boolean): boolean {
  if (!o) return toggled;
  const startsOpen = o.kind === 'porte' && !o.productId?.includes('garage') && !facadeDoors(b).has(o.id);
  return startsOpen ? !toggled : toggled;
}
