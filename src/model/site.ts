/**
 * Plan d'implantation (plan de masse) : la maison y est dessinée en noir plein, au milieu de sa parcelle
 * bordée de longs traits. On retrouve la maison (pour l'échelle et l'orientation, en la superposant à
 * l'emprise du rez-de-chaussée) et le contour de la parcelle (le jardin).
 */
import { luminance, otsu, type Bitmap } from './vectorize';
import type { Point } from './types';

export interface SiteReading {
  /** Image réduite sur laquelle les mesures sont faites (pixels). */
  width: number;
  height: number;
  /** Maison : masque plein (1 = maison) et boîte englobante, en pixels de l'image réduite. */
  house: Uint8Array;
  houseBox: { x0: number; y0: number; x1: number; y1: number };
  houseArea: number;
  /** Contour de la parcelle (pixels de l'image réduite), ou null s'il n'a pas pu être lu. */
  parcel: Point[] | null;
}

const MAX = 1000;

export function grey(bmp: Bitmap): { lum: Uint8Array; w: number; h: number } {
  const full = luminance(bmp);
  const k = Math.max(1, Math.max(bmp.width, bmp.height) / MAX);
  if (k === 1) return { lum: full, w: bmp.width, h: bmp.height };
  const w = Math.floor(bmp.width / k);
  const h = Math.floor(bmp.height / k);
  const lum = new Uint8Array(w * h);
  // Réduction au minimum (garde les traits fins)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let yy = Math.floor(y * k); yy < Math.min(bmp.height, Math.floor((y + 1) * k)); yy++)
        for (let xx = Math.floor(x * k); xx < Math.min(bmp.width, Math.floor((x + 1) * k)); xx++) m = Math.min(m, full[yy * bmp.width + xx]);
      lum[y * w + x] = m;
    }
  return { lum, w, h };
}

/** Distance (norme du max) au plus proche pixel blanc. */
function depth(ink: Uint8Array, w: number, h: number): Int32Array {
  const d = new Int32Array(w * h);
  const INF = 1 << 29;
  for (let i = 0; i < w * h; i++) d[i] = ink[i] ? INF : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let b = d[i];
      b = Math.min(b, x > 0 ? d[i - 1] + 1 : 1, y > 0 ? d[i - w] + 1 : 1);
      if (y > 0) b = Math.min(b, x > 0 ? d[i - w - 1] + 1 : 1, x < w - 1 ? d[i - w + 1] + 1 : 1);
      d[i] = b;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let b = d[i];
      b = Math.min(b, x < w - 1 ? d[i + 1] + 1 : 1, y < h - 1 ? d[i + w] + 1 : 1);
      if (y < h - 1) b = Math.min(b, x < w - 1 ? d[i + w + 1] + 1 : 1, x > 0 ? d[i + w - 1] + 1 : 1);
      d[i] = b;
    }
  return d;
}

/**
 * La maison en noir plein : la plus grande tache épaisse (pas un trait), compacte, loin des bords.
 * Renvoie null si la page n'en a pas (plan d'étage, coupe, façade…).
 */
function findHouse(ink: Uint8Array, w: number, h: number) {
  const R = Math.max(6, Math.round(Math.min(w, h) / 90));
  const d = depth(ink, w, h);
  const label = new Int32Array(w * h).fill(-1);
  let best: { pix: number[]; x0: number; y0: number; x1: number; y1: number } | null = null;
  let bestArea = 0;
  for (let i0 = 0; i0 < w * h; i0++) {
    if (d[i0] < R || label[i0] >= 0) continue;
    const pix: number[] = [];
    const st = [i0];
    label[i0] = i0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (st.length) {
      const i = st.pop()!;
      pix.push(i);
      const x = i % w;
      const y = (i - x) / w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && d[j] >= R && label[j] < 0) {
          label[j] = i0;
          st.push(j);
        }
      }
    }
    const bw = x1 - x0 + 1 + 2 * R;
    const bh = y1 - y0 + 1 + 2 * R;
    if (Math.max(bw, bh) / Math.min(bw, bh) > 4) continue; // bande de route, cartouche
    if (x0 - R < 3 || y0 - R < 3 || x1 + R > w - 4 || y1 + R > h - 4) continue;
    if (pix.length > bestArea) {
      bestArea = pix.length;
      best = { pix, x0, y0, x1, y1 };
    }
  }
  if (!best) return null;
  // Tache reconstituée : noyau épaissi de R, limité à l'encre
  const house = new Uint8Array(w * h);
  const core = new Uint8Array(w * h);
  for (const i of best.pix) core[i] = 1;
  const box = { x0: Math.max(0, best.x0 - R), y0: Math.max(0, best.y0 - R), x1: Math.min(w - 1, best.x1 + R), y1: Math.min(h - 1, best.y1 + R) };
  let area = 0;
  for (let y = box.y0; y <= box.y1; y++)
    for (let x = box.x0; x <= box.x1; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      let near = false;
      for (let yy = Math.max(box.y0, y - R); yy <= Math.min(box.y1, y + R) && !near; yy++)
        for (let xx = Math.max(box.x0, x - R); xx <= Math.min(box.x1, x + R); xx++)
          if (core[yy * w + xx]) {
            near = true;
            break;
          }
      if (near) {
        house[i] = 1;
        area++;
      }
    }
  if (area < w * h * 0.003) return null;
  return { house, box, area, R };
}

/** Pixel au bord d'un aplat (à 3 px d'un pixel profond) : ne vote pas non plus. */
function thickNear(d: Int32Array, w: number, h: number, i: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  for (let yy = Math.max(0, y - 3); yy <= Math.min(h - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(w - 1, x + 3); xx++) if (d[yy * w + xx] >= 4) return true;
  return false;
}

interface Line {
  /** Normale (cos, sin) et distance à l'origine : x·cos + y·sin = rho */
  c: number;
  s: number;
  rho: number;
}

/** Longs traits droits de la page (transformée de Hough, puis plus long tronçon continu sur la droite). */
export function longLines(ink: Uint8Array, w: number, h: number, minRun: number): Line[] {
  const NA = 360;
  const diag = Math.ceil(Math.hypot(w, h));
  const acc = new Int32Array(NA * (2 * diag + 1));
  const cs = Array.from({ length: NA }, (_, a) => Math.cos((a * Math.PI) / NA));
  const sn = Array.from({ length: NA }, (_, a) => Math.sin((a * Math.PI) / NA));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      for (let a = 0; a < NA; a++) acc[a * (2 * diag + 1) + Math.round(x * cs[a] + y * sn[a]) + diag]++;
    }
  const peaks: { a: number; r: number; v: number }[] = [];
  const W2 = 2 * diag + 1;
  for (let a = 0; a < NA; a++)
    for (let r = 0; r < W2; r++) {
      const v = acc[a * W2 + r];
      if (v < minRun * 0.7) continue;
      let max = true;
      for (let da = -3; da <= 3 && max; da++)
        for (let dr = -4; dr <= 4; dr++) {
          if (!da && !dr) continue;
          const aa = (a + da + NA) % NA;
          const rr = da + a < 0 || da + a >= NA ? W2 - 1 - (r + dr) : r + dr;
          if (rr < 0 || rr >= W2) continue;
          const u = acc[aa * W2 + rr];
          if (u > v || (u === v && (da < 0 || (da === 0 && dr < 0)))) {
            max = false;
            break;
          }
        }
      if (max) peaks.push({ a, r, v });
    }
  peaks.sort((m, n) => n.v - m.v);
  const out: (Line & { run: number })[] = [];
  for (const p of peaks.slice(0, 400)) {
    const line = { c: cs[p.a], s: sn[p.a], rho: p.r - diag };
    const run = longestRun(ink, w, h, line);
    if (run >= minRun) out.push({ ...line, run });
  }
  out.sort((m, n) => n.run - m.run);
  return out.slice(0, 28);
}

/** Points de la droite dans la page, de 1 px en 1 px. */
function along(line: Line, w: number, h: number): Point[] {
  const pts: Point[] = [];
  const dx = -line.s;
  const dy = line.c;
  const ox = line.c * line.rho;
  const oy = line.s * line.rho;
  const T = Math.hypot(w, h);
  for (let t = -T; t <= T; t++) {
    const x = ox + dx * t;
    const y = oy + dy * t;
    if (x >= 0 && y >= 0 && x < w && y < h) pts.push({ x, y });
  }
  return pts;
}

const inkNear = (ink: Uint8Array, w: number, h: number, x: number, y: number, r = 1) => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  for (let yy = yi - r; yy <= yi + r; yy++) for (let xx = xi - r; xx <= xi + r; xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h && ink[yy * w + xx]) return true;
  return false;
};

function longestRun(ink: Uint8Array, w: number, h: number, line: Line): number {
  let best = 0;
  let cur = 0;
  let gap = 0;
  for (const p of along(line, w, h)) {
    if (inkNear(ink, w, h, p.x, p.y)) {
      cur += 1 + gap;
      gap = 0;
      best = Math.max(best, cur);
    } else if (++gap > 4) {
      cur = 0;
      gap = 0;
    }
  }
  return best;
}

/** Polygone convexe des demi-plans (côté du point c) des droites données, ou null s'il est ouvert. */
function cell(lines: Line[], c: Point, w: number, h: number): Point[] | null {
  let poly: Point[] = [
    { x: -w, y: -h },
    { x: 2 * w, y: -h },
    { x: 2 * w, y: 2 * h },
    { x: -w, y: 2 * h },
  ];
  for (const l of lines) {
    const sgn = Math.sign(c.x * l.c + c.y * l.s - l.rho) || 1;
    const f = (p: Point) => sgn * (p.x * l.c + p.y * l.s - l.rho);
    const next: Point[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) next.push(a);
      if (fa * fb < 0) {
        const t = fa / (fa - fb);
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    poly = next;
    if (poly.length < 3) return null;
  }
  if (poly.some((p) => p.x < -2 || p.y < -2 || p.x > w + 1 || p.y > h + 1)) return null;
  return poly;
}

const areaOf = (p: Point[]) => Math.abs(p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0)) / 2;

/**
 * Tracé des côtés du polygone : part à l'encre du côté le moins tracé, et plus long trou (pixels).
 * Un côté de parcelle est un trait continu, à peine coupé par une cote ou un texte.
 */
export function edgeCoverage(poly: Point[], ink: Uint8Array, w: number, h: number): { cover: number; gap: number } {
  let cover = 1;
  let gap = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 4) continue;
    let hit = 0;
    let n = 0;
    let run = 0;
    for (let t = 3; t < L - 3; t += 1) {
      n++;
      if (inkNear(ink, w, h, a.x + ((b.x - a.x) * t) / L, a.y + ((b.y - a.y) * t) / L)) {
        hit++;
        run = 0;
      } else gap = Math.max(gap, ++run);
    }
    cover = Math.min(cover, n ? hit / n : 1);
  }
  return { cover, gap };
}

/**
 * Parcelle : le plus grand polygone convexe autour de la maison dont tous les côtés sont tracés d'un trait
 * continu. Les traits de cotation et le quadrillage, qui s'arrêtent en chemin, ne ferment pas de polygone plus grand.
 */
function findParcel(ink: Uint8Array, w: number, h: number, house: Uint8Array, houseBox: SiteReading['houseBox'], houseArea: number): Point[] | null {
  // Seuls les traits votent : ni la maison, ni les aplats (route, hachures serrées)
  const d = depth(ink, w, h);
  const free = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) free[i] = ink[i] && !house[i] && d[i] <= 2 && !thickNear(d, w, h, i) ? 1 : 0;
  const lines = longLines(free, w, h, Math.round(Math.min(w, h) * 0.12));
  const c = { x: (houseBox.x0 + houseBox.x1) / 2, y: (houseBox.y0 + houseBox.y1) / 2 };
  // Les droites qui traversent la maison ne bordent pas la parcelle
  const clear = lines.filter((l) => {
    const corners = [
      [houseBox.x0, houseBox.y0],
      [houseBox.x1, houseBox.y0],
      [houseBox.x1, houseBox.y1],
      [houseBox.x0, houseBox.y1],
    ].map(([x, y]) => Math.sign(x * l.c + y * l.s - l.rho));
    return corners.every((s) => s === corners[0]);
  });
  let best: Point[] | null = null;
  let bestArea = 0;
  const n = clear.length;
  const consider = (set: Line[]) => {
    const p = cell(set, c, w, h);
    if (!p || p.length !== set.length) return;
    const a = areaOf(p);
    if (a <= bestArea || a < houseArea * 2.5 || a > w * h * 0.9) return;
    const e = edgeCoverage(p, ink, w, h);
    if (e.cover < 0.75 || e.gap > Math.max(12, Math.min(w, h) * 0.035)) return;
    best = p;
    bestArea = a;
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++) {
        consider([clear[i], clear[j], clear[k]]);
        for (let l = k + 1; l < n; l++) {
          consider([clear[i], clear[j], clear[k], clear[l]]);
          if (n <= 22) for (let m = l + 1; m < n; m++) consider([clear[i], clear[j], clear[k], clear[l], clear[m]]);
        }
      }
  return best;
}

export function readSitePlan(bmp: Bitmap): SiteReading | null {
  const { lum, w, h } = grey(bmp);
  const t = Math.min(200, Math.max(100, otsu(lum)));
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = lum[i] < t ? 1 : 0;
  const found = findHouse(ink, w, h);
  if (!found) return null;
  const parcel = findParcel(ink, w, h, found.house, found.box, found.area);
  return { width: w, height: h, house: found.house, houseBox: found.box, houseArea: found.area, parcel };
}

/** Vrai si la page ressemble à un plan d'implantation (maison en noir plein). */
export function looksLikeSitePlan(bmp: Bitmap): boolean {
  const { lum, w, h } = grey(bmp);
  const t = Math.min(200, Math.max(100, otsu(lum)));
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = lum[i] < t ? 1 : 0;
  return !!findHouse(ink, w, h);
}

const inPoly = (p: Point, poly: Point[]) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

export interface SiteFit {
  /** Passage des pixels de l'image réduite au plan (mètres). */
  toPlan: (p: Point) => Point;
  /** Mètres par pixel. */
  scale: number;
  /** Recouvrement de la maison dessinée et de l'emprise du rez-de-chaussée (0 à 1). */
  overlap: number;
}

/**
 * Cale le plan d'implantation sur le rez-de-chaussée : la maison noire est tournée (son orientation sur la
 * page, puis par quarts de tour) et mise à l'échelle pour recouvrir au mieux l'emprise des murs.
 */
export function fitSite(r: SiteReading, outline: Point[][]): SiteFit | null {
  const out = outline.flat();
  if (out.length < 3) return null;
  const pts: Point[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt(r.houseArea / 4000)));
  for (let y = r.houseBox.y0; y <= r.houseBox.y1; y += step) for (let x = r.houseBox.x0; x <= r.houseBox.x1; x += step) if (r.house[y * r.width + x]) pts.push({ x, y });
  if (pts.length < 20) return null;
  // Orientation de la maison sur la page : boîte englobante la plus petite
  let theta = 0;
  let bestBox = Infinity;
  for (let a = 0; a < 90; a += 1) {
    const c = Math.cos((a * Math.PI) / 180);
    const s = Math.sin((a * Math.PI) / 180);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      const u = p.x * c - p.y * s;
      const v = p.x * s + p.y * c;
      x0 = Math.min(x0, u);
      x1 = Math.max(x1, u);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    }
    if ((x1 - x0) * (y1 - y0) < bestBox - 1e-6) {
      bestBox = (x1 - x0) * (y1 - y0);
      theta = a;
    }
  }
  const ox0 = Math.min(...out.map((p) => p.x));
  const ox1 = Math.max(...out.map((p) => p.x));
  const oy0 = Math.min(...out.map((p) => p.y));
  const oy1 = Math.max(...out.map((p) => p.y));
  const G = 0.1;
  const gw = Math.ceil((ox1 - ox0) / G) + 20;
  const gh = Math.ceil((oy1 - oy0) / G) + 20;
  const ref = new Uint8Array(gw * gh);
  let refN = 0;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const p = { x: ox0 + (gx - 10 + 0.5) * G, y: oy0 + (gy - 10 + 0.5) * G };
      if (outline.some((o) => inPoly(p, o))) {
        ref[gy * gw + gx] = 1;
        refN++;
      }
    }
  let best: SiteFit | null = null;
  for (let q = 0; q < 4; q++) {
    const ang = (theta * Math.PI) / 180 + (q * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const rot = (p: Point) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
    const rp = pts.map(rot);
    const bx0 = Math.min(...rp.map((p) => p.x));
    const bx1 = Math.max(...rp.map((p) => p.x));
    const by0 = Math.min(...rp.map((p) => p.y));
    const by1 = Math.max(...rp.map((p) => p.y));
    const kx = (ox1 - ox0) / Math.max(1, bx1 - bx0);
    const ky = (oy1 - oy0) / Math.max(1, by1 - by0);
    if (Math.max(kx, ky) / Math.min(kx, ky) > 1.3) continue;
    const k = Math.sqrt(kx * ky);
    const tx = (ox0 + ox1) / 2 - ((bx0 + bx1) / 2) * k;
    const ty = (oy0 + oy1) / 2 - ((by0 + by1) / 2) * k;
    const mine = new Uint8Array(gw * gh);
    let inter = 0;
    let mineN = 0;
    for (const p of rp) {
      const gx = Math.floor((p.x * k + tx - ox0) / G) + 10;
      const gy = Math.floor((p.y * k + ty - oy0) / G) + 10;
      if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
      // chaque point échantillonné couvre (step·k)² m²
      const cells = Math.max(1, Math.ceil((step * k) / G - 0.05));
      for (let yy = gy; yy < Math.min(gh, gy + cells); yy++)
        for (let xx = gx; xx < Math.min(gw, gx + cells); xx++) {
          const i = yy * gw + xx;
          if (mine[i]) continue;
          mine[i] = 1;
          mineN++;
          if (ref[i]) inter++;
        }
    }
    const overlap = inter / (refN + mineN - inter);
    if (!best || overlap > best.overlap) best = { toPlan: (p: Point) => { const v = rot(p); return { x: v.x * k + tx, y: v.y * k + ty }; }, scale: k, overlap };
  }
  return best && best.overlap >= 0.5 ? best : null;
}
