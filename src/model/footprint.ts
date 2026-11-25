/**
 * Emprise d'un niveau : contour extérieur de ses murs (faces extérieures), pour poser le plancher de
 * l'étage au-dessus sur toute la surface, murs compris, et pas seulement dans les pièces.
 */
import type { Point, Wall } from './types';

const CELL = 0.05;

/**
 * Contours extérieurs (un par bloc de bâtiment) des murs donnés. Les ouvertures de moins de 1,2 m laissées
 * dans l'enveloppe (porte non refermée, mur mal lu) sont refermées.
 */
export function levelOutline(walls: Pick<Wall, 'a' | 'b' | 'thickness'>[]): Point[][] {
  if (walls.length < 3) return [];
  const pad = 1;
  const x0 = Math.min(...walls.map((w) => Math.min(w.a.x, w.b.x) - w.thickness)) - pad;
  const y0 = Math.min(...walls.map((w) => Math.min(w.a.y, w.b.y) - w.thickness)) - pad;
  const x1 = Math.max(...walls.map((w) => Math.max(w.a.x, w.b.x) + w.thickness)) + pad;
  const y1 = Math.max(...walls.map((w) => Math.max(w.a.y, w.b.y) + w.thickness)) + pad;
  const W = Math.ceil((x1 - x0) / CELL);
  const H = Math.ceil((y1 - y0) / CELL);
  if (W * H > 4e6) return [];
  const m = new Uint8Array(W * H);
  // Murs : rectangle épais, de face extérieure à face extérieure aux bouts
  for (const w of walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    if (L < 1e-3) continue;
    const ux = (w.b.x - w.a.x) / L;
    const uy = (w.b.y - w.a.y) / L;
    const h = w.thickness / 2;
    const ext = h;
    const xs = [w.a.x, w.b.x];
    const ys = [w.a.y, w.b.y];
    const gx0 = Math.max(0, Math.floor((Math.min(...xs) - h - ext - x0) / CELL));
    const gx1 = Math.min(W - 1, Math.ceil((Math.max(...xs) + h + ext - x0) / CELL));
    const gy0 = Math.max(0, Math.floor((Math.min(...ys) - h - ext - y0) / CELL));
    const gy1 = Math.min(H - 1, Math.ceil((Math.max(...ys) + h + ext - y0) / CELL));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = x0 + (gx + 0.5) * CELL - w.a.x;
        const py = y0 + (gy + 0.5) * CELL - w.a.y;
        const t = px * ux + py * uy;
        const d = Math.abs(-px * uy + py * ux);
        if (t >= -ext && t <= L + ext && d <= h + 1e-6) m[gy * W + gx] = 1;
      }
    }
  }
  // Fermeture (carré de 0,6 m de demi-côté) : dilatation, remplissage depuis l'extérieur, érosion
  const r = Math.round(0.6 / CELL);
  const dil = chebyshev(m, W, H, 1);
  const grown = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) grown[i] = dil[i] <= r ? 1 : 0;
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (outside[i] || grown[i]) continue;
    outside[i] = 1;
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  const dOut = chebyshev(outside, W, H, 1);
  const fill = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fill[i] = (dOut[i] > r || m[i]) && !outside[i] ? 1 : 0;
  return traceOuter(fill, W, H).map((loop) => simplify(loop.map(([gx, gy]) => ({ x: Math.round((x0 + gx * CELL) * 100) / 100, y: Math.round((y0 + gy * CELL) * 100) / 100 }))));
}

/** Distance (en cellules, norme du max) à la plus proche cellule valant `v`. */
function chebyshev(m: Uint8Array, W: number, H: number, v: number): Int32Array {
  const INF = 1 << 29;
  const d = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = m[i] === v ? 0 : INF;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let b = d[i];
      if (x > 0) b = Math.min(b, d[i - 1] + 1);
      if (y > 0) {
        b = Math.min(b, d[i - W] + 1);
        if (x > 0) b = Math.min(b, d[i - W - 1] + 1);
        if (x < W - 1) b = Math.min(b, d[i - W + 1] + 1);
      }
      d[i] = b;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let b = d[i];
      if (x < W - 1) b = Math.min(b, d[i + 1] + 1);
      if (y < H - 1) {
        b = Math.min(b, d[i + W] + 1);
        if (x < W - 1) b = Math.min(b, d[i + W + 1] + 1);
        if (x > 0) b = Math.min(b, d[i + W - 1] + 1);
      }
      d[i] = b;
    }
  return d;
}

/** Contours extérieurs des zones pleines, en coins de cellules ; les contours de trous sont écartés. */
function traceOuter(fill: Uint8Array, W: number, H: number): [number, number][][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H ? fill[y * W + x] : 0);
  // Arêtes orientées (plein à gauche en sens direct dans un repère y vers le bas) : de sommet à sommet
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => y * (W + 1) + x;
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const k = key(ax, ay);
    if (!next.has(k)) next.set(k, []);
    next.get(k)!.push(key(bx, by));
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!fill[y * W + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  const loops: [number, number][][] = [];
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop: [number, number][] = [];
      let k = start;
      let guard = 0;
      do {
        loop.push([k % (W + 1), Math.floor(k / (W + 1))]);
        const outs = next.get(k)!;
        const n = outs.pop()!;
        if (!outs.length) next.delete(k);
        k = n;
      } while (k !== start && next.has(k) && ++guard < 1e6);
      // Aire signée (y vers le bas) : positive pour un contour extérieur tracé dans ce sens
      let a = 0;
      for (let i = 0; i < loop.length; i++) {
        const [px, py] = loop[i];
        const [qx, qy] = loop[(i + 1) % loop.length];
        a += px * qy - qx * py;
      }
      if (a > 0 && Math.abs(a) / 2 > 4 / (CELL * CELL)) loops.push(loop);
    }
  }
  return loops;
}

/** Retire les points alignés, puis simplifie (Douglas-Peucker, 4 cm). */
function simplify(poly: Point[]): Point[] {
  const keep = poly.filter((p, i) => {
    const a = poly[(i + poly.length - 1) % poly.length];
    const b = poly[(i + 1) % poly.length];
    return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) > 1e-9;
  });
  if (keep.length < 4) return keep;
  const dp = (pts: Point[], eps: number): Point[] => {
    if (pts.length < 3) return pts;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let best = 0;
    let bi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i].x - a.x) * (b.y - a.y) - (pts[i].y - a.y) * (b.x - a.x)) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best <= eps) return [a, b];
    return [...dp(pts.slice(0, bi + 1), eps).slice(0, -1), ...dp(pts.slice(bi), eps)];
  };
  // Coupe le contour en deux au point le plus éloigné du premier, pour que Douglas-Peucker garde les coins
  let far = 0;
  for (let i = 1; i < keep.length; i++) if (Math.hypot(keep[i].x - keep[0].x, keep[i].y - keep[0].y) > Math.hypot(keep[far].x - keep[0].x, keep[far].y - keep[0].y)) far = i;
  const out = [...dp(keep.slice(0, far + 1), 0.04).slice(0, -1), ...dp([...keep.slice(far), keep[0]], 0.04).slice(0, -1)];
  return out;
}
