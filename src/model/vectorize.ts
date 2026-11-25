/**
 * Retraçage automatique d'un plan scanné ou exporté (image), sans service externe.
 *
 * Principe :
 * 0. détection automatique de l'aspect des murs (voir autoVectorize) : trait noir plein, gris ou couleur,
 *    hachures, ou murs dessinés par deux traits parallèles ; l'épaisseur et l'échelle s'en déduisent ;
 * 1. seuillage automatique (Otsu) pour isoler le trait ;
 * 2. ouverture morphologique : on efface tout ce qui est plus fin qu'un mur
 *    (textes, cotes, hachures, mobilier, traits de fenêtre) ;
 * 3. extraction des bandes horizontales et verticales épaisses : ce sont les murs ;
 * 4. les trous entre deux tronçons alignés deviennent des portes (vide) ou des fenêtres (traits fins) ;
 * 5. les extrémités sont recalées sur l'axe des murs perpendiculaires pour fermer les pièces.
 *
 * Les plans en biais ou les murs courbes ne sont pas gérés : ils se reprennent à la main.
 */
import { detectRooms, insertWall, pointInPolygon } from './geometry';
import { defaultLevel } from './levels';
import type { Building } from './types';

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, comme ImageData.data */
  data: Uint8ClampedArray;
}

export interface VectorizeOptions {
  /** Échelle en mètres par pixel. */
  scale: number;
  /** Épaisseur minimale d'un mur, en mètres (en dessous, le trait est ignoré). */
  minThickness?: number;
  /** Longueur minimale d'un mur, en mètres. */
  minLength?: number;
}

export interface TracedWall {
  a: { x: number; y: number };
  b: { x: number; y: number };
  thickness: number;
}

export interface TracedOpening {
  wall: number;
  kind: 'porte' | 'fenetre';
  /** Centre de l'ouverture le long du mur, en mètres depuis a. */
  offset: number;
  width: number;
  /** Comment elle a été trouvée : un trou dans le mur, ou des traits de vitrage dans un mur continu. */
  source?: 'trou' | 'vitrage';
}

export interface VectorizeResult {
  walls: TracedWall[];
  openings: TracedOpening[];
  /** Masque des pixels retenus comme murs (pour l'aperçu). */
  mask: Uint8Array;
  /** Extrémités de murs restées libres (m), pour la mise au point */
  free?: { x: number; y: number }[];
  threshold: number;
}

export function luminance(bmp: Bitmap): Uint8Array {
  const n = bmp.width * bmp.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = bmp.data[i * 4];
    const g = bmp.data[i * 4 + 1];
    const b = bmp.data[i * 4 + 2];
    const a = bmp.data[i * 4 + 3] / 255;
    out[i] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a));
  }
  return out;
}

/** Seuil d'Otsu : sépare au mieux le trait du fond. */
export function otsu(lum: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of lum) hist[v]++;
  const total = lum.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      t = i;
    }
  }
  return Math.min(t, 200);
}

function integral(mask: Uint8Array, w: number, h: number): Int32Array {
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

function boxSum(I: Int32Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1);
  y1 = Math.min(h - 1, y1);
  if (x1 < x0 || y1 < y0) return 0;
  const W = w + 1;
  return I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
}

/** Ouverture morphologique (érosion puis dilatation) par un carré de côté 2r+1. */
export function open(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const I = integral(mask, w, h);
  const full = (2 * r + 1) ** 2;
  const eroded = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      if (mask[y * w + x] && boxSum(I, w, h, x - r, y - r, x + r, y + r) === full) eroded[y * w + x] = 1;
    }
  }
  const J = integral(eroded, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (boxSum(J, w, h, x - r, y - r, x + r, y + r) > 0) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface Band {
  /** Axe le long du mur (x pour un mur horizontal) */
  s: number;
  e: number;
  /** Position transversale (y pour un mur horizontal) */
  t0: number;
  t1: number;
}

/** Regroupe les plages longues de lignes consécutives en bandes (murs). */
export function bands(mask: Uint8Array, w: number, h: number, horizontal: boolean, minLen: number): Band[] {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const at = (line: number, k: number) => (horizontal ? mask[line * w + k] : mask[k * w + line]);
  const done: Band[] = [];
  // (chaque bande se prolonge par une plage de la ligne suivante qui recouvre l'essentiel de la plage
  // précédente : comparer à l'étendue cumulée enchaînerait de proche en proche tout le dessin)
  let open_: (Band & { last: number; ls: number; le: number })[] = [];
  for (let line = 0; line < lines; line++) {
    const runs: [number, number][] = [];
    let k = 0;
    while (k < len) {
      if (!at(line, k)) {
        k++;
        continue;
      }
      const s = k;
      while (k < len && at(line, k)) k++;
      if (k - s >= minLen) runs.push([s, k - 1]);
    }
    const next: typeof open_ = [];
    for (const [s, e] of runs) {
      const g = open_.find((b) => b.last === line - 1 && !next.includes(b) && Math.min(e, b.le) - Math.max(s, b.ls) > 0.6 * Math.max(e - s, b.le - b.ls));
      if (g) {
        g.s = Math.min(g.s, s);
        g.e = Math.max(g.e, e);
        g.t1 = line;
        g.last = line;
        g.ls = s;
        g.le = e;
        next.push(g);
      } else next.push({ s, e, t0: line, t1: line, last: line, ls: s, le: e });
    }
    for (const b of open_) if (!next.includes(b)) done.push(b);
    open_ = next;
  }
  done.push(...open_);
  return done.map(({ s, e, t0, t1 }) => ({ s, e, t0, t1 }));
}

export function vectorize(bmp: Bitmap, opts: VectorizeOptions): VectorizeResult {
  const { width: w, height: h } = bmp;
  const scale = opts.scale;
  const minThick = Math.max(2, Math.round((opts.minThickness ?? 0.07) / scale));
  const lum = luminance(bmp);
  const threshold = otsu(lum);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) dark[i] = lum[i] <= threshold ? 1 : 0;
  return { ...traceMask(dark, dark, w, h, scale, minThick, opts.minLength), threshold };
}

/** Tronçon de mur en pixels : axe à `c` (transversal), de `s` à `e` le long du mur, épaisseur `th`. */
type PxSeg = { horizontal: boolean; s: number; e: number; c: number; th: number };

const lo = (S: PxSeg) => S.c - S.th / 2;
const hi = (S: PxSeg) => S.c + S.th / 2;

/**
 * Murs creux (brique, isolant, bloc) et murs en double trait dont l'intérieur n'a pas été rempli : deux bandes
 * parallèles séparées d'un vide étroit forment un seul mur, de la face extérieure à la face intérieure.
 */
export function mergeLayers(segs: PxSeg[], scale: number): void {
  const maxWall = 0.55 / scale;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < segs.length && !changed; i++) {
      for (let j = 0; j < segs.length && !changed; j++) {
        const A = segs[i];
        const B = segs[j];
        if (i === j || A.horizontal !== B.horizontal) continue;
        const gap = Math.max(lo(B) - hi(A), lo(A) - hi(B));
        if (gap < 0 || gap > 1.6 * Math.max(A.th, B.th) + 1 || gap > 0.2 / scale) continue;
        const ov = Math.min(A.e, B.e) - Math.max(A.s, B.s);
        if (ov < 0.6 * Math.min(A.e - A.s, B.e - B.s)) continue;
        const l0 = Math.min(lo(A), lo(B));
        const h0 = Math.max(hi(A), hi(B));
        if (h0 - l0 > maxWall) continue;
        const M: PxSeg = { horizontal: A.horizontal, s: Math.min(A.s, B.s), e: Math.max(A.e, B.e), c: (l0 + h0) / 2, th: h0 - l0 };
        segs.splice(Math.max(i, j), 1);
        segs.splice(Math.min(i, j), 1, M);
        changed = true;
      }
    }
  }
  // Bandes entièrement contenues dans un autre mur (reste d'une couche)
  for (let i = segs.length - 1; i >= 0; i--) {
    const A = segs[i];
    if (segs.some((B) => B !== A && B.horizontal === A.horizontal && B.th > A.th && lo(A) >= lo(B) - 1 && hi(A) <= hi(B) + 1 && A.s >= B.s - A.th && A.e <= B.e + A.th)) segs.splice(i, 1);
  }
}

/**
 * Traits épais isolés (pointillés de poutres, textes en gras, symboles) : un mur touche presque toujours un autre
 * mur. On retire les tronçons courts qui ne touchent rien.
 */
export function dropLoose(segs: PxSeg[], scale: number, openings: { seg: PxSeg; width: number }[] = []): void {
  const touches = (A: PxSeg, B: PxSeg) => {
    const tol = Math.max(A.th, B.th) + 2;
    if (A.horizontal === B.horizontal) return Math.abs(A.c - B.c) <= Math.max(A.th, B.th) / 2 + 1 && A.s <= B.e + tol && B.s <= A.e + tol;
    // perpendiculaires : l'un arrive sur l'autre (angle, T ou croisement)
    return A.c >= B.s - tol && A.c <= B.e + tol && B.c >= A.s - tol && B.c <= A.e + tol;
  };
  const minLen = Math.max(1.2 / scale, 0);
  for (let i = segs.length - 1; i >= 0; i--) {
    const A = segs[i];
    // longueur de mur réellement dessinée (sans les baies)
    const solid = A.e - A.s - openings.filter((o) => o.seg === A).reduce((m, o) => m + o.width, 0);
    if (solid >= minLen) continue;
    if (!segs.some((B) => B !== A && touches(A, B))) segs.splice(i, 1);
  }
}

/**
 * Prolongements : deux tronçons parallèles qui se suivent bout à bout (un mur et la suite d'une de ses couches,
 * un mur qui change d'épaisseur) sont raccordés exactement, sinon les pièces ne se ferment pas.
 */
export function joinAligned(segs: PxSeg[], openings: { seg: PxSeg; at: number }[] = []): void {
  // Groupes de tronçons qui se suivent sur (presque) le même axe
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segs.length; i++)
    for (let j = 0; j < segs.length; j++) {
      const A = segs[i];
      const B = segs[j];
      if (i === j || A.horizontal !== B.horizontal) continue;
      const big = Math.max(A.th, B.th);
      if (Math.abs(A.c - B.c) > big / 2 + 1) continue;
      if (B.e <= A.e || B.s <= A.s) continue;
      const gap = B.s - A.e;
      if (gap < -big * 2 || gap > big + 2) continue;
      parent[find(i)] = find(j);
    }
  const groups = new Map<number, PxSeg[]>();
  segs.forEach((S, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), S]));
  const drop = new Set<PxSeg>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Axe commun : celui des murs les plus épais et les plus longs
    const wsum = g.reduce((m, S) => m + (S.e - S.s) * S.th * S.th, 0);
    const c = g.reduce((m, S) => m + S.c * (S.e - S.s) * S.th * S.th, 0) / wsum;
    g.sort((m, n) => m.s - n.s);
    for (const S of g) S.c = c;
    let cur = g[0];
    for (let k = 1; k < g.length; k++) {
      const B = g[k];
      if (B.e <= cur.e) {
        // contenu dans le précédent
        if (B.th <= cur.th * 1.2) {
          for (const o of openings) if (o.seg === B) o.seg = cur;
          drop.add(B);
          continue;
        }
      }
      const big = Math.max(cur.th, B.th);
      if (Math.min(cur.th, B.th) >= 0.6 * big) {
        // même mur : un seul tronçon
        cur.e = Math.max(cur.e, B.e);
        cur.th = big;
        for (const o of openings) if (o.seg === B) o.seg = cur;
        drop.add(B);
      } else {
        // changement d'épaisseur : les deux bouts se rejoignent
        const meet = B.s >= cur.e ? (cur.e + B.s) / 2 : cur.th >= B.th ? cur.e : B.s;
        if (meet - cur.s < 2 || B.e - meet < 2) continue;
        cur.e = meet;
        B.s = meet;
        cur = B;
      }
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) if (drop.has(segs[i])) segs.splice(i, 1);
}

/** Extrémités libres : ni sur un autre mur, ni au bout d'un autre mur (le plan ne fermera pas de pièce par là). */
export function freeEnds(segs: PxSeg[]): { seg: PxSeg; end: 's' | 'e' }[] {
  const out: { seg: PxSeg; end: 's' | 'e' }[] = [];
  for (const S of segs)
    for (const end of ['s', 'e'] as const) {
      const pos = S[end];
      const ok = segs.some(
        (P) =>
          P !== S &&
          (P.horizontal === S.horizontal
            ? Math.abs(P.c - S.c) < 0.5 && (Math.abs(P.s - pos) < 0.5 || Math.abs(P.e - pos) < 0.5 || (pos > P.s && pos < P.e))
            : Math.abs(P.c - pos) < 0.5 && S.c >= P.s - 0.5 && S.c <= P.e + 0.5),
      );
      if (!ok) out.push({ seg: S, end });
    }
  return out;
}

/** Le pixel (x, y) ou un voisin immédiat est-il encré ? */
function inkNear(ink: Uint8Array, w: number, h: number, x: number, y: number, r = 1): boolean {
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const X = xi + dx;
      const Y = yi + dy;
      if (X >= 0 && Y >= 0 && X < w && Y < h && ink[Y * w + X]) return true;
    }
  return false;
}

/**
 * Arc de débattement d'une porte : un quart de cercle centré sur un tableau, de rayon la largeur de la baie
 * (ou la moitié pour une porte double), d'un côté ou de l'autre du mur. Pointillé ou continu.
 */
export function doorArc(ink: Uint8Array, w: number, h: number, horizontal: boolean, c: number, th: number, g0: number, g1: number): boolean {
  const gap = g1 - g0;
  const P = (along: number, across: number) => (horizontal ? [along, across] : [across, along]);
  const at = (along: number, across: number, r = 1) => {
    const [x, y] = P(along, across);
    return inkNear(ink, w, h, x, y, r);
  };
  // Arc fin : encré sur le cercle, blanc un peu à l'intérieur ou à l'extérieur (pas une zone noircie de traits)
  const arc = (hinge: number, dir: number, side: number, r: number) => {
    let n = 0;
    let all = 0;
    const tol = Math.max(1, Math.round(r * 0.03));
    for (let a = 20; a <= 80; a += 5) {
      const t = (a * Math.PI) / 180;
      const pt = (rr: number) => [hinge + dir * rr * Math.cos(t), c + side * (th / 2 + rr * Math.sin(t))] as const;
      all++;
      if (!at(...pt(r), tol)) continue;
      if (!at(...pt(r * 0.8), 0) || !at(...pt(r * 1.2), 0)) n++;
    }
    return n / all;
  };
  // Le vantail : un trait droit partant de la charnière, perpendiculaire au mur, de la longueur du rayon
  const leaf = (hinge: number, dir: number, side: number, r: number) => {
    let best = 0;
    for (const off of [0.02, 0.05, 0.08]) {
      let n = 0;
      let all = 0;
      for (let f = 0.3; f <= 0.9; f += 0.06) {
        all++;
        if (at(hinge + dir * r * off, c + side * (th / 2 + r * f))) n++;
      }
      best = Math.max(best, n / all);
    }
    return best;
  };
  const door = (hinge: number, dir: number, side: number, r: number) => {
    const a = arc(hinge, dir, side, r);
    const l = leaf(hinge, dir, side, r);
    return a >= 0.85 || (a >= 0.55 && l >= 0.7);
  };
  for (const side of [-1, 1])
    for (const k of [0.92, 1, 1.08]) {
      // porte simple, charnière d'un côté ou de l'autre
      if (door(g0, 1, side, gap * k) || door(g1, -1, side, gap * k)) return true;
      // porte double : deux arcs de rayon moitié
      if (gap > 2 * th && door(g0, 1, side, (gap / 2) * k) && door(g1, -1, side, (gap / 2) * k)) return true;
    }
  return false;
}

/**
 * Vitrage : au moins deux traits continus le long de la baie, dans l'épaisseur du mur (châssis, vitre, appui).
 * Un trait seul est souvent une ligne de cote qui passe par là.
 */
export function glazingLines(ink: Uint8Array, w: number, _h: number, horizontal: boolean, c: number, th: number, g0: number, g1: number): number {
  return glazingRows(ink, w, horizontal, c, th, g0, g1).length;
}

/** Positions (transversales) des traits continus qui traversent la baie dans l'épaisseur du mur. */
function glazingRows(ink: Uint8Array, w: number, horizontal: boolean, c: number, th: number, g0: number, g1: number): number[] {
  const gap = g1 - g0;
  const k0 = Math.ceil(g0 + 0.15 * gap);
  const k1 = Math.floor(g1 - 0.15 * gap);
  if (k1 <= k0) return [];
  const rows: number[] = [];
  let prev = false;
  for (let t = Math.floor(c - th / 2) - 1; t <= c + th / 2 + 1; t++) {
    let n = 0;
    for (let k = k0; k < k1; k++) {
      // un trait fin peut être à cheval sur deux lignes de pixels
      const i0 = horizontal ? t * w + k : k * w + t;
      const i1 = horizontal ? (t + 1) * w + k : k * w + t + 1;
      if ((i0 >= 0 && i0 < ink.length && ink[i0]) || (i1 >= 0 && i1 < ink.length && ink[i1])) n++;
    }
    const full = n >= 0.75 * (k1 - k0);
    if (full && !prev) rows.push(t);
    prev = full;
  }
  return rows;
}

/**
 * Vitrage dessiné dans une baie : deux traits ou plus dans l'épaisseur du mur, ou un seul trait au cœur
 * du mur (notation simplifiée). Un seuil de porte, lui, est sur une face du mur.
 */
export function isGlazing(ink: Uint8Array, w: number, horizontal: boolean, c: number, th: number, g0: number, g1: number): boolean {
  const rows = glazingRows(ink, w, horizontal, c, th, g0, g1);
  return rows.length >= 2 || (rows.length === 1 && Math.abs(rows[0] + 0.5 - c) <= Math.max(1, th * 0.25));
}

/** Retraçage à partir d'un masque des murs déjà isolé (en pixels), `ink` servant à reconnaître les fenêtres. */
function traceMask(source: Uint8Array, ink: Uint8Array, w: number, h: number, scale: number, minThick: number, minLength = 0.4, maxThick = Infinity): Omit<VectorizeResult, 'threshold'> {
  const dark = ink;
  const minLen = Math.max(minThick * 2, Math.round(minLength / scale));
  const mask = open(source, w, h, Math.floor((minThick - 1) / 2));

  type Seg = PxSeg;
  const segs: Seg[] = [];
  for (const horizontal of [true, false]) {
    for (const b0 of bands(mask, w, h, horizontal, minLen)) {
      let b = b0;
      if (b.t1 - b.t0 + 1 > maxThick) {
        // Bande trop épaisse : un mur à qui se sont collés des traits voisins (vitrage, hachures, cotes).
        // On garde le cœur : les lignes pleines sur presque toute la longueur.
        const full: boolean[] = [];
        for (let t = b.t0; t <= b.t1; t++) {
          let n = 0;
          for (let k = b.s; k <= b.e; k++) n += mask[horizontal ? t * w + k : k * w + t];
          full.push(n >= 0.85 * (b.e - b.s + 1));
        }
        let best: [number, number] | null = null;
        for (let i = 0; i < full.length; ) {
          if (!full[i]) {
            i++;
            continue;
          }
          const a = i;
          while (i < full.length && full[i]) i++;
          if (!best || i - a > best[1] - best[0]) best = [a, i];
        }
        if (!best) continue;
        b = { ...b, t0: b.t0 + best[0], t1: b.t0 + best[1] - 1 };
      }
      const th = b.t1 - b.t0 + 1;
      // Trop épais pour un mur : escalier, plan de travail, zone noircie de traits
      if (th < minThick || th > maxThick || b.e - b.s + 1 < Math.max(minLen, th * 1.3)) continue;
      segs.push({ horizontal, s: b.s, e: b.e + 1, c: (b.t0 + b.t1 + 1) / 2, th });
    }
  }
  // Taches pleines (symboles de pièce, poteaux isolés, logos) : une bande courte dans chaque direction au même
  // endroit. Un mur, lui, est long dans une direction.
  {
    const short = (S: Seg) => S.e - S.s < 2 * S.th;
    const box = (S: Seg) => (S.horizontal ? { x0: S.s, x1: S.e, y0: lo(S), y1: hi(S) } : { x0: lo(S), x1: hi(S), y0: S.s, y1: S.e });
    const blob = new Set<Seg>();
    for (const A of segs)
      for (const B of segs) {
        if (!A.horizontal || B.horizontal || !short(A) || !short(B)) continue;
        const a = box(A);
        const b = box(B);
        const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ix > 0 && iy > 0 && ix * iy > 0.5 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0))) {
          blob.add(A);
          blob.add(B);
        }
      }
    // … sauf un pilier dans l'alignement d'un mur (trumeau entre deux baies, poteau d'angle)
    const pier = (A: Seg) =>
      segs.some((P) => !blob.has(P) && P.horizontal === A.horizontal && Math.abs(P.c - A.c) <= Math.max(P.th, A.th) / 2 && Math.min(Math.abs(P.s - A.e), Math.abs(A.s - P.e)) < 3.5 / scale);
    const keep = new Set<Seg>();
    for (const A of blob) if (pier(A)) keep.add(A);
    for (let i = segs.length - 1; i >= 0; i--) if (blob.has(segs[i]) && !keep.has(segs[i])) segs.splice(i, 1);
  }
  mergeLayers(segs, scale);

  // Trous entre deux tronçons alignés : portes et fenêtres.
  const openingsPx: { seg: Seg; at: number; width: number; kind: 'porte' | 'fenetre'; source: 'trou' | 'vitrage' }[] = [];
  const maxGap = 3.2 / scale;
  const minGap = 0.45 / scale;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (const A of segs) {
      for (const B of segs) {
        if (A === B || A.horizontal !== B.horizontal) continue;
        if (Math.abs(A.c - B.c) > Math.max(A.th, B.th) / 2 || Math.abs(A.th - B.th) > Math.max(A.th, B.th) * 0.5) continue;
        const gap = B.s - A.e;
        if (gap < minGap || gap > maxGap) continue;
        // Un mur perpendiculaire dans le trou ? Alors ce n'est pas une ouverture.
        const crossing = segs.some((P) => P.horizontal !== A.horizontal && P.c > A.e + 1 && P.c < B.s - 1 && P.s <= A.c + A.th && P.e >= A.c - A.th);
        if (crossing) continue;
        const th = Math.max(A.th, B.th);
        const arc = doorArc(dark, w, h, A.horizontal, (A.c + B.c) / 2, th, A.e, B.s);
        const glass = !arc && isGlazing(dark, w, A.horizontal, (A.c + B.c) / 2, th, A.e, B.s);
        // Un vide sans arc ni vitrage n'est un passage qu'entre deux vrais morceaux de mur (pas des tirets)
        const solid = (S: Seg) => S.e - S.s >= Math.max(3 * S.th, 0.5 / scale);
        if (!arc && !glass && (gap > 1.4 / scale || !solid(A) || !solid(B))) continue;
        // (des lignes de texte ou de cotes, faites de petits morceaux, ne se relient pas même avec des « vitrages »)
        const piece = (S: Seg) => S.e - S.s >= Math.max(2 * S.th, 0.3 / scale);
        if (!arc && (!piece(A) || !piece(B))) continue;
        const kind = arc || !glass ? 'porte' : 'fenetre';
        const joined: Seg = { horizontal: A.horizontal, s: A.s, e: B.e, c: (A.c * (A.e - A.s) + B.c * (B.e - B.s)) / (A.e - A.s + B.e - B.s), th };
        for (const o of openingsPx) if (o.seg === A || o.seg === B) o.seg = joined;
        openingsPx.push({ seg: joined, at: (A.e + B.s) / 2, width: gap, kind, source: 'trou' });
        segs.splice(segs.indexOf(A), 1);
        segs.splice(segs.indexOf(B), 1);
        segs.push(joined);
        merged = true;
        break outer;
      }
    }
  }

  joinAligned(segs, openingsPx);

  // Baie entre le bout d'un mur et un mur perpendiculaire (porte contre une cloison, dans un angle) :
  // le tronçon s'arrête avant le mur d'en face. On le prolonge si le vide a l'allure d'une baie.
  const covered = (k0: number, k1: number, S: Seg) => {
    let n = 0;
    let all = 0;
    for (let k = Math.ceil(k0); k < k1; k++)
      for (let t = Math.ceil(lo(S)); t < hi(S); t++) {
        all++;
        if (mask[S.horizontal ? t * w + k : k * w + t]) n++;
      }
    return all ? n / all : 0;
  };
  for (const S of [...segs]) {
    for (const end of ['s', 'e'] as const) {
      const pos = S[end];
      const dir = end === 'e' ? 1 : -1;
      const attached = segs.some(
        (P) => P !== S && ((P.horizontal !== S.horizontal && S.c >= P.s - S.th && S.c <= P.e + S.th && Math.abs(P.c - pos) <= P.th / 2 + S.th) ||
          (P.horizontal === S.horizontal && Math.abs(P.c - S.c) <= Math.max(P.th, S.th) / 2 && (dir > 0 ? P.s >= pos - S.th && P.s <= pos + S.th : P.e <= pos + S.th && P.e >= pos - S.th))),
      );
      if (attached) continue;
      let best: Seg | null = null;
      let bd = Infinity;
      for (const P of segs) {
        if (P.horizontal === S.horizontal || S.c < P.s - 1 || S.c > P.e + 1) continue;
        const d = (P.c - (dir * P.th) / 2 - pos) * dir;
        if (d > 0 && d < bd) {
          bd = d;
          best = P;
        }
      }
      if (!best || bd < minGap * 0.9 || bd > 1.6 / scale) continue;
      const g0 = dir > 0 ? pos : best.c + best.th / 2;
      const g1 = dir > 0 ? best.c - best.th / 2 : pos;
      if (covered(g0, g1, S) > 0.3) continue;
      const arc = doorArc(dark, w, h, S.horizontal, S.c, S.th, g0, g1);
      const glass = isGlazing(dark, w, S.horizontal, S.c, S.th, g0, g1);
      if (!arc && !glass && bd > 1.1 / scale) continue;
      S[end] = best.c;
      openingsPx.push({ seg: S, at: (g0 + g1) / 2, width: g1 - g0, kind: arc || !glass ? 'porte' : 'fenetre', source: 'trou' });
    }
  }

  dropLoose(segs, scale, openingsPx);
  for (const o of [...openingsPx]) if (!segs.includes(o.seg)) openingsPx.splice(openingsPx.indexOf(o), 1);

  // Fenêtres dessinées dans un mur plein ou en double trait (sans trou dans le mur) : des traits parallèles
  // au mur, à l'intérieur de son épaisseur et sur toute la largeur de la baie. Un mur en double trait n'a de
  // traits que sur ses faces ; des hachures ne restent pas à la même place d'un pixel à l'autre.
  for (const S of segs) {
    const t0 = Math.floor(S.c - S.th / 2) - 2;
    const t1 = Math.ceil(S.c + S.th / 2) + 2;
    const span = t1 - t0 + 1;
    const profile = (k: number) => {
      let sig = '';
      for (let t = t0; t <= t1; t++) {
        const idx = S.horizontal ? t * w + k : k * w + t;
        sig += idx >= 0 && idx < dark.length && dark[idx] ? '1' : '0';
      }
      return sig;
    };
    const inner = (sig: string) => {
      const ones = [...sig].filter((c) => c === '1').length;
      if (ones > span * 0.6) return false; // mur plein
      const m = Math.max(2, Math.round(span * 0.2));
      // Un ou plusieurs traits de vitrage, au cœur de l'épaisseur du mur
      return sig.slice(m, span - m).includes('1') && sig.slice(m, span - m).includes('0');
    };
    const glass: boolean[] = [];
    const sigs: string[] = [];
    for (let k = Math.ceil(S.s); k < S.e; k++) sigs.push(profile(k));
    // Le profil le plus courant est celui du mur lui-même (ses deux faces, ou son remplissage)
    const freq = new Map<string, number>();
    for (const g of sigs) freq.set(g, (freq.get(g) ?? 0) + 1);
    const top = [...freq.entries()].sort((m, n) => n[1] - m[1])[0];
    // (des hachures n'ont pas de profil dominant : rien n'est alors exclu)
    const body = top && top[1] >= sigs.length * 0.3 ? top[0] : '';
    const differs = (g: string) => !body || [...g].filter((c, j) => c !== body[j]).length > 2;
    for (let i = 0; i < sigs.length; i++) glass.push(i >= 3 && sigs[i] === sigs[i - 3] && inner(sigs[i]) && differs(sigs[i]));
    let i = 0;
    while (i < glass.length) {
      if (!glass[i]) {
        i++;
        continue;
      }
      const a = i;
      while (i < glass.length && (glass[i] || (i + 1 < glass.length && glass[i + 1]))) i++;
      const len = i - a + 3; // les 3 premiers pixels servent de référence
      const at = Math.ceil(S.s) + a - 3 + len / 2;
      if (len < 0.4 / scale || len > 3.2 / scale) continue;
      // Une baie est encadrée de mur des deux côtés : pas collée à un bout du mur (angle, jonction)
      if (at - len / 2 - S.s < 0.1 / scale || S.e - (at + len / 2) < 0.1 / scale) continue;
      // … et fermée par un tableau à chaque bout : un trait en travers de toute l'épaisseur du mur.
      // Sans eux, ce n'est qu'une irrégularité du dessin (scan, couches d'un mur creux).
      const jamb = (k0: number) => {
        for (let k = Math.round(k0) - 3; k <= Math.round(k0) + 3; k++) {
          let n = 0;
          for (let t = Math.floor(lo(S)); t <= Math.ceil(hi(S)); t++) {
            const idx = S.horizontal ? t * w + k : k * w + t;
            if (idx >= 0 && idx < dark.length && dark[idx]) n++;
          }
          if (n >= 0.8 * (Math.ceil(hi(S)) - Math.floor(lo(S)) + 1)) return true;
        }
        return false;
      };
      if (!jamb(at - len / 2) || !jamb(at + len / 2)) continue;
      if (openingsPx.some((o) => o.seg === S && Math.abs(o.at - at) < (o.width + len) / 2)) continue;
      openingsPx.push({ seg: S, at, width: len, kind: 'fenetre', source: 'vitrage' });
    }
  }

  // Recalage des extrémités sur l'axe des murs perpendiculaires (angles et T).
  for (const S of segs) {
    for (const end of ['s', 'e'] as const) {
      const pos = S[end];
      let best: number | null = null;
      let bestD = Infinity;
      for (const P of segs) {
        if (P.horizontal === S.horizontal) continue;
        if (S.c < P.s - S.th || S.c > P.e + S.th) continue;
        const d = Math.abs(P.c - pos);
        if (d <= P.th / 2 + S.th && d < bestD) {
          bestD = d;
          best = P.c;
        }
      }
      if (best != null) S[end] = best;
    }
  }

  // Doublons : un tronçon couché sur un mur plus épais (reste d'une couche, recalé au même endroit)
  for (let i = segs.length - 1; i >= 0; i--) {
    const A = segs[i];
    const host = segs.find(
      (B) => B !== A && B.horizontal === A.horizontal && B.th >= A.th && Math.abs(B.c - A.c) <= B.th / 2 && Math.min(A.e, B.e) - Math.max(A.s, B.s) >= 0.8 * (A.e - A.s),
    );
    if (!host) continue;
    for (const o of openingsPx) if (o.seg === A) o.seg = host;
    segs.splice(i, 1);
  }
  joinAligned(segs, openingsPx);
  // Bouts restés libres près d'un mur perpendiculaire (angle dessiné en retrait, trait interrompu, baie
  // contre un angle) : on les raccorde, en prolongeant au besoin l'autre mur jusqu'à l'angle. Au-delà de
  // quelques dizaines de centimètres, il faut que le vide ait l'allure d'une baie (arc de porte, vitrage).
  const near = 0.6 / scale;
  const far = 3.2 / scale;
  const bay = (S: Seg, g0: number, g1: number) => {
    if (g1 - g0 < minGap * 0.9) return null;
    if (g1 - g0 <= 1.4 / scale && doorArc(dark, w, h, S.horizontal, S.c, S.th, g0, g1)) return 'porte' as const;
    if (isGlazing(dark, w, S.horizontal, S.c, S.th, g0, g1)) return 'fenetre' as const;
    return null;
  };
  for (const { seg: S, end } of freeEnds(segs)) {
    const pos = S[end];
    const dir = end === 'e' ? 1 : -1;
    let best: { P: Seg; cost: number; d1: number; d2: number; kind1: 'porte' | 'fenetre' | null; kind2: 'porte' | 'fenetre' | null } | null = null;
    for (const P of segs) {
      if (P === S || P.horizontal === S.horizontal) continue;
      const d1 = (P.c - pos) * dir;
      if (d1 < -S.th || d1 > far) continue;
      // le mur ne doit pas reculer au-delà de sa propre longueur
      if (dir > 0 ? P.c <= S.s + 2 : P.c >= S.e - 2) continue;
      const d2 = S.c < P.s ? P.s - S.c : S.c > P.e ? S.c - P.e : 0;
      if (d2 > far) continue;
      const g0 = dir > 0 ? pos : P.c + P.th / 2;
      const g1 = dir > 0 ? P.c - P.th / 2 : pos;
      const kind1 = d1 > near ? bay(S, g0, g1) : g1 - g0 >= minGap * 0.9 ? bay(S, g0, g1) : null;
      if (d1 > near && !kind1) continue;
      const q0 = S.c < P.s ? S.c + S.th / 2 : P.e;
      const q1 = S.c < P.s ? P.s : S.c - S.th / 2;
      const kind2 = d2 > 0 ? bay(P, q0, q1) : null;
      if (d2 > near && !kind2) continue;
      const cost = Math.max(0, d1) + d2;
      if (!best || cost < best.cost) best = { P, cost, d1, d2, kind1, kind2 };
    }
    if (!best) continue;
    const { P } = best;
    if (best.kind1) {
      const g0 = dir > 0 ? pos : P.c + P.th / 2;
      const g1 = dir > 0 ? P.c - P.th / 2 : pos;
      openingsPx.push({ seg: S, at: (g0 + g1) / 2, width: g1 - g0, kind: best.kind1, source: 'trou' });
    }
    if (best.kind2) {
      const q0 = S.c < P.s ? S.c + S.th / 2 : P.e;
      const q1 = S.c < P.s ? P.s : S.c - S.th / 2;
      openingsPx.push({ seg: P, at: (q0 + q1) / 2, width: q1 - q0, kind: best.kind2, source: 'trou' });
    }
    S[end] = P.c;
    if (S.c < P.s) P.s = S.c;
    if (S.c > P.e) P.e = S.c;
  }
  // Bouts de trait épais plantés dans un mur et qui ne mènent nulle part (symbole, poteau dessiné, texte gras)
  for (let pass = 0; pass < 2; pass++) {
    const loose = freeEnds(segs);
    for (const S of [...segs]) {
      const len = S.e - S.s;
      if (len >= Math.max(2 * S.th, 0.5 / scale) || openingsPx.some((o) => o.seg === S)) continue;
      if (loose.some((f) => f.seg === S)) segs.splice(segs.indexOf(S), 1);
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i].e - segs[i].s < 1) segs.splice(i, 1);
  const free = freeEnds(segs);

  const q = (v: number) => Math.round(v * scale * 100) / 100;
  const qt = (v: number) => Math.max(0.05, Math.round(v * scale * 100) / 100);
  const walls: TracedWall[] = segs.map((S) =>
    S.horizontal
      ? { a: { x: q(S.s), y: q(S.c) }, b: { x: q(S.e), y: q(S.c) }, thickness: qt(S.th) }
      : { a: { x: q(S.c), y: q(S.s) }, b: { x: q(S.c), y: q(S.e) }, thickness: qt(S.th) },
  );
  const openings: TracedOpening[] = openingsPx.flatMap((o) => {
    const i = segs.indexOf(o.seg);
    if (i < 0) return [];
    return [{ wall: i, kind: o.kind, offset: Math.round((o.at - o.seg.s) * scale * 100) / 100, width: Math.round(o.width * scale * 100) / 100, source: o.source }];
  });
  return { walls, openings, mask, free: free.map(({ seg: S, end }) => (S.horizontal ? { x: q(S[end]), y: q(S.c) } : { x: q(S.c), y: q(S[end]) })) };
}

/** Échelle estimée quand le plan n'est pas calibré : l'épaisseur la plus courante des murs extérieurs vaut ~30 cm. */
export function guessScale(bmp: Bitmap): number {
  const lum = luminance(bmp);
  const t = otsu(lum);
  const { width: w, height: h } = bmp;
  // Épaisseur des traits horizontaux les plus épais : on mesure les plages verticales de pixels sombres.
  const hist = new Map<number, number>();
  for (let x = 0; x < w; x += 3) {
    let run = 0;
    for (let y = 0; y < h; y++) {
      if (lum[y * w + x] <= t) run++;
      else {
        if (run >= 3 && run < h / 10) hist.set(run, (hist.get(run) ?? 0) + run);
        run = 0;
      }
    }
  }
  const sorted = [...hist.entries()].sort((a, b) => b[0] - a[0]);
  // Plus grande épaisseur bien représentée
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  let acc = 0;
  for (const [th, v] of sorted) {
    acc += v;
    if (acc > total * 0.15) return 0.3 / th;
  }
  return 0.01;
}

// ---------------------------------------------------------------------------
// Détection automatique de l'aspect des murs
// ---------------------------------------------------------------------------

export type WallStyle = 'plein' | 'encre' | 'rempli' | 'contour';

export const WALL_STYLE_LABELS: Record<WallStyle, string> = {
  plein: 'murs noirs pleins',
  encre: 'murs pleins ou hachurés',
  rempli: 'murs remplis de gris ou de couleur',
  contour: 'murs dessinés par deux traits parallèles',
};

/** Dilatation par un carré de côté 2r+1. */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const I = integral(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (boxSum(I, w, h, x - r, y - r, x + r, y + r) > 0) out[y * w + x] = 1;
  return out;
}

/** Érosion par un carré de côté 2r+1 (les bords de l'image comptent comme pleins). */
function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const I = integral(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const x0 = Math.max(0, x - r);
      const y0 = Math.max(0, y - r);
      const x1 = Math.min(w - 1, x + r);
      const y1 = Math.min(h - 1, y + r);
      if (boxSum(I, w, h, x0, y0, x1, y1) === (x1 - x0 + 1) * (y1 - y0 + 1)) out[y * w + x] = 1;
    }
  return out;
}

/** Fermeture morphologique : bouche les vides plus étroits que 2r+1 (hachures, intérieur d'un mur en double trait). */
export function close(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  return erode(dilate(mask, w, h, r), w, h, r);
}

/** Couleur du papier : la luminance la plus fréquente. */
export function background(lum: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of lum) hist[v]++;
  let best = 255;
  for (let i = 0; i < 256; i++) if (hist[i] > hist[best]) best = i;
  return best;
}

/**
 * Épaisseurs (en pixels) des structures longues et droites du masque : pour chaque plage transversale,
 * on vérifie qu'elle appartient à une bande au moins 5 fois plus longue qu'épaisse.
 */
export function thicknessHistogram(mask: Uint8Array, w: number, h: number, maxT = Math.round(Math.min(w, h) / 12)): number[] {
  const hist = new Array<number>(maxT + 1).fill(0);
  // Longueur des plages horizontales et verticales, pour chaque pixel
  const hr = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && mask[y * w + x]) x++;
      for (let k = s; k < x; k++) hr[y * w + k] = Math.min(65535, x - s);
    }
  }
  const vr = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y++;
        continue;
      }
      const s = y;
      while (y < h && mask[y * w + x]) y++;
      for (let k = s; k < y; k++) vr[k * w + x] = Math.min(65535, y - s);
    }
  }
  // Murs horizontaux : plage verticale d'épaisseur t au milieu d'une plage horizontale longue
  for (let x = 0; x < w; x += 2) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y++;
        continue;
      }
      const s = y;
      while (y < h && mask[y * w + x]) y++;
      const t = y - s;
      if (t <= maxT && hr[((s + y) >> 1) * w + x] >= Math.max(5 * t, 12)) hist[t] += 2;
    }
  }
  for (let y = 0; y < h; y += 2) {
    let x = 0;
    while (x < w) {
      if (!mask[y * w + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && mask[y * w + x]) x++;
      const t = x - s;
      if (t <= maxT && vr[y * w + ((s + x) >> 1)] >= Math.max(5 * t, 12)) hist[t] += 2;
    }
  }
  return hist;
}

/** Épaisseur des cloisons (la plus fine bien représentée) et des murs extérieurs (la plus épaisse bien représentée). */
export function wallThickness(hist: number[]): { thin: number; thick: number; mass: number } | null {
  const smooth = hist.map((_, t) => (hist[t - 1] ?? 0) + hist[t] + (hist[t + 1] ?? 0));
  const area = smooth.map((v, t) => (t >= 3 ? v * t : 0)); // pondéré par l'épaisseur : surface des murs
  const peak = Math.max(...area);
  if (peak <= 0) return null;
  // Murs extérieurs : la plus grande épaisseur bien représentée
  const thick = area.map((v) => v >= peak * 0.2).lastIndexOf(true);
  // Cloisons : un pic secondaire plus fin, même peu représenté (murs plus courts), mais pas un simple trait
  const floor = Math.max(3, Math.round(thick / 5));
  let thin = thick;
  for (let t = floor; t < thick; t++) {
    const isPeak = smooth[t] >= (smooth[t - 1] ?? 0) && smooth[t] >= (smooth[t + 1] ?? 0);
    if (isPeak && area[t] >= peak * 0.04) {
      thin = t;
      break;
    }
  }
  const mass = hist.reduce((s, v, t) => s + (t >= thin ? v * t : 0), 0);
  return { thin, thick, mass };
}

/**
 * Murs dessinés par leur contour (deux traits parallèles, éventuellement hachurés) : l'intérieur d'un mur est
 * une zone blanche fermée et étroite. On remplit les zones blanches dont la largeur ne dépasse pas `maxWidth`
 * pixels ; les pièces, bien plus larges, restent vides.
 */
export function fillNarrow(ink: Uint8Array, w: number, h: number, maxWidth: number): Uint8Array {
  const n = w * h;
  // Distance (chanfrein 3-4) de chaque pixel blanc au trait le plus proche
  const INF = 1 << 20;
  const d = new Int32Array(n);
  for (let i = 0; i < n; i++) d[i] = ink[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  // Zones blanches (4-connexes) : largeur = 2 × distance maximale au trait
  const label = new Int32Array(n).fill(-1);
  const out = ink.slice();
  const stack: number[] = [];
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (ink[start] || label[start] >= 0) continue;
    let maxD = 0;
    let border = false;
    members.length = 0;
    stack.push(start);
    label[start] = start;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      if (d[i] > maxD) maxD = d[i];
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && !ink[i - 1] && label[i - 1] < 0) (label[i - 1] = start), stack.push(i - 1);
      if (x < w - 1 && !ink[i + 1] && label[i + 1] < 0) (label[i + 1] = start), stack.push(i + 1);
      if (y > 0 && !ink[i - w] && label[i - w] < 0) (label[i - w] = start), stack.push(i - w);
      if (y < h - 1 && !ink[i + w] && label[i + w] < 0) (label[i + w] = start), stack.push(i + w);
    }
    if (!border && (2 * maxD) / 3 <= maxWidth) for (const i of members) out[i] = 1;
  }
  return out;
}

export interface AutoVectorizeResult extends VectorizeResult {
  style: WallStyle;
  /** Échelle utilisée (m/pixel) : celle fournie, ou estimée d'après l'épaisseur des murs extérieurs (≈ 30 cm). */
  scale: number;
  /** Épaisseurs de mur reconnues, en mètres. */
  thin: number;
  thick: number;
  /** Nombre de pièces fermées obtenues. */
  rooms: number;
}

/** Les différentes façons dont un plan peut dessiner ses murs, sous forme de masques candidats. */
function candidates(bmp: Bitmap, lum: Uint8Array, threshold: number): { style: WallStyle; mask: Uint8Array }[] {
  const { width: w, height: h } = bmp;
  const n = w * h;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = lum[i] <= threshold ? 1 : 0;
  const black = new Uint8Array(n);
  const strong = Math.min(threshold, 110);
  for (let i = 0; i < n; i++) black[i] = lum[i] <= strong ? 1 : 0;
  // Tout ce qui n'est pas du papier : gris clair, couleurs, hachures
  const bg = background(lum);
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = bmp.data[i * 4];
    const g = bmp.data[i * 4 + 1];
    const b = bmp.data[i * 4 + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    filled[i] = bg - lum[i] > 28 || (sat > 45 && bmp.data[i * 4 + 3] > 128) ? 1 : 0;
  }
  const out: { style: WallStyle; mask: Uint8Array }[] = [
    { style: 'plein', mask: black },
    { style: 'encre', mask: close(ink, w, h, 1) },
    { style: 'rempli', mask: close(filled, w, h, 1) },
  ];
  // Murs en double trait (hachurés ou non) : on remplit l'intérieur, pour plusieurs largeurs de mur possibles
  const side = Math.max(w, h);
  const thinInk = close(ink, w, h, 1);
  for (const k of [60, 35, 20]) out.push({ style: 'contour', mask: fillNarrow(thinInk, w, h, side / k) });
  return out;
}

/**
 * Pièces formées par des murs retracés. Une « pièce » qui contient d'autres murs n'en est pas une : c'est le
 * cadre de la feuille ou du cartouche autour du dessin, ou le contour de toute la maison.
 */
type Sheet = { w: number; h: number };
function traceRooms(walls: TracedWall[], sheet?: Sheet) {
  const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null };
  walls.forEach((x, i) => insertWall(b, { id: `t${i}`, levelId: b.levels[0].id, a: x.a, b: x.b, thickness: x.thickness, height: 2.5, kind: 'cloison', finish: { gauche: null, droite: null } }));
  const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, q: { x: number; y: number }) => {
    const dx = q.x - a.x;
    const dy = q.y - a.y;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  return detectRooms(b).filter((room) => {
    const poly = room.polygon;
    // Le cadre de la feuille : presque toute la page, en largeur comme en hauteur
    if (sheet) {
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      if (Math.max(...xs) - Math.min(...xs) > 0.85 * sheet.w && Math.max(...ys) - Math.min(...ys) > 0.85 * sheet.h) return false;
    }
    let perim = 0;
    for (let i = 0; i < poly.length; i++) perim += Math.hypot(poly[(i + 1) % poly.length].x - poly[i].x, poly[(i + 1) % poly.length].y - poly[i].y);
    let innerLen = 0;
    for (const x of walls) {
      const m = { x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 };
      if (!pointInPolygon(m, poly)) continue;
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(m, poly[i], poly[(i + 1) % poly.length]));
      if (d > x.thickness / 2 + 0.05) innerLen += Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y);
    }
    return innerLen <= 0.5 * perim;
  });
}

/** Surface (m²) et nombre des pièces fermées que formeraient ces murs. */
function closedArea(walls: TracedWall[], sheet?: Sheet): { area: number; rooms: number; significant: number; box: { x0: number; y0: number; x1: number; y1: number } | null } {
  const rooms = traceRooms(walls, sheet);
  const area = rooms.reduce((s, r) => s + r.area, 0);
  // Pièces d'au moins 2 % de la surface : les petits recoins dus au bruit ne comptent pas
  const sig = rooms.filter((r) => r.area >= area * 0.02);
  const pts = sig.flatMap((r) => r.polygon);
  const box = pts.length
    ? { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) }
    : null;
  return { area, rooms: rooms.length, significant: sig.length, box };
}

/** Part des pixels couverts par les murs tracés qui sont encrés sur le plan. */
function inkSupport(walls: TracedWall[], ink: Uint8Array, w: number, h: number, scale: number): number {
  let inked = 0;
  let all = 0;
  for (const x of walls) {
    const t = x.thickness / scale;
    const hz = Math.abs(x.a.y - x.b.y) < 1e-6;
    const x0 = Math.round(Math.min(x.a.x, x.b.x) / scale - (hz ? 0 : t / 2));
    const x1 = Math.round(Math.max(x.a.x, x.b.x) / scale + (hz ? 0 : t / 2));
    const y0 = Math.round(Math.min(x.a.y, x.b.y) / scale - (hz ? t / 2 : 0));
    const y1 = Math.round(Math.max(x.a.y, x.b.y) / scale + (hz ? t / 2 : 0));
    for (let yy = Math.max(0, y0); yy < Math.min(h, y1); yy += 2)
      for (let xx = Math.max(0, x0); xx < Math.min(w, x1); xx += 2) {
        all++;
        inked += ink[yy * w + xx];
      }
  }
  return all ? inked / all : 0;
}

/** Murs de façade : d'un côté au moins, juste à côté du mur, on n'est dans aucune pièce. */
export function exteriorFlags(walls: TracedWall[], sheet?: Sheet): boolean[] {
  const rooms = traceRooms(walls, sheet);
  const inside = (p: { x: number; y: number }) => rooms.some((room) => pointInPolygon(p, room.polygon));
  return walls.map((w) => {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const d = w.thickness / 2 + 0.25;
    let out = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const p = { x: w.a.x + ux * L * f, y: w.a.y + uy * L * f };
      const left = inside({ x: p.x - uy * d, y: p.y + ux * d });
      const right = inside({ x: p.x + uy * d, y: p.y - ux * d });
      if (!left || !right) out++;
    }
    if (!rooms.length || out < 2) return false;
    // Doublage : un mur fin le long de la face intérieure d'une façade n'est pas la façade
    const hz = Math.abs(w.a.y - w.b.y) < 1e-6;
    const c = hz ? w.a.y : w.a.x;
    const s0 = Math.min(hz ? w.a.x : w.a.y, hz ? w.b.x : w.b.y);
    const s1 = Math.max(hz ? w.a.x : w.a.y, hz ? w.b.x : w.b.y);
    const lining = walls.some((o) => {
      if (o === w || o.thickness <= w.thickness || Math.abs(o.a.y - o.b.y) < 1e-6 !== hz) return false;
      const oc = hz ? o.a.y : o.a.x;
      const gap = Math.abs(oc - c);
      const o0 = Math.min(hz ? o.a.x : o.a.y, hz ? o.b.x : o.b.y);
      const o1 = Math.max(hz ? o.a.x : o.a.y, hz ? o.b.x : o.b.y);
      const lo0 = Math.max(s0, o0);
      const hi0 = Math.min(s1, o1);
      if (gap <= 0.01 || gap > 0.6 || hi0 - lo0 < 0.5 * (s1 - s0)) return false;
      // … et entre les deux, pas de pièce : l'autre mur est bien du côté extérieur
      const m = (lo0 + hi0) / 2;
      const mid = (c + oc) / 2;
      return !inside(hz ? { x: m, y: mid } : { x: mid, y: m });
    });
    return !lining;
  });
}

/**
 * Correction d'échelle : les murs de façade font ~32 cm (murs creux réunis) et les portes intérieures
 * ~88 cm de baie. Renvoie le facteur à appliquer à l'échelle courante.
 */
export function scaleCorrection(walls: TracedWall[], openings: TracedOpening[], sheet?: Sheet): number {
  const ext = exteriorFlags(walls, sheet);
  const len = (w: TracedWall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const weighted = walls.map((w, i) => ({ t: w.thickness, l: ext[i] ? len(w) : 0 })).filter((x) => x.l > 0).sort((m, n) => m.t - n.t);
  const total = weighted.reduce((s, x) => s + x.l, 0);
  let fw = 1;
  if (total > 0) {
    let acc = 0;
    const med = weighted.find((x) => (acc += x.l) >= total / 2)!.t;
    fw = 0.32 / med;
  }
  const doors = openings.filter((o) => o.kind === 'porte' && !ext[o.wall] && o.width > 0).map((o) => o.width).sort((m, n) => m - n);
  // Les portes intérieures sont la mesure la plus constante d'un plan à l'autre (73 à 93 cm de passage) ;
  // l'épaisseur des façades varie bien plus (20 à 50 cm) et ne sert qu'à défaut.
  if (doors.length >= 3) {
    const fd = 0.85 / doors[Math.floor(doors.length / 2)];
    if (fd / fw > 0.5 && fd / fw < 2) return fd;
  }
  return fw;
}

/** Garde les murs qui vérifient `keep`, en renumérotant les ouvertures. */
function keepWalls<T extends Omit<VectorizeResult, 'threshold'>>(r: T, keep: (w: TracedWall) => boolean): T {
  const map = new Map<number, number>();
  const walls: TracedWall[] = [];
  r.walls.forEach((w, i) => {
    if (keep(w)) {
      map.set(i, walls.length);
      walls.push(w);
    }
  });
  const openings = r.openings.filter((o) => map.has(o.wall)).map((o) => ({ ...o, wall: map.get(o.wall)! }));
  return { ...r, walls, openings };
}

/**
 * Retraçage sans réglage : on essaie chaque façon de dessiner les murs, on en déduit l'épaisseur
 * (et l'échelle si le plan n'est pas étalonné), puis on garde l'interprétation qui ferme le plus de pièces.
 */
/** Pour la mise au point : chaque lecture essayée, avec son score. */
export type TraceDebug = (info: { style: WallStyle; thin: number; thick: number; scale: number; score: number; rooms: number; result: Omit<VectorizeResult, 'threshold'>; stats: Record<string, number> }) => void;

export function autoVectorize(bmp: Bitmap, opts: { scale?: number | null; debug?: TraceDebug } = {}): AutoVectorizeResult | null {
  const { width: w, height: h } = bmp;
  const lum = luminance(bmp);
  const threshold = otsu(lum);
  // Trait, même fin ou adouci par un scan : sert à reconnaître les vitrages
  const bg = background(lum);
  const soft = Math.max(threshold, bg - 60);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) ink[i] = lum[i] <= soft ? 1 : 0;
  let best: (AutoVectorizeResult & { score: number }) | null = null;
  const seen = new Set<string>();
  for (const c of candidates(bmp, lum, threshold)) {
    const th = wallThickness(thicknessHistogram(c.mask, w, h));
    if (!th) continue;
    const key = `${c.style === 'contour' ? 'c' : c.style}-${th.thin}-${th.thick}-${th.mass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const minThick = Math.max(3, Math.floor(th.thin * 0.8));
    const read = (scale: number) => {
      let r = traceMask(c.mask, ink, w, h, scale, minThick, 0.4, th.thick * 1.6 + 2);
      let closed = closedArea(r.walls, { w: w * scale, h: h * scale });
      // Hors de la maison (cotes, cartouche, légende) : on ne garde que ce qui touche l'emprise des pièces
      const box = closed.box;
      if (box && closed.significant >= 2) {
        const m = th.thick * scale * 1.5 + 0.2;
        const inBox = (p: { x: number; y: number }) => p.x >= box.x0 - m && p.x <= box.x1 + m && p.y >= box.y0 - m && p.y <= box.y1 + m;
        const n = r.walls.length;
        // (un long mur épais reste : pignon sous combles, façade d'une pièce qui ne ferme pas)
        const major = (x: TracedWall) => x.thickness >= th.thick * scale * 0.8 && Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y) >= 2.5;
        r = keepWalls(r, (x) => major(x) || inBox(x.a) || inBox(x.b) || inBox({ x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 }));
        r = { ...r, free: r.free?.filter(inBox) };
        if (r.walls.length !== n) closed = closedArea(r.walls, { w: w * scale, h: h * scale });
      }
      return { r, ...closed };
    };
    type Read = ReturnType<typeof read>;
    const rate = (x: Read, scale: number) => {
      const { r, area, significant } = x;
      const length = r.walls.reduce((s, x) => s + Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y), 0) / scale;
      const support = inkSupport(r.walls, ink, w, h, scale);
      // Surface fermée en pixels², plus il y a de vraies pièces mieux c'est ; à défaut de pièces, la longueur
      // de murs trouvée départage. Les murs doivent correspondre à du dessin (un trait sur chaque face) ;
      // on pénalise les masques qui noircissent tout, les murs émiettés et les bouts qui ne mènent nulle part.
      const covered = r.mask.reduce((s, v) => s + v, 0) / (w * h);
      const crumbs = Math.max(0, r.walls.length - 4 * significant - 8);
      const loose = r.free?.length ?? 0;
      const score =
        (((area / (scale * scale)) * (1 + 0.25 * Math.min(significant, 15)) + length * th.thin * 0.5) * support * (covered > 0.35 ? 0.2 : 1)) /
        ((1 + 0.03 * crumbs) * (1 + 0.04 * loose));
      return { score, stats: { sig: significant, areaPx: Math.round(area / (scale * scale)), support: +support.toFixed(2), covered: +covered.toFixed(2), crumbs, loose } };
    };
    // Plan non étalonné : l'épaisseur des murs donne une première idée de l'échelle, qu'on affine d'après
    // les façades et la largeur des portes une fois le plan lu.
    const s0 = opts.scale ?? 0.3 / th.thick;
    let pick: { x: Read; scale: number; q: ReturnType<typeof rate> } | null = null;
    for (const sc of [s0]) {
      const x = read(sc);
      if (!x.r.walls.length) continue;
      const q = rate(x, sc);
      if (!pick || q.score > pick.q.score) pick = { x, scale: sc, q };
    }
    if (!pick) continue;
    if (!opts.scale) {
      const f = scaleCorrection(pick.x.r.walls, pick.x.r.openings, { w: w * pick.scale, h: h * pick.scale });
      if (Math.abs(f - 1) > 0.05) {
        const x = read(pick.scale * f);
        if (x.r.walls.length) {
          const q = rate(x, pick.scale * f);
          if (q.score >= 0.7 * pick.q.score) pick = { x, scale: pick.scale * f, q };
        }
      }
    }
    const { x, scale, q } = pick;
    const { r, rooms } = x;
    opts.debug?.({ style: c.style, thin: th.thin, thick: th.thick, scale, score: q.score, rooms, result: r, stats: q.stats });
    if (!best || q.score > best.score)
      best = { ...r, threshold, style: c.style, scale, thin: th.thin * scale, thick: th.thick * scale, rooms, score: q.score };
  }
  if (!best) return null;
  const { score: _score, ...res } = best;
  return refine(res);
}

/** Regroupe des valeurs proches (à `tol` près) et renvoie la valeur commune de chacune. */
function clusterValues(values: { v: number; weight: number }[], tol: number): (v: number) => number {
  const sorted = [...values].sort((m, n) => m.v - n.v);
  const groups: { sum: number; weight: number; min: number; max: number }[] = [];
  for (const x of sorted) {
    const g = groups[groups.length - 1];
    if (g && x.v - g.max <= tol) {
      g.sum += x.v * x.weight;
      g.weight += x.weight;
      g.max = x.v;
    } else groups.push({ sum: x.v * x.weight, weight: x.weight, min: x.v, max: x.v });
  }
  const centers = groups.map((g) => ({ c: Math.round((g.sum / g.weight) * 100) / 100, min: g.min - tol, max: g.max + tol }));
  return (v: number) => centers.find((c) => v >= c.min && v <= c.max)?.c ?? v;
}

/**
 * Finitions : murs alignés sur les mêmes axes (à 4 cm près), extrémités recalées sur ces axes,
 * et ouvertures vérifiées : une fenêtre n'est retenue que dans un mur de façade (un trou dans un mur
 * intérieur est une porte, des « traits de vitrage » dans un mur intérieur sont du mobilier).
 */
export function refine<T extends VectorizeResult>(r: T): T {
  const walls = r.walls.map((w) => ({ ...w, a: { ...w.a }, b: { ...w.b } }));
  const horiz = (w: TracedWall) => Math.abs(w.a.y - w.b.y) < 1e-6;
  const len = (w: TracedWall) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  const xs = clusterValues(walls.filter((w) => !horiz(w)).map((w) => ({ v: w.a.x, weight: len(w) })), 0.04);
  const ys = clusterValues(walls.filter(horiz).map((w) => ({ v: w.a.y, weight: len(w) })), 0.04);
  // Les ouvertures gardent leur position absolue pendant le recalage
  const abs = r.openings.map((o) => {
    const w = r.walls[o.wall];
    const L = len(w) || 1;
    return { x: w.a.x + ((w.b.x - w.a.x) * o.offset) / L, y: w.a.y + ((w.b.y - w.a.y) * o.offset) / L };
  });
  for (const w of walls) {
    w.a = { x: xs(w.a.x), y: ys(w.a.y) };
    w.b = { x: xs(w.b.x), y: ys(w.b.y) };
  }
  // Façades : un point juste à côté du mur, d'un côté, n'est dans aucune pièce
  const rooms = traceRooms(walls);
  const inside = (p: { x: number; y: number }) => rooms.some((room) => pointInPolygon(p, room.polygon));
  const exterior = (w: TracedWall, along: number) => {
    const L = len(w) || 1;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const d = w.thickness / 2 + 0.25;
    const p = { x: w.a.x + ux * along, y: w.a.y + uy * along };
    return !rooms.length || !inside({ x: p.x - uy * d, y: p.y + ux * d }) || !inside({ x: p.x + uy * d, y: p.y - ux * d });
  };
  const openings: TracedOpening[] = [];
  r.openings.forEach((o, i) => {
    const w = walls[o.wall];
    const L = len(w) || 1;
    const p = abs[i];
    const offset = Math.round(Math.hypot(p.x - w.a.x, p.y - w.a.y) * 100) / 100;
    // L'ouverture doit tenir dans son mur
    if (offset - o.width / 2 < -0.05 || offset + o.width / 2 > L + 0.05) return;
    let kind = o.kind;
    if (kind === 'fenetre' && !exterior(w, offset)) {
      if (o.source === 'vitrage') return;
      kind = 'porte';
    }
    // Pas deux ouvertures qui se chevauchent sur le même mur
    if (openings.some((x) => x.wall === o.wall && Math.abs(x.offset - offset) < (x.width + o.width) / 2)) return;
    openings.push({ ...o, kind, offset });
  });
  return { ...r, walls, openings };
}
