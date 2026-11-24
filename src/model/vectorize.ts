/**
 * Retraçage automatique d'un plan scanné ou exporté (image), sans service externe.
 *
 * Principe :
 * 1. seuillage automatique (Otsu) pour isoler le trait noir ;
 * 2. ouverture morphologique : on efface tout ce qui est plus fin qu'un mur
 *    (textes, cotes, hachures, mobilier, traits de fenêtre) ;
 * 3. extraction des bandes horizontales et verticales épaisses : ce sont les murs ;
 * 4. les trous entre deux tronçons alignés deviennent des portes (vide) ou des fenêtres (traits fins) ;
 * 5. les extrémités sont recalées sur l'axe des murs perpendiculaires pour fermer les pièces.
 *
 * Les plans en biais ou les murs courbes ne sont pas gérés : ils se reprennent à la main.
 */

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
}

export interface VectorizeResult {
  walls: TracedWall[];
  openings: TracedOpening[];
  /** Masque des pixels retenus comme murs (pour l'aperçu). */
  mask: Uint8Array;
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

interface Band {
  /** Axe le long du mur (x pour un mur horizontal) */
  s: number;
  e: number;
  /** Position transversale (y pour un mur horizontal) */
  t0: number;
  t1: number;
}

/** Regroupe les plages longues de lignes consécutives en bandes (murs). */
function bands(mask: Uint8Array, w: number, h: number, horizontal: boolean, minLen: number): Band[] {
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const at = (line: number, k: number) => (horizontal ? mask[line * w + k] : mask[k * w + line]);
  const done: Band[] = [];
  let open_: (Band & { last: number })[] = [];
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
      const g = open_.find((b) => b.last === line - 1 && Math.min(e, b.e) - Math.max(s, b.s) > 0.6 * Math.min(e - s, b.e - b.s));
      if (g) {
        g.s = Math.min(g.s, s);
        g.e = Math.max(g.e, e);
        g.t1 = line;
        g.last = line;
        if (!next.includes(g)) next.push(g);
      } else next.push({ s, e, t0: line, t1: line, last: line });
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
  const minLen = Math.max(minThick * 2, Math.round((opts.minLength ?? 0.4) / scale));
  const lum = luminance(bmp);
  const threshold = otsu(lum);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) dark[i] = lum[i] <= threshold ? 1 : 0;
  const mask = open(dark, w, h, Math.floor(minThick / 2));

  type Seg = { horizontal: boolean; s: number; e: number; c: number; th: number };
  const segs: Seg[] = [];
  for (const horizontal of [true, false]) {
    for (const b of bands(mask, w, h, horizontal, minLen)) {
      const th = b.t1 - b.t0 + 1;
      if (th < minThick || b.e - b.s + 1 < Math.max(minLen, th * 1.5)) continue;
      segs.push({ horizontal, s: b.s, e: b.e + 1, c: (b.t0 + b.t1 + 1) / 2, th });
    }
  }

  // Trous entre deux tronçons alignés : portes et fenêtres.
  const openingsPx: { seg: Seg; at: number; width: number; kind: 'porte' | 'fenetre' }[] = [];
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
        // Traits fins dans l'épaisseur du mur = vitrage d'une fenêtre ; vide = porte.
        const th = Math.max(A.th, B.th);
        let ink = 0;
        let count = 0;
        for (let k = Math.ceil(A.e); k < B.s; k++) {
          for (let t = Math.floor(A.c - th / 2); t < A.c + th / 2; t++) {
            const idx = A.horizontal ? t * w + k : k * w + t;
            if (idx < 0 || idx >= dark.length) continue;
            ink += dark[idx];
            count++;
          }
        }
        const kind: 'porte' | 'fenetre' = count && ink / count > 0.06 ? 'fenetre' : 'porte';
        const joined: Seg = { horizontal: A.horizontal, s: A.s, e: B.e, c: (A.c * (A.e - A.s) + B.c * (B.e - B.s)) / (A.e - A.s + B.e - B.s), th };
        for (const o of openingsPx) if (o.seg === A || o.seg === B) o.seg = joined;
        openingsPx.push({ seg: joined, at: (A.e + B.s) / 2, width: gap, kind });
        segs.splice(segs.indexOf(A), 1);
        segs.splice(segs.indexOf(B), 1);
        segs.push(joined);
        merged = true;
        break outer;
      }
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

  const q = (v: number) => Math.round(v * scale * 100) / 100;
  const qt = (v: number) => Math.max(0.05, Math.round((v * scale) / 0.05) * 0.05);
  const walls: TracedWall[] = segs.map((S) =>
    S.horizontal
      ? { a: { x: q(S.s), y: q(S.c) }, b: { x: q(S.e), y: q(S.c) }, thickness: qt(S.th) }
      : { a: { x: q(S.c), y: q(S.s) }, b: { x: q(S.c), y: q(S.e) }, thickness: qt(S.th) },
  );
  const openings: TracedOpening[] = openingsPx.flatMap((o) => {
    const i = segs.indexOf(o.seg);
    if (i < 0) return [];
    return [{ wall: i, kind: o.kind, offset: Math.round((o.at - o.seg.s) * scale * 100) / 100, width: Math.round(o.width * scale * 100) / 100 }];
  });
  return { walls, openings, mask, threshold };
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
