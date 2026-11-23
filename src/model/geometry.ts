import type { Building, Opening, Point, Room, RoomLabel, Wall, WallSide } from './types';

export const EPS = 0.01; // 1 cm

export const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
export const samePoint = (p: Point, q: Point, eps = EPS) => dist(p, q) < eps;
export const wallLength = (w: Wall) => dist(w.a, w.b);

export function lerp(p: Point, q: Point, t: number): Point {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

/** Projection d'un point sur un segment : paramètre t (0..1) et distance. */
export function projectOnSegment(p: Point, a: Point, b: Point): { t: number; d: number; point: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, d: dist(p, a), point: a };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { t, d: dist(p, point), point };
}

/** Normale unitaire du côté « gauche » du mur (sens a → b). */
export function wallNormal(w: Wall, side: WallSide = 'gauche'): Point {
  const L = wallLength(w) || 1;
  const n = { x: -(w.b.y - w.a.y) / L, y: (w.b.x - w.a.x) / L };
  return side === 'gauche' ? n : { x: -n.x, y: -n.y };
}

export function signedArea(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function perimeter(poly: Point[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function centroid(poly: Point[]): Point {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Un point garanti à l'intérieur du polygone (centroïde, sinon recherche le long d'une ligne). */
export function interiorPoint(poly: Point[]): Point {
  const c = centroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const ys = poly.map((p) => p.y);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2 + 1e-4;
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
  }
  xs.sort((m, n) => m - n);
  return xs.length >= 2 ? { x: (xs[0] + xs[1]) / 2, y } : c;
}

const key = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

/** Identifiant stable d'une pièce sans étiquette, dérivé de sa position. */
export const autoRoomId = (p: Point) => `auto:${Math.round(p.x * 100)}:${Math.round(p.y * 100)}`;

export function parseAutoRoomId(id: string): Point | null {
  const m = /^auto:(-?\d+):(-?\d+)$/.exec(id);
  return m ? { x: Number(m[1]) / 100, y: Number(m[2]) / 100 } : null;
}

interface HalfEdge {
  from: string;
  to: string;
  wallId: string;
  angle: number;
  used: boolean;
}

/**
 * Détecte les pièces (faces fermées du graphe des murs).
 * Les murs doivent se rejoindre par leurs extrémités (le plan découpe les murs aux jonctions en T).
 */
export function detectRooms(building: Building): Room[] {
  const nodes = new Map<string, Point>();
  const out = new Map<string, HalfEdge[]>();
  for (const w of building.walls) {
    if (wallLength(w) < EPS) continue;
    const ka = key(w.a);
    const kb = key(w.b);
    if (ka === kb) continue;
    nodes.set(ka, w.a);
    nodes.set(kb, w.b);
    const ab: HalfEdge = { from: ka, to: kb, wallId: w.id, angle: Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x), used: false };
    const ba: HalfEdge = { from: kb, to: ka, wallId: w.id, angle: Math.atan2(w.a.y - w.b.y, w.a.x - w.b.x), used: false };
    if (!out.has(ka)) out.set(ka, []);
    if (!out.has(kb)) out.set(kb, []);
    out.get(ka)!.push(ab);
    out.get(kb)!.push(ba);
  }
  for (const list of out.values()) list.sort((m, n) => m.angle - n.angle);

  const faces: { poly: Point[]; wallIds: string[] }[] = [];
  for (const list of out.values()) {
    for (const start of list) {
      if (start.used) continue;
      const poly: Point[] = [];
      const wallIds: string[] = [];
      let e: HalfEdge = start;
      let guard = 0;
      while (!e.used && guard++ < 10000) {
        e.used = true;
        poly.push(nodes.get(e.from)!);
        wallIds.push(e.wallId);
        // À l'arrivée, on prend l'arête sortante qui suit (dans l'ordre angulaire) l'arête retour.
        const around = out.get(e.to)!;
        const back = Math.atan2(nodes.get(e.from)!.y - nodes.get(e.to)!.y, nodes.get(e.from)!.x - nodes.get(e.to)!.x);
        let idx = around.findIndex((h) => h.to === e.from && Math.abs(h.angle - back) < 1e-9);
        if (idx < 0) idx = 0;
        e = around[(idx - 1 + around.length) % around.length];
      }
      if (poly.length >= 3) faces.push({ poly, wallIds });
    }
  }

  const wallsById = new Map(building.walls.map((w) => [w.id, w]));
  const rooms: Room[] = [];
  const usedLabels = new Set<string>();
  for (const f of faces) {
    const poly = simplify(f.poly);
    const a = signedArea(poly);
    // Avec ce parcours, les faces intérieures ont une aire signée positive (repère y vers le bas).
    if (a <= 0.05) continue;
    const label = building.rooms.find((r) => !usedLabels.has(r.id) && pointInPolygon(r.at, poly));
    const at = interiorPoint(poly);
    const finalLabel: RoomLabel = label ?? { id: autoRoomId(at), at, name: 'Pièce', floorProductId: null };
    if (label) usedLabels.add(label.id);
    const uniqueWalls = [...new Set(f.wallIds)];
    // Surface intérieure approchée : on retire la demi-épaisseur des murs le long du périmètre.
    let inner = a;
    for (let i = 0; i < f.wallIds.length; i++) {
      const w = wallsById.get(f.wallIds[i]);
      if (!w) continue;
      inner -= dist(f.poly[i], f.poly[(i + 1) % f.poly.length]) * (w.thickness / 2);
    }
    rooms.push({ label: finalLabel, polygon: poly, area: Math.max(0, inner), perimeter: perimeter(poly), wallIds: uniqueWalls });
  }
  return rooms;
}

/** Retire les sommets alignés et les doublons consécutifs. */
function simplify(poly: Point[]): Point[] {
  const res: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i - 1 + poly.length) % poly.length];
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    if (samePoint(prev, cur)) continue;
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) < 1e-6) continue;
    res.push(cur);
  }
  return res.length >= 3 ? res : poly;
}

/** Côté du mur tourné vers la pièce, ou null si le mur n'en fait pas partie. */
export function wallSideFacingRoom(w: Wall, room: Room): WallSide | null {
  const mid = lerp(w.a, w.b, 0.5);
  for (const side of ['gauche', 'droite'] as WallSide[]) {
    const n = wallNormal(w, side);
    const p = { x: mid.x + n.x * (w.thickness / 2 + 0.05), y: mid.y + n.y * (w.thickness / 2 + 0.05) };
    if (pointInPolygon(p, room.polygon)) return side;
  }
  return null;
}

/** Surface d'une face de mur, ouvertures déduites (m²). */
export function wallFaceArea(w: Wall, openings: Opening[]): number {
  const holes = openings.filter((o) => o.wallId === w.id).reduce((s, o) => s + o.width * o.height, 0);
  return Math.max(0, wallLength(w) * w.height - holes);
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Coupe un mur en deux au point p. Les ouvertures sont réaffectées au bon tronçon.
 * Les identifiants des tronçons sont déterministes (id.1 et id.2).
 */
export function splitWall(b: Building, wallId: string, p: Point): void {
  const w = b.walls.find((x) => x.id === wallId);
  if (!w) return;
  const L = wallLength(w);
  const { t, point } = projectOnSegment(p, w.a, w.b);
  const cut = t * L;
  if (cut < EPS || L - cut < EPS) return;
  const w1: Wall = { ...w, id: `${w.id}.1`, b: point, finish: { ...w.finish } };
  const w2: Wall = { ...w, id: `${w.id}.2`, a: point, finish: { ...w.finish } };
  b.walls = b.walls.flatMap((x) => (x.id === wallId ? [w1, w2] : [x]));
  for (const o of b.openings) {
    if (o.wallId !== wallId) continue;
    if (o.offset <= cut) o.wallId = w1.id;
    else {
      o.wallId = w2.id;
      o.offset -= cut;
    }
  }
}

/** Ajoute un mur en créant les jonctions en T avec les murs existants. */
export function insertWall(b: Building, wall: Wall): void {
  // 1. Les extrémités du nouveau mur qui tombent au milieu d'un mur existant le coupent.
  for (const p of [wall.a, wall.b]) {
    for (const w of [...b.walls]) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.d < EPS * 2 && !samePoint(p, w.a) && !samePoint(p, w.b)) splitWall(b, w.id, p);
    }
  }
  // 2. Les extrémités de murs existants qui tombent au milieu du nouveau mur le coupent.
  const cuts: number[] = [];
  for (const w of b.walls) {
    for (const p of [w.a, w.b]) {
      const pr = projectOnSegment(p, wall.a, wall.b);
      if (pr.d < EPS * 2 && pr.t > 0.001 && pr.t < 0.999) cuts.push(pr.t);
    }
  }
  const ts = [...new Set(cuts.map((t) => Math.round(t * 1e4) / 1e4))].sort((m, n) => m - n);
  if (ts.length === 0) {
    b.walls.push(wall);
    return;
  }
  const bounds = [0, ...ts, 1];
  for (let i = 0; i < bounds.length - 1; i++) {
    b.walls.push({
      ...wall,
      id: `${wall.id}.${i + 1}`,
      a: lerp(wall.a, wall.b, bounds[i]),
      b: lerp(wall.a, wall.b, bounds[i + 1]),
      finish: { ...wall.finish },
    });
  }
}

export function cloneBuilding(b: Building): Building {
  return structuredClone(b);
}

/** Aimantation : extrémités de murs proches, puis grille. */
export function snapPoint(p: Point, b: Building, grid = 0.1, radius = 0.25): Point {
  let best: Point | null = null;
  let bestD = radius;
  for (const w of b.walls) {
    for (const q of [w.a, w.b]) {
      const d = dist(p, q);
      if (d < bestD) {
        best = q;
        bestD = d;
      }
    }
  }
  if (best) return { ...best };
  for (const w of b.walls) {
    const pr = projectOnSegment(p, w.a, w.b);
    if (pr.d < radius / 2) {
      // On glisse sur le mur, en arrondissant la position le long du mur à la grille.
      const L = wallLength(w);
      const along = Math.round((pr.t * L) / grid) * grid;
      return lerp(w.a, w.b, Math.max(0, Math.min(1, along / L)));
    }
  }
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

/** Bloque l'angle à 0/45/90° si le segment en est proche. */
export function snapAngle(a: Point, p: Point, toleranceDeg = 6): Point {
  const ang = Math.atan2(p.y - a.y, p.x - a.x);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(snapped - ang) > (toleranceDeg * Math.PI) / 180) return p;
  const L = dist(a, p);
  return { x: a.x + Math.cos(snapped) * L, y: a.y + Math.sin(snapped) * L };
}
