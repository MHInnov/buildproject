import { background, luminance, otsu, type Bitmap } from './vectorize';

/** Conduit repéré sur un plan, en pixels : le vide du conduit et la maçonnerie pleine qui l'entoure. */
export interface FluePx {
  flue: { x0: number; y0: number; x1: number; y1: number };
  mass: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Conduits de cheminée : sur un plan, un petit carré (15 à 45 cm) barré d'une diagonale — un triangle noirci —
 * au cœur d'une maçonnerie dessinée pleine. On cherche les vides blancs fermés de cette taille, presque carrés,
 * dont l'encre se range d'un seul côté d'une diagonale, entourés de noir.
 * `m` : mètres par pixel.
 */
/** Encre d'un plan (trait, même adouci par un scan) : 1 = encre. */
export function inkMask(bmp: Bitmap): Uint8Array {
  const lum = luminance(bmp);
  const t = Math.max(otsu(lum), background(lum) - 60);
  const ink = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < lum.length; i++) ink[i] = lum[i] <= t ? 1 : 0;
  return ink;
}

export function findFlues(bmp: Bitmap, m: number): FluePx[] {
  const { width: w, height: h } = bmp;
  const ink = inkMask(bmp);
  const lo = Math.round(0.12 / m);
  const hi = Math.round(0.5 / m);
  // Composantes blanches (4-connexité), bornées en taille
  const label = new Int32Array(w * h).fill(-1);
  const out: FluePx[] = [];
  const stack: number[] = [];
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (ink[s] || label[s] !== -1) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let n = 0;
    let open = false;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || ink[q] || label[q] !== -1) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    id++;
    // (le fond de page, une pièce : bien trop grands, on n'y revient pas)
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (open || bw < lo * 0.6 || bh < lo * 0.6 || bw > hi || bh > hi) continue;
    if (Math.max(bw, bh) < lo || Math.max(bw, bh) / Math.min(bw, bh) > 1.6) continue;
    // Le blanc et l'encre se partagent le carré de part et d'autre d'une diagonale
    let inkN = 0;
    let sideA = 0;
    let sideB = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!ink[y * w + x]) continue;
        inkN++;
        const u = (x - x0 + 0.5) / bw;
        const v = (y - y0 + 0.5) / bh;
        if (u > v) sideA++;
        if (u + v > 1) sideB++;
      }
    const fill = inkN / (bw * bh);
    if (fill < 0.2 || fill > 0.7) continue;
    const diag = Math.max(sideA, inkN - sideA, sideB, inkN - sideB) / Math.max(1, inkN);
    if (diag < 0.75) continue;
    if (n < 0.25 * bw * bh) continue;
    // Maçonnerie pleine autour : on élargit tant que le pourtour reste noir
    const ring = (a: number, b: number, c: number, d: number) => {
      let k = 0;
      let all = 0;
      for (let x = a; x <= c; x++)
        for (const y of [b, d]) {
          all++;
          if (x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x]) k++;
        }
      for (let y = b; y <= d; y++)
        for (const x of [a, c]) {
          all++;
          if (x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x]) k++;
        }
      return k / all;
    };
    // Un liseré blanc peut séparer le carré de la maçonnerie : on le franchit
    let g = 1;
    while (g <= 4 && ring(x0 - g, y0 - g, x1 + g, y1 + g) < 0.6) g++;
    if (g > 4) continue;
    const mass = { x0: x0 - g, y0: y0 - g, x1: x1 + g, y1: y1 + g };
    const grow = (key: 'x0' | 'y0' | 'x1' | 'y1') => {
      const lim = Math.round(0.6 / m);
      const dd = key === 'x0' || key === 'y0' ? -1 : 1;
      // part noire de la ligne (ou colonne) de pixels qu'on ajouterait à `at`
      const black = (at: number) => {
        let k = 0;
        let all = 0;
        if (key === 'x0' || key === 'x1')
          for (let y = mass.y0; y <= mass.y1; y++) {
            all++;
            if (at >= 0 && at < w && y >= 0 && y < h && ink[y * w + at]) k++;
          }
        else
          for (let x = mass.x0; x <= mass.x1; x++) {
            all++;
            if (x >= 0 && x < w && at >= 0 && at < h && ink[at * w + x]) k++;
          }
        return k / Math.max(1, all);
      };
      for (let i = 0; i < lim; i++) {
        const next = mass[key] + dd;
        if (black(next) >= 0.75) {
          mass[key] = next;
          continue;
        }
        // liseré blanc de 1 à 3 pixels entre le carré du conduit et la maçonnerie : on le franchit
        let jump = 0;
        for (let j = 2; j <= 4 && !jump; j++) if (black(mass[key] + dd * j) >= 0.75) jump = j;
        if (!jump) break;
        mass[key] += dd * jump;
      }
    };
    for (let r = 0; r < 2; r++) for (const key of ['x0', 'x1', 'y0', 'y1'] as const) grow(key);
    const flue = { x0, y0, x1, y1 };
    // La maçonnerie doit avoir une épaisseur de mur autour du conduit (pas un simple trait)
    const th = Math.min(flue.x0 - mass.x0, mass.x1 - flue.x1, flue.y0 - mass.y0, mass.y1 - flue.y1);
    if (th * m < 0.04) continue;
    out.push({ flue, mass });
  }
  return out;
}
