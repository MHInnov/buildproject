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
  /** Pointillé net : au moins 3 tirets courts, des vides réguliers, et rien de part et d'autre (pas du texte). */
  const strict = (pts: { x: number; y: number }[], nx: number, ny: number) => {
    const runs: [boolean, number][] = [];
    let side = 0;
    let n = 0;
    for (const p of pts) {
      const [x, y] = f.px(p.x, p.y);
      const hit = inkAt(f, x, y, 0) || inkAt(f, x + nx * 0.6, y + ny * 0.6, 0);
      if (hit) n++;
      if (inkAt(f, x + nx * 3, y + ny * 3, 0) || inkAt(f, x - nx * 3, y - ny * 3, 0)) side++;
      if (runs.length && runs[runs.length - 1][0] === hit) runs[runs.length - 1][1]++;
      else runs.push([hit, 1]);
    }
    const c = pts.length ? n / pts.length : 0;
    if (c < 0.3 || c > 0.85 || side > 0.35 * pts.length) return 0;
    const inner = runs.slice(1, -1);
    const dashes = inner.filter((r) => r[0]);
    const gaps = inner.filter((r) => !r[0]);
    if (dashes.length < 3) return 0;
    if (dashes.some((r) => r[1] * res > 0.25) || gaps.some((r) => r[1] * res > 0.14)) return 0;
    return c;
  };
  const line = (d0: number, d1: number, t: number) => {
    const pts: { x: number; y: number }[] = [];
    for (let d = d0; d <= d1; d += res) pts.push(at(box, side, knee + d, t));
    return pts;
  };
  // Côtés perpendiculaires : pointillé sur 40 cm à partir du mur bas. Un côté peut aussi se confondre avec
  // un retour plein du mur bas (le mur bas se décroche au droit de la fenêtre) : on garde les traits pleins,
  // mais il faut au moins un côté en pointillé.
  const rows: { t: number; dashed: boolean }[] = [];
  // Normale (en pixels) à un trait perpendiculaire à l'égout, et à un trait parallèle
  const nA: [number, number] = side === 'x0' || side === 'x1' ? [0, 1] : [1, 0];
  const nP: [number, number] = [nA[1], nA[0]];
  for (let t = span[0] + 0.3; t <= span[1] - 0.3; t += res) {
    const near = dashed(line(0.12, 0.5, t));
    const isDashed = strict(line(0.12, 0.5, t), nA[0], nA[1]) > 0;
    if (isDashed || near.c > 0.9) rows.push({ t, dashed: isDashed });
  }
  // Regroupe les rangées voisines (un trait fait 1 à 3 pixels)
  const groups: { t: number; n: number; dashed: boolean }[] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && r.t - g.t <= 3 * res && g.dashed === r.dashed) {
      g.t = (g.t * g.n + r.t) / (g.n + 1);
      g.n++;
    } else groups.push({ t: r.t, n: 1, dashed: r.dashed });
  }
  const out: { t0: number; t1: number; depth: number; q: number }[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const wdt = b.t - a.t;
      if (wdt < 0.5) continue;
      if (wdt > 1.4) break;
      // Côté parallèle en pointillé, 0,55 à 1,4 m du mur bas (une fenêtre de toit fait 0,8 à 1,4 m dans la
      // pente) : la profondeur où ce pointillé est le plus net
      let best: { d: number; c: number } | null = null;
      for (let d = 0.45; d <= 1.3; d += res) {
        const pts: { x: number; y: number }[] = [];
        for (let t = a.t + 0.08; t <= b.t - 0.08; t += res) pts.push(at(box, side, knee + d, t));
        const c = strict(pts, nP[0], nP[1]);
        // (un tracé à peine pointillé est plutôt un contour d'appareil sanitaire ou un axe)
        if (c < 0.42) continue;
        // … qui s'arrête aux angles du cadre (pas une longue ligne de hauteur sous rampant)
        const out1: { x: number; y: number }[] = [];
        const out0: { x: number; y: number }[] = [];
        for (let t = b.t + 0.08; t <= b.t + 0.35; t += res) out1.push(at(box, side, knee + d, t));
        for (let t = a.t - 0.35; t <= a.t - 0.08; t += res) out0.push(at(box, side, knee + d, t));
        if (dashed(out1).c > 0.25 || dashed(out0).c > 0.25) continue;
        if (!best || c > best.c) best = { d, c };
      }
      if (!best) continue;
      const depth = best.d;
      // Le côté en pointillé va jusqu'au côté parallèle… et s'arrête là (angle du cadre)
      // Côtés : en pointillé jusqu'au côté parallèle, ou retour plein du mur bas (décroché au droit de la fenêtre)
      // (le trait peut passer un pixel à côté de la rangée moyenne du groupe)
      const wide = (d0: number, d1: number, t: number) => {
        let n = 0;
        let switches = 0;
        let prev = false;
        let all = 0;
        for (let d = d0; d <= d1; d += res) {
          const hit = [-res, 0, res].some((o) => {
            const p = at(box, side, knee + d, t + o);
            const [x, y] = f.px(p.x, p.y);
            return inkAt(f, x, y, 0);
          });
          all++;
          if (hit) n++;
          if (hit !== prev) switches++;
          prev = hit;
        }
        return { c: all ? n / all : 0, switches };
      };
      const sideOk = (g: { t: number }) => {
        const r = wide(0.12, depth - 0.05, g.t);
        if (r.c >= 0.9) return { c: 0.5, dashed: false };
        // pointillé, éventuellement précédé du retour plein du mur bas
        if (r.c < 0.45 || r.switches < 3) return { c: 0, dashed: false };
        // … qui s'arrête à l'angle du cadre
        if (wide(depth + 0.08, depth + 0.3, g.t).c > 0.3) return { c: 0, dashed: false };
        return { c: r.c, dashed: true };
      };
      const sa = sideOk(a);
      const sb = sideOk(b);
      const ca = sa.c;
      const cb = sb.c;
      if (!ca || !cb || (!sa.dashed && !sb.dashed)) continue;
      const alongC = ca + cb;
      out.push({ t0: a.t, t1: b.t, depth, q: best.c + alongC });
    }
  }
  // Cadres qui se chevauchent : le plus net
  out.sort((m, n) => n.q - m.q);
  const kept: { t0: number; t1: number; depth: number }[] = [];
  for (const o of out) if (!kept.some((k) => !(o.t1 <= k.t0 || o.t0 >= k.t1))) kept.push({ t0: o.t0, t1: o.t1, depth: o.depth });
  kept.sort((m, n) => m.t0 - n.t0);
  return kept;
}

/**
 * Reconnaît des combles aménagés sur le plus haut niveau retracé et les met en forme : toit posé sur ce
 * niveau, murs bas, pièces fermées, fenêtres de toit. Renvoie la ligne du compte rendu, ou null.
 */
/** Raccourcit un mur (perpendiculaire au faîtage) à l'intervalle [lo, hi] en travers ; ses ouvertures suivent. */
function clipAcross(b: Building, w: Building['walls'][number], ridge: 'x' | 'y', lo: number, hi: number): void {
  const get = (p: { x: number; y: number }) => (ridge === 'x' ? p.y : p.x);
  const set = (p: { x: number; y: number }, v: number) => (ridge === 'x' ? (p.y = v) : (p.x = v));
  const a0 = get(w.a);
  const na = Math.max(lo, Math.min(hi, a0));
  const nb = Math.max(lo, Math.min(hi, get(w.b)));
  set(w.a, na);
  set(w.b, nb);
  const L = Math.abs(nb - na);
  const shift = Math.abs(na - a0);
  for (const o of b.openings.filter((x) => x.wallId === w.id)) o.offset = Math.round((o.offset - shift) * 100) / 100;
  b.openings = b.openings.filter((o) => o.wallId !== w.id || (o.offset - o.width / 2 > -0.05 && o.offset + o.width / 2 < L + 0.05));
}

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
  // Pignons calés sur les façades du dessous : même nu extérieur, et pas plus larges qu'elles (un pignon
  // qui dépasse dans le vide trahit un léger décalage de calage, pas la maison)
  const under = b.walls.filter((w) => w.levelId === below.id && w.thickness >= 0.15 && across(w));
  for (const end of ['lo', 'hi'] as const) {
    const side = end === 'lo' ? lo0 : hi0;
    const mine = gables.filter((w) => (end === 'lo' ? along(w) - lo0 < 0.8 : hi0 - along(w) < 0.8));
    const fac = under.filter((w) => Math.abs(along(w) + (end === 'lo' ? -w.thickness / 2 : w.thickness / 2) - side) < 0.3);
    if (!mine.length || !fac.length) continue;
    const f0 = Math.min(...fac.map((w) => c(w, false) - w.thickness / 2));
    const f1 = Math.max(...fac.map((w) => c(w, true) + w.thickness / 2));
    for (const w of mine) {
      const outer = along(w) + (end === 'lo' ? -w.thickness / 2 : w.thickness / 2);
      const d = side - outer;
      if (Math.abs(d) < 0.6) for (const p of [w.a, w.b]) ridge === 'x' ? (p.x += d) : (p.y += d);
      clipAcross(b, w, ridge, f0, f1);
    }
    b.walls = b.walls.filter((w) => w.levelId !== top.id || Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) > 0.05);
  }
  gables.splice(0, gables.length, ...gables.filter((w) => b.walls.includes(w)));
  const e0 = extent((w) => along(w) - lo0 < 0.8);
  const e1 = extent((w) => hi0 - along(w) < 0.8);
  // Les murs bas vont d'un pignon à l'autre : axes des pignons (après calage), pas un conduit qui dépasse
  if (e0) span[0] = e0[2];
  if (e1) span[1] = e1[2];
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
    const found = findRoofWindows(f, box, k.side, d, span);
    if (!found.length) continue;
    // Le cadre dessiné est le décroché du mur bas, plus large que la fenêtre ; les fenêtres d'un même pan sont
    // d'ordinaire du même modèle : largeur de série sous 85 % du plus petit cadre, longueur du moins profond
    const SIZES = [0.55, 0.66, 0.78, 0.94, 1.14, 1.34];
    const narrow = Math.min(...found.map((v) => v.t1 - v.t0)) * 0.85;
    const width = [...SIZES].reverse().find((x) => x <= narrow) ?? SIZES[0];
    const length = Math.round(Math.min(...found.map((v) => v.depth)) * 100) / 100;
    for (const v of found) {
      const c = at(box, k.side, d + length / 2 + 0.05, (v.t0 + v.t1) / 2);
      windows.push({ id: newId('rw'), x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, width, length, productId: 'ex-fenetre-toit' });
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
