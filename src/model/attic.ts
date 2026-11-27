/**
 * Combles aménagés (étage sous toiture) : les longs pans du toit descendent jusqu'aux façades, les pièces
 * sont fermées côté extérieur par des murs bas (« genoux », jambettes) en retrait des façades, et la
 * pente forme le plafond (murs et plafonds mansardés).
 */
import { dist, insertWall, newId, projectOnSegment } from './geometry';
import type { Building, Opening, Point, Wall } from './types';

export type Side = 'x0' | 'x1' | 'y0' | 'y1';

/**
 * Emprise extérieure (faces extérieures des murs), en mètres. Seuls les longs murs comptent : une
 * souche de cheminée ou un auvent qui dépasse ne déplace pas la façade.
 */
export function outerBox(all: Wall[]): { x0: number; y0: number; x1: number; y1: number } | null {
  const long = all.filter((w) => dist(w.a, w.b) >= 2);
  const walls = long.length >= 4 ? long : all;
  if (!walls.length) return null;
  return {
    x0: Math.min(...walls.map((w) => Math.min(w.a.x, w.b.x) - w.thickness / 2)),
    x1: Math.max(...walls.map((w) => Math.max(w.a.x, w.b.x) + w.thickness / 2)),
    y0: Math.min(...walls.map((w) => Math.min(w.a.y, w.b.y) - w.thickness / 2)),
    y1: Math.max(...walls.map((w) => Math.max(w.a.y, w.b.y) + w.thickness / 2)),
  };
}

const isH = (w: { a: Point; b: Point }) => Math.abs(w.a.y - w.b.y) < Math.abs(w.a.x - w.b.x);

/**
 * Part de chaque côté de l'emprise du dessous que les murs de l'étage recouvrent (axes à moins de 60 cm de
 * la façade). Des combles ont leurs pignons sur deux côtés opposés, rien sur les deux autres (les égouts).
 */
export function sideCoverage(levelWalls: Wall[], box: { x0: number; y0: number; x1: number; y1: number }): Record<Side, number> {
  const cov = (side: Side) => {
    const vertical = side === 'x0' || side === 'x1';
    const line = box[side];
    const inward = side === 'x0' || side === 'y0' ? 1 : -1;
    const [s0, s1] = vertical ? [box.y0, box.y1] : [box.x0, box.x1];
    const iv: [number, number][] = [];
    for (const w of levelWalls) {
      if (isH(w) === vertical || w.thickness < 0.12) continue;
      const axis = vertical ? w.a.x : w.a.y;
      const d = (axis - line) * inward;
      if (d < -0.3 || d > 0.6) continue;
      const a = vertical ? Math.min(w.a.y, w.b.y) : Math.min(w.a.x, w.b.x);
      const b = vertical ? Math.max(w.a.y, w.b.y) : Math.max(w.a.x, w.b.x);
      iv.push([Math.max(a, s0), Math.min(b, s1)]);
    }
    iv.sort((m, n) => m[0] - n[0]);
    let c = 0;
    let cur = -Infinity;
    for (const [a, b] of iv) {
      if (b <= cur) continue;
      c += b - Math.max(a, cur);
      cur = b;
    }
    return c / Math.max(0.01, s1 - s0);
  };
  return { x0: cov('x0'), x1: cov('x1'), y0: cov('y0'), y1: cov('y1') };
}

/**
 * Faîtage d'après les murs de l'étage : pignons sur deux côtés opposés, égouts libres sur les deux autres.
 * Renvoie l'orientation du faîtage (parallèle aux égouts), ou null si l'étage a des façades partout.
 */
export function atticRidge(cov: Record<Side, number>): 'x' | 'y' | null {
  const gx = Math.min(cov.x0, cov.x1);
  const gy = Math.min(cov.y0, cov.y1);
  const ex = Math.max(cov.x0, cov.x1);
  const ey = Math.max(cov.y0, cov.y1);
  // Pignons à gauche et à droite (côtés x), égouts en haut et en bas : faîtage selon x
  if (gx >= 0.45 && ey < 0.35) return 'x';
  if (gy >= 0.45 && ex < 0.35) return 'y';
  return null;
}

export interface KneeLine {
  side: Side;
  /** Position de la ligne des murs bas (abscisse ou ordonnée de leur axe). */
  at: number;
}

/**
 * Ferme les pièces des combles côté égouts : un mur bas le long de chaque égout, à la position donnée,
 * d'un pignon à l'autre. Les cloisons qui s'arrêtent un peu avant sont prolongées jusqu'à lui, celles qui
 * le dépassent (dans la soupente) sont coupées, et ce qui reste dans la soupente est retiré.
 * Les fenêtres en dehors des pignons (traits de vitrage mal lus, châssis de toit dessinés) sont retirées.
 */
export function fitAttic(b: Building, levelId: string, knees: KneeLine[], kneeHeight: number, gable: { lo: number; hi: number }): void {
  const level = b.levels.find((l) => l.id === levelId);
  if (!level) return;
  const own = b.walls.filter((w) => w.levelId === levelId);
  const ids = new Set(own.map((w) => w.id));
  // Ouvertures en coordonnées absolues, pour les rattacher ensuite aux murs redécoupés
  const ops = b.openings
    .filter((o) => ids.has(o.wallId))
    .map((o) => {
      const w = own.find((x) => x.id === o.wallId)!;
      const L = dist(w.a, w.b) || 1;
      return { o, at: { x: w.a.x + ((w.b.x - w.a.x) * o.offset) / L, y: w.a.y + ((w.b.y - w.a.y) * o.offset) / L } };
    });
  b.walls = b.walls.filter((w) => !ids.has(w.id));
  b.openings = b.openings.filter((o) => !ids.has(o.wallId));

  const across = (k: KneeLine) => k.side === 'y0' || k.side === 'y1'; // mur bas horizontal
  // côté soupente : vers la façade
  const outside = (k: KneeLine, p: Point) => {
    const v = across(k) ? p.y : p.x;
    return k.side === 'x0' || k.side === 'y0' ? v < k.at - 0.02 : v > k.at + 0.02;
  };
  // Pignon : mur épais en travers des murs bas, sur l'une des deux lignes de pignon (pas une cloison épaisse)
  const alongRidge = (p: Point) => (knees.some((k) => across(k)) ? p.x : p.y);
  const isGable = (w: Wall) =>
    w.thickness >= 0.15 && knees.some((k) => isH(w) !== across(k)) && Math.min(Math.abs(alongRidge(w.a) - gable.lo), Math.abs(alongRidge(w.a) - gable.hi)) < 0.6;
  const kept: Wall[] = [];
  for (const w0 of own) {
    const w: Wall = { ...w0, a: { ...w0.a }, b: { ...w0.b } };
    const gableWall = isGable(w);
    let drop = false;
    for (const k of knees) {
      const parallel = isH(w) === across(k);
      if (parallel) {
        // dans la soupente : retiré (sauf un mur épais, qui serait une façade de lucarne)
        if (outside(k, w.a) && outside(k, w.b) && w.thickness < 0.15) drop = true;
        continue;
      }
      if (gableWall) continue;
      // perpendiculaire : coupé à la ligne des murs bas, ou prolongé jusqu'à elle
      const set = (p: Point) => (across(k) ? (p.y = k.at) : (p.x = k.at));
      const coord = (p: Point) => (across(k) ? p.y : p.x);
      const oa = outside(k, w.a);
      const ob = outside(k, w.b);
      if (oa && ob) {
        drop = true;
        continue;
      }
      if (oa) set(w.a);
      else if (ob) set(w.b);
      else {
        // bout libre à moins de 1,2 m de la ligne : prolongé
        const da = Math.abs(coord(w.a) - k.at);
        const db = Math.abs(coord(w.b) - k.at);
        const near = da < db ? w.a : w.b;
        if (Math.min(da, db) < 1.2 && Math.min(da, db) > 0.02) set(near);
      }
    }
    if (!drop && dist(w.a, w.b) > 0.05) kept.push(w);
  }
  // Murs bas, d'un pignon à l'autre
  for (const k of knees) {
    const a = across(k) ? { x: gable.lo, y: k.at } : { x: k.at, y: gable.lo };
    const c = across(k) ? { x: gable.hi, y: k.at } : { x: k.at, y: gable.hi };
    kept.push({ id: newId('w'), levelId, a, b: c, thickness: 0.1, height: kneeHeight, kind: 'cloison', finish: { gauche: null, droite: null } });
  }
  for (const w of kept) insertWall(b, { ...w, id: w.id.startsWith('w') ? newId('w') : w.id });
  const mine = () => b.walls.filter((w) => w.levelId === levelId);
  for (const { o, at } of ops) {
    const host = mine().find((w) => {
      const pr = projectOnSegment(at, w.a, w.b);
      return pr.d < 0.05 && pr.t > 0 && pr.t < 1;
    });
    if (!host) continue;
    // Pas de fenêtre ailleurs que dans un pignon : sous les rampants, la lumière vient des fenêtres de toit
    if (o.kind === 'fenetre' && !isGable(host)) continue;
    if (knees.some((k) => outside(k, at))) continue;
    const op: Opening = { ...o, id: o.id, wallId: host.id, offset: Math.round(dist(host.a, at) * 100) / 100 };
    if (op.offset - op.width / 2 < -0.05 || op.offset + op.width / 2 > dist(host.a, host.b) + 0.05) continue;
    b.openings.push(op);
  }
  for (const w of mine()) if (w.thickness >= 0.15 || w.height > kneeHeight) w.height = level.height;
}
