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
  const lum = luminance(bmp);
  const threshold = otsu(lum);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) dark[i] = lum[i] <= threshold ? 1 : 0;
  return { ...traceMask(dark, dark, w, h, scale, minThick, opts.minLength), threshold };
}

/** Retraçage à partir d'un masque des murs déjà isolé (en pixels), `ink` servant à reconnaître les fenêtres. */
function traceMask(source: Uint8Array, ink: Uint8Array, w: number, h: number, scale: number, minThick: number, minLength = 0.4): Omit<VectorizeResult, 'threshold'> {
  const dark = ink;
  const minLen = Math.max(minThick * 2, Math.round(minLength / scale));
  const mask = open(source, w, h, Math.floor((minThick - 1) / 2));

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
        // Vitrage : un trait continu le long de l'ouverture, dans l'épaisseur du mur (on ignore les tableaux
        // aux deux bouts, où arrivent aussi le vantail et l'arc d'une porte). Rien de tel : c'est une porte.
        const th = Math.max(A.th, B.th);
        const k0 = Math.ceil(A.e + 0.15 * gap);
        const k1 = Math.floor(B.s - 0.15 * gap);
        let glazing = false;
        for (let t = Math.floor(A.c - th / 2) - 1; t <= A.c + th / 2 + 1 && !glazing && k1 > k0; t++) {
          let ink = 0;
          for (let k = k0; k < k1; k++) {
            // un trait fin peut être à cheval sur deux lignes de pixels
            const i0 = A.horizontal ? t * w + k : k * w + t;
            const i1 = A.horizontal ? (t + 1) * w + k : k * w + t + 1;
            if ((i0 >= 0 && i0 < dark.length && dark[i0]) || (i1 >= 0 && i1 < dark.length && dark[i1])) ink++;
          }
          glazing = ink >= 0.75 * (k1 - k0);
        }
        const kind: 'porte' | 'fenetre' = glazing ? 'fenetre' : 'porte';
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
    return [{ wall: i, kind: o.kind, offset: Math.round((o.at - o.seg.s) * scale * 100) / 100, width: Math.round(o.width * scale * 100) / 100, source: o.source }];
  });
  return { walls, openings, mask };
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

/** Surface (m²) et nombre des pièces fermées que formeraient ces murs. */
function closedArea(walls: TracedWall[]): { area: number; rooms: number; significant: number } {
  const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null };
  walls.forEach((x, i) => insertWall(b, { id: `t${i}`, levelId: b.levels[0].id, a: x.a, b: x.b, thickness: x.thickness, height: 2.5, kind: 'cloison', finish: { gauche: null, droite: null } }));
  const rooms = detectRooms(b);
  const area = rooms.reduce((s, r) => s + r.area, 0);
  // Pièces d'au moins 2 % de la surface : les petits recoins dus au bruit ne comptent pas
  return { area, rooms: rooms.length, significant: rooms.filter((r) => r.area >= area * 0.02).length };
}

/**
 * Retraçage sans réglage : on essaie chaque façon de dessiner les murs, on en déduit l'épaisseur
 * (et l'échelle si le plan n'est pas étalonné), puis on garde l'interprétation qui ferme le plus de pièces.
 */
export function autoVectorize(bmp: Bitmap, opts: { scale?: number | null } = {}): AutoVectorizeResult | null {
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
    const scale = opts.scale ?? 0.3 / th.thick;
    const minThick = Math.max(3, Math.floor(th.thin * 0.8));
    const r = traceMask(c.mask, ink, w, h, scale, minThick);
    if (!r.walls.length) continue;
    const { area, rooms, significant } = closedArea(r.walls);
    const length = r.walls.reduce((s, x) => s + Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y), 0) / scale;
    // Surface fermée en pixels², plus il y a de vraies pièces mieux c'est ; à défaut de pièces, la longueur
    // de murs trouvée départage. On pénalise les masques qui noircissent tout et les murs émiettés.
    const covered = r.mask.reduce((s, v) => s + v, 0) / (w * h);
    const crumbs = Math.max(0, r.walls.length - 4 * significant - 8);
    const score =
      ((area / (scale * scale)) * (1 + 0.12 * Math.min(significant, 15)) + length * th.thin * 0.5) * (covered > 0.35 ? 0.2 : 1) / (1 + 0.03 * crumbs);
    if (!best || score > best.score)
      best = { ...r, threshold, style: c.style, scale, thin: th.thin * scale, thick: th.thick * scale, rooms, score };
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
  const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null };
  walls.forEach((x, i) => insertWall(b, { id: `t${i}`, levelId: b.levels[0].id, a: x.a, b: x.b, thickness: x.thickness, height: 2.5, kind: 'cloison', finish: { gauche: null, droite: null } }));
  const rooms = detectRooms(b);
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
