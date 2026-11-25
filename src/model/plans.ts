/**
 * Plusieurs plans d'une même maison : calage des étages les uns sur les autres,
 * et lecture des coupes (hauteurs des niveaux, pente du toit).
 */
import { background, bands, close, fillNarrow, luminance, open, otsu, type Bitmap, type TracedWall } from './vectorize';
import type { RoofType } from './types';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Emprise des murs (axes), en mètres. */
export function footprint(walls: { a: { x: number; y: number }; b: { x: number; y: number } }[]): Box | null {
  if (!walls.length) return null;
  const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; thickness?: number };
const horizontal = (w: Seg) => Math.abs(w.a.y - w.b.y) < Math.abs(w.a.x - w.b.x);

/** Longueur de murs qui se superposent (même orientation, axes à moins de `tol`). */
export function overlap(walls: Seg[], ref: Seg[], dx: number, dy: number, k = 1, tol = 0.15): number {
  let total = 0;
  for (const w of walls) {
    const h = horizontal(w);
    const a = { x: w.a.x * k + dx, y: w.a.y * k + dy };
    const b = { x: w.b.x * k + dx, y: w.b.y * k + dy };
    const s0 = h ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const s1 = h ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const c = h ? a.y : a.x;
    let best = 0;
    for (const r of ref) {
      if (horizontal(r) !== h) continue;
      const rc = h ? r.a.y : r.a.x;
      if (Math.abs(rc - c) > tol) continue;
      const r0 = h ? Math.min(r.a.x, r.b.x) : Math.min(r.a.y, r.b.y);
      const r1 = h ? Math.max(r.a.x, r.b.x) : Math.max(r.a.y, r.b.y);
      best += Math.max(0, Math.min(s1, r1) - Math.max(s0, r0));
    }
    total += Math.min(best, s1 - s0);
  }
  return total;
}

export interface Alignment {
  dx: number;
  dy: number;
  /** Facteur d'échelle appliqué aux murs retracés (1 = inchangé). */
  k: number;
  /** Part des murs retracés qui retombent sur les murs de référence (0 à 1). */
  fit: number;
}

/**
 * Cale un étage retracé sur un niveau déjà connu (en général le rez-de-chaussée) : on essaie
 * d'aligner les coins et le centre des emprises, puis on affine au centimètre près.
 * Si `allowScale`, on essaie aussi de corriger l'échelle quand les deux emprises ont les mêmes proportions.
 */
export function alignWalls(walls: TracedWall[], ref: Seg[], allowScale = false): Alignment {
  const fb = footprint(walls);
  const rb = footprint(ref);
  const total = walls.reduce((s, w) => s + Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), 0) || 1;
  if (!fb || !rb) return { dx: 0, dy: 0, k: 1, fit: 0 };
  const scales = [1];
  if (allowScale) {
    const kx = (rb.x1 - rb.x0) / Math.max(0.01, fb.x1 - fb.x0);
    const ky = (rb.y1 - rb.y0) / Math.max(0.01, fb.y1 - fb.y0);
    const ok = (k: number) => k > 0.5 && k < 2 && Math.abs(k - 1) > 0.02;
    if (Math.abs(kx - ky) / Math.max(kx, ky) < 0.04) {
      if (ok((kx + ky) / 2)) scales.push((kx + ky) / 2);
    } else {
      // Un étage peut couvrir une partie seulement du rez-de-chaussée (combles sur une aile) : une seule
      // des deux dimensions donne alors l'échelle ; le recouvrement des murs départage.
      if (ok(kx)) scales.push(kx);
      if (ok(ky)) scales.push(ky);
    }
  }
  let best: Alignment = { dx: rb.x0 - fb.x0, dy: rb.y0 - fb.y0, k: 1, fit: -1 };
  for (const k of scales) {
    const cands = [
      [rb.x0 - fb.x0 * k, rb.y0 - fb.y0 * k],
      [rb.x1 - fb.x1 * k, rb.y0 - fb.y0 * k],
      [rb.x0 - fb.x0 * k, rb.y1 - fb.y1 * k],
      [rb.x1 - fb.x1 * k, rb.y1 - fb.y1 * k],
      [(rb.x0 + rb.x1) / 2 - ((fb.x0 + fb.x1) / 2) * k, (rb.y0 + rb.y1) / 2 - ((fb.y0 + fb.y1) / 2) * k],
    ];
    for (const [dx0, dy0] of cands) {
      // Affinage local : on décale de quelques centimètres autour du candidat
      let bx = dx0;
      let by = dy0;
      let bs = overlap(walls, ref, bx, by, k);
      for (const step of [0.08, 0.04, 0.02, 0.01]) {
        let improved = true;
        while (improved) {
          improved = false;
          for (const [ox, oy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
            const sc = overlap(walls, ref, bx + ox, by + oy, k, 0.06);
            if (sc > overlap(walls, ref, bx, by, k, 0.06) + 1e-6) {
              bx += ox;
              by += oy;
              improved = true;
            }
          }
        }
      }
      bs = overlap(walls, ref, bx, by, k) / (total * k);
      if (bs > best.fit + 1e-6) best = { dx: Math.round(bx * 100) / 100, dy: Math.round(by * 100) / 100, k, fit: bs };
    }
  }
  return best;
}

/**
 * Calage d'un étage dont l'échelle n'est qu'estimée : ses murs épais (façades, pignons) doivent retomber sur
 * des murs du niveau de référence. On cherche ensemble le facteur d'échelle (de 0,5 à 2) et la position, en
 * essayant de faire coïncider chaque mur épais avec chaque mur de même orientation de la référence.
 * Les cloisons de l'étage, qui ne suivent pas celles du dessous, n'interviennent pas.
 */
export function alignFacades(walls: TracedWall[], ref: Seg[]): Alignment {
  const none: Alignment = { dx: 0, dy: 0, k: 1, fit: 0 };
  if (!walls.length || !ref.length) return none;
  const len = (w: Seg) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
  // « Épais » : au moins 60 % de l'épaisseur des murs les plus épais (75e centile en longueur, pour ne pas
  // dépendre d'un seul mur surépais)
  const q75 = (ws: Seg[]) => {
    const xs = ws.map((w) => ({ t: w.thickness ?? 0, l: len(w) })).sort((m, n) => m.t - n.t);
    const tot = xs.reduce((s, x) => s + x.l, 0);
    let acc = 0;
    return xs.find((x) => (acc += x.l) >= 0.75 * tot)?.t ?? 0;
  };
  const tw = q75(walls);
  const thick = walls.filter((w) => w.thickness >= 0.6 * tw && len(w) >= 1);
  const total = thick.reduce((s, w) => s + len(w), 0);
  if (total <= 0) return none;
  const tr = q75(ref);
  const refThick = ref.filter((r) => (r.thickness ?? 0) >= 0.6 * tr && len(r) >= 1);
  const refTotal = refThick.reduce((s, w) => s + len(w), 0) || 1;
  const ax = (w: Seg) => (horizontal(w) ? w.a.y : w.a.x);
  const ends = (w: Seg) => (horizontal(w) ? [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)] : [Math.min(w.a.y, w.b.y), Math.max(w.a.y, w.b.y)]);
  // Les décalages candidats viennent des plus longs murs (assez pour fixer la position, sans tout essayer)
  const seeds = [...thick].sort((m, n) => len(n) - len(m)).slice(0, 6);
  const refH = ref.filter((r) => horizontal(r) && len(r) >= 1);
  const refV = ref.filter((r) => !horizontal(r) && len(r) >= 1);
  let best = none;
  for (let k = 0.5; k <= 2.0001; k *= 1.02) {
    // Décalages candidats sur chaque axe : axe contre axe (murs parallèles), ou bout contre bout
    const dys = new Set<number>();
    const dxs = new Set<number>();
    for (const w of seeds) {
      const h = horizontal(w);
      for (const r of h ? refH : refV) {
        const d = Math.round((ax(r) - ax(w) * k) * 20) / 20;
        (h ? dys : dxs).add(d);
      }
      const [w0, w1] = ends(w);
      for (const r of h ? refH : refV) {
        const [r0, r1] = ends(r);
        (h ? dxs : dys).add(Math.round((r0 - w0 * k) * 20) / 20);
        (h ? dxs : dys).add(Math.round((r1 - w1 * k) * 20) / 20);
      }
    }
    for (const dx of dxs)
      for (const dy of dys) {
        const fe = overlap(thick, ref, dx, dy, k, 0.12) / (total * k);
        if (fe < 0.5 || fe < best.fit * 0.8) continue;
        // … et réciproquement, les façades du dessous retrouvent celles de l'étage (sinon n'importe quelle
        // paire de murs à la bonne distance ferait l'affaire)
        const moved = thick.map((w) => ({ a: { x: w.a.x * k + dx, y: w.a.y * k + dy }, b: { x: w.b.x * k + dx, y: w.b.y * k + dy } }));
        const fr = overlap(refThick, moved, 0, 0, 1, 0.12) / refTotal;
        const fit = fe * (0.4 + 0.6 * fr);
        // à recouvrement égal, l'échelle la plus proche de l'estimation l'emporte
        if (fit > best.fit + 0.02 || (fit > best.fit - 0.02 && Math.abs(Math.log(k)) < Math.abs(Math.log(best.k)) && fit >= best.fit)) best = { dx, dy, k, fit };
      }
  }
  return { ...best, k: Math.round(best.k * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// Coupes
// ---------------------------------------------------------------------------

export interface SectionReading {
  /** Largeur du bâtiment coupé, en pixels. */
  widthPx: number;
  /** Planchers, du plus haut au plus bas : dessus et dessous de dalle, en pixels. */
  slabs: { top: number; bottom: number; length: number }[];
  roof: { type: RoofType; pitch: number } | null;
}

/** Lit une coupe : les planchers sont les bandes horizontales épaisses qui traversent le bâtiment. */
export function readSection(bmp: Bitmap): SectionReading | null {
  const { width: w, height: h } = bmp;
  const lum = luminance(bmp);
  const t = otsu(lum);
  const bg = background(lum);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) ink[i] = lum[i] <= Math.max(t, bg - 60) ? 1 : 0;
  // Éléments coupés : pleins, hachurés ou en contour
  const side = Math.max(w, h);
  const solid = open(fillNarrow(close(ink, w, h, 1), w, h, side / 30), w, h, 1);
  const found = bands(solid, w, h, true, Math.round(w * 0.12))
    .map((b) => ({ top: b.t0, bottom: b.t1 + 1, s: b.s, e: b.e, length: b.e - b.s + 1 }))
    .filter((b) => b.bottom - b.top >= 3 && b.bottom - b.top < h / 12);
  if (!found.length) return null;
  const longest = Math.max(...found.map((b) => b.length));
  // Planchers : au moins 60 % de la largeur du bâtiment ; on fusionne les bandes collées
  const slabs = found
    .filter((b) => b.length >= longest * 0.6)
    .sort((m, n) => m.top - n.top)
    .reduce<typeof found>((acc, b) => {
      const last = acc[acc.length - 1];
      if (last && b.top - last.bottom <= 2) {
        last.bottom = b.bottom;
        last.length = Math.max(last.length, b.length);
      } else acc.push({ ...b });
      return acc;
    }, []);
  if (slabs.length < 2) return null;
  const ref = slabs.reduce((m, b) => (b.length > m.length ? b : m));
  const xL = ref.s;
  const xR = ref.e;
  const widthPx = xR - xL + 1;
  // Toit : profil du trait le plus haut au-dessus du dernier plancher
  const topSlab = slabs[0];
  const profile: { x: number; y: number }[] = [];
  const yMin = Math.max(0, Math.round(topSlab.top - widthPx * 0.9));
  for (let x = xL; x <= xR; x += 2) {
    for (let y = yMin; y < topSlab.top - 2; y++)
      if (ink[y * w + x]) {
        profile.push({ x, y });
        break;
      }
  }
  const fit = (pts: { x: number; y: number }[]) => {
    if (pts.length < 5) return null;
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.x - mx) * (p.y - my);
      den += (p.x - mx) ** 2;
    }
    return den ? num / den : null;
  };
  let roof: SectionReading['roof'] = null;
  if (profile.length > 10) {
    const left = fit(profile.filter((p) => p.x > xL + widthPx * 0.1 && p.x < xL + widthPx * 0.4));
    const right = fit(profile.filter((p) => p.x > xL + widthPx * 0.6 && p.x < xL + widthPx * 0.9));
    if (left !== null && right !== null) {
      const deg = (s: number) => (Math.atan(Math.abs(s)) * 180) / Math.PI;
      const dl = deg(left);
      const dr = deg(right);
      if (dl < 4 && dr < 4) roof = { type: 'plat', pitch: 0 };
      // Image : y vers le bas. Montée à gauche (pente négative) et descente à droite : deux pans
      else if (left < 0 && right > 0 && dl >= 4 && dr >= 4) roof = { type: 'deux-pans', pitch: Math.round((dl + dr) / 2) };
      else roof = { type: 'monopente', pitch: Math.round(Math.max(dl, dr)) };
    }
  }
  return { widthPx, slabs: slabs.map(({ top, bottom, length }) => ({ top, bottom, length })), roof };
}

export interface Storey {
  /** Hauteur sous plafond (m). */
  height: number;
  /** Épaisseur du plancher au-dessus (m). */
  slab: number;
}

/**
 * Hauteurs des niveaux, du plus bas au plus haut. L'échelle de la coupe se déduit de la largeur
 * du bâtiment (longueur ou profondeur de l'emprise des plans) : on garde celle qui donne des
 * hauteurs d'étage plausibles.
 */
export function storeysFromSection(sec: SectionReading, planSizes: number[], fallbackScale?: number): { scale: number; storeys: Storey[] } {
  const scales = [...planSizes.filter((s) => s > 1).map((s) => s / sec.widthPx), ...(fallbackScale ? [fallbackScale] : [])];
  const bottomUp = [...sec.slabs].reverse();
  const storeysAt = (k: number): Storey[] =>
    bottomUp.slice(0, -1).map((low, i) => {
      const up = bottomUp[i + 1];
      return { height: Math.round((low.top - up.bottom) * k * 100) / 100, slab: Math.round((up.bottom - up.top) * k * 100) / 100 };
    });
  let best = { scale: scales[0] ?? 0.01, storeys: storeysAt(scales[0] ?? 0.01), score: -Infinity };
  for (const k of scales) {
    const st = storeysAt(k);
    const score = st.reduce((s, x) => s - Math.max(0, 2.2 - x.height) - Math.max(0, x.height - 3.4) - Math.max(0, x.slab - 0.45), 0);
    if (score > best.score) best = { scale: k, storeys: st, score };
  }
  return { scale: best.scale, storeys: best.storeys };
}

// ---------------------------------------------------------------------------
// Reconnaître le contenu d'un plan d'après son nom ou ses textes
// ---------------------------------------------------------------------------

export type PlanKind = 'cave' | 'rdc' | 'etage1' | 'etage2' | 'etage3' | 'combles' | 'coupe' | 'ignorer';

export const PLAN_KIND_LABELS: Record<PlanKind, string> = {
  cave: 'Cave / sous-sol',
  rdc: 'Rez-de-chaussée',
  etage1: '1er étage',
  etage2: '2e étage',
  etage3: '3e étage',
  combles: 'Combles',
  coupe: 'Coupe',
  ignorer: 'Ignorer (façade, situation…)',
};

/** Devine le contenu d'après le nom du fichier ou les textes de la page (cartouche). */
export function guessKind(text: string): PlanKind | null {
  const t = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (/\bcoupe|\bsection|\bcoupe\s*[a-z]{1,2}\b|\b[a-z]-[a-z]\b/.test(t)) return 'coupe';
  if (/facade|elevation|situation|implantation|toiture vue/.test(t)) return 'ignorer';
  if (/sous[- ]?sol|\bcave|\bs-?sol|\br\s*-\s*1\b/.test(t)) return 'cave';
  if (/comble|grenier|mansard/.test(t)) return 'combles';
  if (/\br\s*\+\s*3\b|3e(me)?\s*etage|troisieme/.test(t)) return 'etage3';
  if (/\br\s*\+\s*2\b|2e(me)?\s*etage|deuxieme|second etage/.test(t)) return 'etage2';
  if (/\br\s*\+\s*1\b|1er\s*etage|premier etage|\betage\b|\bniveau 1\b/.test(t)) return 'etage1';
  if (/rez|\brdc\b|\br\s*\+\s*0\b|\bniveau 0\b|ground floor|plan du bas/.test(t)) return 'rdc';
  return null;
}

/**
 * Échelle du dessin écrite dans le cartouche : « 1/50 », « 1:100 », « éch. 1/50 ». Renvoie le dénominateur.
 * Si plusieurs échelles sont citées, on prend la plus fréquente.
 */
export function parseDrawingScale(text: string): number | null {
  const counts = new Map<number, number>();
  for (const m of text.matchAll(/(?:^|[^\d.,])1\s*[/:]\s*(\d{2,3})(?![\d.,])/g)) {
    const d = Number(m[1]);
    if ([20, 25, 50, 75, 100, 125, 200, 250, 500].includes(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best)!) best = d;
  return best;
}

/** Mètres par pixel d'une page PDF rendue : `pxPerPt` pixels par point (1 pt = 1/72 pouce), dessin au 1/`denominator`. */
export function pdfScale(pxPerPt: number, denominator: number): number {
  return (0.0254 / 72 / pxPerPt) * denominator;
}
