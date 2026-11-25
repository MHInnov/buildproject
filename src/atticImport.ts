/**
 * Combles aménagés à l'import : on reconnaît l'étage sous toiture (pignons sur deux côtés, rien le long des
 * égouts), on relit son plan pour placer les murs bas (le trait fin parallèle à l'égout) et les fenêtres
 * de toit (rectangles en pointillé contre les murs bas), puis on ferme les pièces.
 */
import { atticRidge, fitAttic, outerBox, sideCoverage, type KneeLine, type Side } from './model/attic';
import { insertWall, newId } from './model/geometry';
import { levelBelow } from './model/levels';
import type { Building, RoofWindow } from './model/types';
import { background, luminance, otsu, type Bitmap } from './model/vectorize';
import { groundLevel } from './traceApply';

/** Image d'un plan retracé et passage de ses pixels aux mètres du projet : X = px × scale × k + dx. */
export interface Placement {
  bmp: Bitmap;
  scale: number;
  k: number;
  dx: number;
  dy: number;
}

const inkOf = (bmp: Bitmap) => {
  const lum = luminance(bmp);
  const t = otsu(lum);
  const bg = background(lum);
  const ink = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) ink[i] = lum[i] <= Math.max(t, bg - 60) ? 1 : 0;
  return ink;
};

interface Frame {
  ink: Uint8Array;
  w: number;
  h: number;
  /** mètres par pixel */
  m: number;
  /** mètres → pixels */
  px: (x: number, y: number) => [number, number];
}

function frameOf(pl: Placement): Frame {
  const m = pl.scale * pl.k;
  return { ink: inkOf(pl.bmp), w: pl.bmp.width, h: pl.bmp.height, m, px: (x, y) => [(x - pl.dx) / m, (y - pl.dy) / m] };
}

const inkAt = (f: Frame, x: number, y: number, r = 1) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let d = -r; d <= r; d++)
    for (let e = -r; e <= r; e++) {
      const X = xi + d;
      const Y = yi + e;
      if (X >= 0 && Y >= 0 && X < f.w && Y < f.h && f.ink[Y * f.w + X]) return true;
    }
  return false;
};

/** Point en mètres à une distance `d` de la façade `side` (vers l'intérieur), à la position `t` le long. */
const at = (box: Record<Side, number>, side: Side, d: number, t: number) => {
  const inward = side === 'x0' || side === 'y0' ? 1 : -1;
  return side === 'x0' || side === 'x1' ? { x: box[side] + inward * d, y: t } : { x: t, y: box[side] + inward * d };
};

/**
 * Ligne des murs bas le long d'un égout : le trait le plus suivi parallèle à la façade, entre `dMin` et
 * `dMax` de sa face extérieure, d'un pignon à l'autre. Null si rien de net.
 */
export function findKnee(f: Frame, box: Record<Side, number>, side: Side, span: [number, number], dMin: number, dMax: number): number | null {
  const step = f.m;
  const ds: number[] = [];
  for (let d = dMin - 0.1; d <= dMax + 0.1; d += step) ds.push(d);
  const ts: number[] = [];
  for (let t = span[0] + 0.6; t <= span[1] - 0.6; t += f.m * 1.5) ts.push(t);
  if (!ts.length || !ds.length) return null;
  // hit[t][d] : encre à cette distance de la façade
  const hit = ts.map((t) => ds.map((d) => {
    const p = at(box, side, d, t);
    const [x, y] = f.px(p.x, p.y);
    return inkAt(f, x, y, 0);
  }));
  // Le mur bas peut faire des redents de quelques centimètres et le scan être un peu de travers : on compte
  // une bande de ±8 cm autour de chaque position
  const band = Math.max(1, Math.round(0.08 / step));
  let best: { d: number; c: number } | null = null;
  for (let j = 0; j < ds.length; j++) {
    if (ds[j] < dMin || ds[j] > dMax) continue;
    let n = 0;
    for (const row of hit) {
      let any = false;
      for (let q = Math.max(0, j - band); q <= Math.min(ds.length - 1, j + band) && !any; q++) any = row[q];
      if (any) n++;
    }
    const c = n / hit.length;
    if (!best || c > best.c + 1e-9) best = { d: ds[j], c };
  }
  if (!best || best.c < 0.45) return null;
  // Position fine : la ligne la plus encrée dans la bande retenue
  const j0 = ds.indexOf(best.d);
  let bj = j0;
  let bn = -1;
  for (let q = Math.max(0, j0 - band); q <= Math.min(ds.length - 1, j0 + band); q++) {
    const n = hit.reduce((s, row) => s + (row[q] ? 1 : 0), 0);
    if (n > bn) {
      bn = n;
      bj = q;
    }
  }
  return ds[bj];
}

/**
 * Fenêtres de toit : rectangles en pointillé posés contre les murs bas, côté pièce. On cherche des côtés en
 * pointillé perpendiculaires à l'égout qui partent du mur bas, par paires espacées de 50 cm à 1,5 m, fermés
 * par un pointillé parallèle à la même distance.
 */
export function findRoofWindows(f: Frame, box: Record<Side, number>, side: Side, knee: number, span: [number, number]): { t0: number; t1: number; depth: number }[] {
  const res = f.m;
  const dashed = (pts: { x: number; y: number }[]) => {
    let n = 0;
    let switches = 0;
    let prev = false;
    for (const p of pts) {
      const [x, y] = f.px(p.x, p.y);
      const hit = inkAt(f, x, y, 0) || inkAt(f, x + 0.5, y + 0.5, 0);
      if (hit) n++;
      if (hit !== prev) switches++;
      prev = hit;
    }
    const c = pts.length ? n / pts.length : 0;
    return { c, switches };
  };
  const line = (d0: number, d1: number, t: number) => {
    const pts: { x: number; y: number }[] = [];
    for (let d = d0; d <= d1; d += res) pts.push(at(box, side, knee + d, t));
    return pts;
  };
  // Côtés perpendiculaires : pointillé sur 15 cm à 50 cm du mur bas, et jusqu'où il va
  const rows: { t: number; depth: number }[] = [];
  for (let t = span[0] + 0.3; t <= span[1] - 0.3; t += res) {
    const near = dashed(line(0.12, 0.5, t));
    if (near.c < 0.25 || near.c > 0.85 || near.switches < 3) continue;
    // profondeur : dernier pointillé avant 1,6 m (pas plus de 12 cm sans encre)
    let depth = 0.5;
    let gap = 0;
    for (let d = 0.5; d <= 1.6; d += res) {
      const p = at(box, side, knee + d, t);
      const [x, y] = f.px(p.x, p.y);
      if (inkAt(f, x, y, 0)) {
        depth = d;
        gap = 0;
      } else if ((gap += res) > 0.12) break;
    }
    rows.push({ t, depth });
  }
  // Regroupe les rangées voisines (un trait fait 1 à 3 pixels)
  const groups: { t: number; depth: number }[] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && r.t - g.t <= 3 * res) {
      g.t = (g.t + r.t) / 2;
      g.depth = Math.max(g.depth, r.depth);
    } else groups.push({ ...r });
  }
  const out: { t0: number; t1: number; depth: number }[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const wdt = b.t - a.t;
      if (wdt < 0.5) continue;
      if (wdt > 1.5) break;
      const depth = (a.depth + b.depth) / 2;
      // une fenêtre de toit fait 0,8 à 1,4 m dans la pente, soit 0,7 m au moins en plan
      if (Math.abs(a.depth - b.depth) > 0.2 || depth < 0.7) continue;
      // côté parallèle en pointillé à cette profondeur
      const pts: { x: number; y: number }[] = [];
      for (let t = a.t + 0.08; t <= b.t - 0.08; t += res) pts.push(at(box, side, knee + depth, t));
      const far = dashed(pts);
      if (far.c < 0.25 || far.switches < 3) continue;
      if (out.some((o) => !(b.t <= o.t0 || a.t >= o.t1))) continue;
      out.push({ t0: a.t, t1: b.t, depth });
      i = j;
      break;
    }
  }
  return out;
}

/**
 * Reconnaît des combles aménagés sur le plus haut niveau retracé et les met en forme : toit posé sur ce
 * niveau, murs bas, pièces fermées, fenêtres de toit. Renvoie la ligne du compte rendu, ou null.
 */
export function fitImportedAttic(b: Building, placed: Map<string, Placement>, sectionEave: number | null, noSection: boolean): string | null {
  const g = groundLevel(b);
  const ups = b.levels.filter((l) => placed.has(l.id) && l.elevation > g.elevation + 0.5).sort((m, n) => n.elevation - m.elevation);
  const top = ups[0];
  if (!top) return null;
  if (b.roof && b.roof.type === 'plat') return null;
  const below = levelBelow(b, top.id) ?? g;
  const box = outerBox(b.walls.filter((w) => w.levelId === below.id));
  const own = b.walls.filter((w) => w.levelId === top.id);
  if (!box || own.length < 3) return null;
  const ridge = atticRidge(sideCoverage(own, box));
  if (!ridge) return null;
  const pitch = b.roof && b.roof.type !== 'plat' && !noSection ? b.roof.pitch : 45;
  const t = Math.tan((pitch * Math.PI) / 180);
  const eave = Math.max(0, Math.min(1.2, sectionEave ?? 0.2));
  const eaves: Side[] = ridge === 'x' ? ['y0', 'y1'] : ['x0', 'x1'];
  // Pignons : d'un mur épais d'un côté à celui de l'autre (axes), le long du faîtage
  const along = (w: (typeof own)[number]) => (ridge === 'x' ? w.a.x : w.a.y);
  const across = (w: (typeof own)[number]) => (ridge === 'x' ? Math.abs(w.a.x - w.b.x) < Math.abs(w.a.y - w.b.y) : Math.abs(w.a.y - w.b.y) < Math.abs(w.a.x - w.b.x));
  const lo0 = ridge === 'x' ? box.x0 : box.y0;
  const hi0 = ridge === 'x' ? box.x1 : box.y1;
  const gables = own.filter((w) => across(w) && w.thickness >= 0.12);
  const loG = gables.filter((w) => along(w) - lo0 < 0.8).map(along);
  const hiG = gables.filter((w) => hi0 - along(w) < 0.8).map(along);
  const span: [number, number] = [loG.length ? Math.min(...loG) : lo0 + 0.15, hiG.length ? Math.max(...hiG) : hi0 - 0.15];
  // Les égouts passent au bout des pignons (l'étage peut être moins large que le rez-de-chaussée)
  const c = (w: (typeof own)[number], hi: boolean) => (ridge === 'x' ? (hi ? Math.max(w.a.y, w.b.y) : Math.min(w.a.y, w.b.y)) : hi ? Math.max(w.a.x, w.b.x) : Math.min(w.a.x, w.b.x));
  const lenOf = (w: (typeof own)[number]) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  // Chaque pignon : l'axe qui porte le plus de longueur de mur près de ce bout, et l'étendue des tronçons sur cet axe
  const extent = (near: (w: (typeof own)[number]) => boolean) => {
    const cand = gables.filter(near);
    if (!cand.length) return null;
    const byAxis = new Map<number, number>();
    for (const w of cand) byAxis.set(Math.round(along(w) * 10), (byAxis.get(Math.round(along(w) * 10)) ?? 0) + lenOf(w));
    const axis = [...byAxis.entries()].sort((m, n) => n[1] - m[1])[0][0];
    const on = cand.filter((w) => Math.abs(Math.round(along(w) * 10) - axis) <= 1);
    const main = on.sort((m, n) => lenOf(n) - lenOf(m))[0];
    return [Math.min(...on.map((w) => c(w, false))), Math.max(...on.map((w) => c(w, true))), along(main), main.thickness];
  };
  const e0 = extent((w) => along(w) - lo0 < 0.8);
  const e1 = extent((w) => hi0 - along(w) < 0.8);
  const ex = [e0, e1].filter((e): e is number[] => !!e);
  if (ex.length) {
    const k0 = ridge === 'x' ? 'y0' : 'x0';
    const k1 = ridge === 'x' ? 'y1' : 'x1';
    box[k0] = ex.reduce((s, e) => s + e[0], 0) / ex.length - 0.15;
    box[k1] = ex.reduce((s, e) => s + e[1], 0) / ex.length + 0.15;
  }
  // Murs bas : entre 0,8 et 1,6 m de haut d'ordinaire
  const dMin = Math.max(0.3, (0.7 - eave) / t);
  const dMax = Math.max(dMin + 0.3, (1.7 - eave) / t, 1.7);
  const pl = placed.get(top.id)!;
  const f = frameOf(pl);
  const knees: KneeLine[] = [];
  const ds: number[] = [];
  for (const side of eaves) {
    const d = findKnee(f, box, side, span, dMin, dMax) ?? Math.max(dMin, (1.2 - eave) / t);
    ds.push(d);
    const inward = side === 'x0' || side === 'y0' ? 1 : -1;
    knees.push({ side, at: Math.round((box[side] + inward * d) * 100) / 100 });
  }
  const kneeHeight = Math.round(Math.max(0.4, Math.min(1.8, eave + (ds.reduce((s, x) => s + x, 0) / ds.length) * t)) * 100) / 100;
  // Fenêtres de toit, contre les murs bas
  const windows: RoofWindow[] = [];
  for (const k of knees) {
    const d = Math.abs(k.at - box[k.side]);
    for (const v of findRoofWindows(f, box, k.side, d, span)) {
      const c = at(box, k.side, d + v.depth / 2, (v.t0 + v.t1) / 2);
      const width = Math.round((v.t1 - v.t0) * 100) / 100;
      windows.push({ id: newId('rw'), x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, width, length: Math.round(v.depth * 100) / 100, productId: 'ex-fenetre-toit' });
    }
  }
  top.height = Math.max(top.height, 2.3);
  // Pignons prolongés d'un égout à l'autre : sans quoi un bout du triangle sous le toit resterait ouvert
  const k0 = ridge === 'x' ? 'y0' : 'x0';
  const k1 = ridge === 'x' ? 'y1' : 'x1';
  const pt = (a: number, c: number) => (ridge === 'x' ? { x: a, y: c } : { x: c, y: a });
  for (const e of [e0, e1]) {
    if (!e) continue;
    const [s0, s1, ax, th] = e;
    const add = (c0: number, c1: number) => {
      if (c1 - c0 < 0.05) return;
      insertWall(b, { id: newId('w'), levelId: top.id, a: pt(ax, c0), b: pt(ax, c1), thickness: th, height: top.height, kind: th >= 0.2 ? 'porteur' : 'cloison', finish: { gauche: null, droite: null } });
    };
    add(box[k0] + th / 2, s0);
    add(s1, box[k1] - th / 2);
  }
  fitAttic(b, top.id, knees, kneeHeight, { lo: span[0], hi: span[1] });
  if (b.roof) {
    b.roof.levelId = top.id;
    b.roof.type = b.roof.type === 'monopente' ? 'monopente' : 'deux-pans';
    b.roof.pitch = pitch;
    b.roof.ridge = ridge;
  } else b.roof = { type: 'deux-pans', levelId: top.id, pitch, overhang: 0.3, ridge, coveringId: null, insulationId: null };
  b.roof.eave = Math.round(eave * 100) / 100;
  b.roof.windows = windows;
  const g0 = e0 ? e0[2] - e0[3] / 2 : span[0] - 0.15;
  const g1 = e1 ? e1[2] + e1[3] / 2 : span[1] + 0.15;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  b.roof.bounds = ridge === 'x' ? { x0: r2(g0), x1: r2(g1), y0: r2(box.y0), y1: r2(box.y1) } : { x0: r2(box.x0), x1: r2(box.x1), y0: r2(g0), y1: r2(g1) };
  if (/^\d+(er|e) étage$/.test(top.name)) top.name = 'Étage sous combles';
  const dm = (x: number) => x.toFixed(2).replace('.', ',');
  return `${top.name} : combles aménagés (pignons sur deux côtés), murs bas de ${dm(kneeHeight)} m à ${ds.map(dm).join(' et ')} m des façades, pièces fermées, ${windows.length} fenêtre${windows.length > 1 ? 's' : ''} de toit${noSection ? ', pente de 45° supposée (pas de coupe)' : ''}.`;
}
