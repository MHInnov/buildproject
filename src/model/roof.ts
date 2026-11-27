import type { Building, Level, Point, Roof, RoofWing, Room } from './types';
import { levelOutline } from './footprint';
import { levelBelow, levelById } from './levels';
import { inRoom } from './geometry';

export interface RoofFrame {
  /** Emprise extérieure des murs (sans débord). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Altitude du bas de la toiture (haut des murs du niveau porteur). */
  base: number;
  /** Hauteur du faîtage au-dessus de la base. */
  rise: number;
  level: Level;
}

/**
 * Cadre de la toiture : rectangle englobant les murs du niveau qui la porte et ceux du niveau juste en
 * dessous (des combles ont leurs murs bas en retrait des façades : le toit couvre toute la maison).
 */
export function roofFrame(b: Building, roof: Roof | null = b.roof): RoofFrame | null {
  if (!roof) return null;
  const level = levelById(b, roof.levelId);
  if (!level) return null;
  const walls = b.walls.filter((w) => w.levelId === level.id);
  if (!walls.length) return null;
  const below = levelBelow(b, level.id);
  const all = roof.eave != null && below ? [...walls, ...b.walls.filter((w) => w.levelId === below.id)] : walls;
  const half = (w: (typeof walls)[number]) => w.thickness / 2;
  const bx = roof.bounds;
  const minX = bx ? bx.x0 : Math.min(...all.map((w) => Math.min(w.a.x, w.b.x) - half(w)));
  const maxX = bx ? bx.x1 : Math.max(...all.map((w) => Math.max(w.a.x, w.b.x) + half(w)));
  const minY = bx ? bx.y0 : Math.min(...all.map((w) => Math.min(w.a.y, w.b.y) - half(w)));
  const maxY = bx ? bx.y1 : Math.max(...all.map((w) => Math.max(w.a.y, w.b.y) + half(w)));
  const wallTop = roof.eave ?? Math.max(...walls.map((w) => w.height));
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  let rise = 0;
  if (roof.type === 'deux-pans') rise = ((roof.ridge === 'x' ? spanY : spanX) / 2) * t;
  else if (roof.type === 'quatre-pans') rise = (Math.min(spanX, spanY) / 2) * t;
  else if (roof.type === 'monopente') rise = (roof.ridge === 'x' ? spanY : spanX) * t;
  return { minX, maxX, minY, maxY, base: level.elevation + wallTop, rise, level };
}

/** Surface de couverture (débords compris), en m². Pour une pente unique, surface au sol ÷ cos(pente). */
export function roofArea(b: Building, roof: Roof | null = b.roof): number {
  const f = roofFrame(b, roof);
  if (!f || !roof) return 0;
  const o = roof.overhang;
  const projected = (f.maxX - f.minX + 2 * o) * (f.maxY - f.minY + 2 * o);
  return roof.type === 'plat' ? projected : projected / Math.cos((roof.pitch * Math.PI) / 180);
}

/** Surface des rampants à isoler (sans les débords), en m². */
export function roofInsulationArea(b: Building, roof: Roof | null = b.roof): number {
  const f = roofFrame(b, roof);
  if (!f || !roof) return 0;
  const projected = (f.maxX - f.minX) * (f.maxY - f.minY);
  return roof.type === 'plat' ? projected : projected / Math.cos((roof.pitch * Math.PI) / 180);
}

/** Hauteur libre sous la toiture en un point, mesurée depuis le sol du niveau porteur. */
export function roofHeightAt(f: RoofFrame, roof: Roof, p: Point): number {
  const wallTop = f.base - f.level.elevation;
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const dx = Math.min(p.x - f.minX, f.maxX - p.x);
  const dy = Math.min(p.y - f.minY, f.maxY - p.y);
  switch (roof.type) {
    case 'deux-pans':
      return wallTop + (roof.ridge === 'x' ? dy : dx) * t;
    case 'quatre-pans':
      return wallTop + Math.min(dx, dy) * t;
    case 'monopente':
      return wallTop + (roof.ridge === 'x' ? p.y - f.minY : p.x - f.minX) * t;
    default:
      return wallTop;
  }
}

/**
 * Surface d'une pièce sous toiture où la hauteur libre dépasse un seuil (1,80 m par défaut),
 * calculée par échantillonnage tous les 10 cm.
 */
export function areaAboveHeight(b: Building, room: Room, threshold = 1.8): number | null {
  const roof = b.roof;
  if (!roof || roof.type === 'plat' || room.label.levelId !== roof.levelId) return null;
  const f = roofFrame(b, roof);
  if (!f) return null;
  const step = 0.1;
  const xs = room.polygon.map((p) => p.x);
  const ys = room.polygon.map((p) => p.y);
  let ok = 0;
  let all = 0;
  for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
      const p = { x, y };
      if (!inRoom(p, room)) continue;
      all++;
      if (roofHeightAt(f, roof, p) >= threshold) ok++;
    }
  }
  return all ? (room.area * ok) / all : 0;
}

/** Épaisseur de la toiture (couverture, chevrons, plaques) sous le dessus du pan, mesurée perpendiculairement. */
export const ROOF_DEPTH = 0.3;

/** Toit à pans dont une fenêtre de toit peut percer le rampant. */
export const isSloped = (roof: Roof | null | undefined): roof is Roof => !!roof && (roof.type === 'deux-pans' || roof.type === 'monopente');

/** Épaisseur des murs de façade du niveau qui porte le toit (ou du dessous), pour situer leur face intérieure. */
function facadeThickness(b: Building, roof: Roof): number {
  const level = levelById(b, roof.levelId);
  const below = level ? levelBelow(b, level.id) : null;
  const thick = b.walls.filter((w) => (w.levelId === roof.levelId || w.levelId === below?.id) && w.thickness >= 0.15).map((w) => w.thickness);
  if (!thick.length) return 0.3;
  thick.sort((p, q) => p - q);
  return thick[Math.floor(thick.length / 2)];
}

/**
 * Étage sous combles : hauteur, à l'intérieur, où le rampant rencontre la face intérieure des murs de façade
 * côté égout (murs extérieurs « en partie sous le toit », jambettes). Se déduit de la hauteur d'égout.
 */
export function kneeHeight(b: Building, roof: Roof = b.roof!): number | null {
  if (!isSloped(roof) || roof.eave == null) return null;
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const drop = ROOF_DEPTH / Math.cos((roof.pitch * Math.PI) / 180);
  return Math.round((roof.eave + facadeThickness(b, roof) * t - drop) * 100) / 100;
}

/** Hauteur d'égout qui donne cette hauteur intérieure des murs de façade sous le rampant. */
export function eaveForKnee(b: Building, roof: Roof, knee: number): number {
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const drop = ROOF_DEPTH / Math.cos((roof.pitch * Math.PI) / 180);
  return Math.round((knee - facadeThickness(b, roof) * t + drop) * 100) / 100;
}

/** Hauteur réelle (dans la pente) d'une fenêtre de toit dont la longueur projetée sur le plan est `length`. */
export const roofWindowHeight = (roof: Roof, length: number) => length / Math.cos((roof.pitch * Math.PI) / 180);
/** Longueur projetée sur le plan d'une fenêtre de toit de hauteur `h` dans la pente. */
export const roofWindowLength = (roof: Roof, h: number) => Math.round(h * Math.cos((roof.pitch * Math.PI) / 180) * 1000) / 1000;

/**
 * Place une fenêtre de toit au plus près de `p`, entièrement dans un seul pan : entre l'égout et le faîtage,
 * à 20 cm au moins de chacun, et entre les rives. Renvoie null hors du toit ou si le pan est trop court.
 */
export function placeRoofWindow(b: Building, p: Point, width: number, length: number, roof: Roof | null = b.roof): Point | null {
  if (!isSloped(roof)) return null;
  const f = roofFrame(b, roof);
  if (!f) return null;
  const alongX = roof.ridge === 'x';
  // u : le long du faîtage ; c : en travers (dans le sens de la pente)
  const [u, c] = alongX ? [p.x, p.y] : [p.y, p.x];
  const [u0, u1] = alongX ? [f.minX, f.maxX] : [f.minY, f.maxY];
  const [c0, c1] = alongX ? [f.minY, f.maxY] : [f.minX, f.maxX];
  if (u < u0 - 0.5 || u > u1 + 0.5 || c < c0 - 0.5 || c > c1 + 0.5) return null;
  const m = 0.2;
  let lo = c0;
  let hi = c1;
  if (roof.type === 'deux-pans') {
    const mid = (c0 + c1) / 2;
    if (c < mid) hi = mid;
    else lo = mid;
  }
  if (hi - lo < length + 2 * m || u1 - u0 < width + 2 * m) return null;
  const cc = Math.min(hi - m - length / 2, Math.max(lo + m + length / 2, c));
  const uu = Math.min(u1 - m - width / 2, Math.max(u0 + m + width / 2, u));
  const r = (n: number) => Math.round(n * 100) / 100;
  return alongX ? { x: r(uu), y: r(cc) } : { x: r(cc), y: r(uu) };
}

/** Rectangle d'une fenêtre de toit sur le plan (projection) : largeur le long du faîtage. */
export function roofWindowRect(roof: Roof, w: { x: number; y: number; width: number; length: number }): { x: number; y: number; w: number; h: number } {
  const [dx, dy] = roof.ridge === 'x' ? [w.width, w.length] : [w.length, w.width];
  return { x: w.x - dx / 2, y: w.y - dy / 2, w: dx, h: dy };
}

/**
 * Toit principal et avancées : sur l'emprise des niveaux couverts par le toit, le corps principal est la
 * bande (le long du faîtage) occupée sur au moins la moitié de la longueur ; ce qui dépasse sur le côté
 * d'au moins 80 cm, sur 2 m de large, est une avancée avec son propre toit, faîtage perpendiculaire.
 * Un retrait (renfoncement) reste sous le toit principal.
 */
export function detectWings(b: Building, roof: Roof): { bounds: NonNullable<Roof['bounds']>; wings: RoofWing[] } | null {
  const level = levelById(b, roof.levelId);
  if (!level || roof.type !== 'deux-pans') return null;
  const levels = new Set(b.levels.filter((l) => l.elevation <= level.elevation + 0.01).map((l) => l.id));
  const polys = levelOutline(b.walls.filter((w) => levels.has(w.levelId)));
  if (!polys.length) return null;
  const pts = polys.flat();
  const X0 = Math.min(...pts.map((p) => p.x));
  const X1 = Math.max(...pts.map((p) => p.x));
  const Y0 = Math.min(...pts.map((p) => p.y));
  const Y1 = Math.max(...pts.map((p) => p.y));
  const C = 0.1;
  const nx = Math.ceil((X1 - X0) / C);
  const ny = Math.ceil((Y1 - Y0) / C);
  if (nx * ny > 1e6) return null;
  const inside = (p: Point) =>
    polys.some((poly) => {
      let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const c = poly[j];
        if (a.y > p.y !== c.y > p.y && p.x < ((c.x - a.x) * (p.y - a.y)) / (c.y - a.y) + a.x) ins = !ins;
      }
      return ins;
    });
  const m = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m[j * nx + i] = inside({ x: X0 + (i + 0.5) * C, y: Y0 + (j + 0.5) * C }) ? 1 : 0;
  // Faîtage le long de la grande dimension du corps principal
  const along = roof.ridge === 'y' ? 'y' : 'x';
  const nA = along === 'y' ? ny : nx;
  const nW = along === 'y' ? nx : ny;
  const at = (a: number, w: number) => (along === 'y' ? m[a * nx + w] : m[w * nx + a]);
  const cover = Array.from({ length: nW }, (_, w) => {
    let n = 0;
    for (let a = 0; a < nA; a++) n += at(a, w);
    return n / nA;
  });
  let w0 = cover.findIndex((c) => c >= 0.5);
  let w1 = nW - 1 - [...cover].reverse().findIndex((c) => c >= 0.5);
  if (w0 < 0 || w1 <= w0) return null;
  const wings: RoofWing[] = [];
  const toX = (i: number) => X0 + i * C;
  const toY = (j: number) => Y0 + j * C;
  // Dépassements de part et d'autre du corps principal
  for (const [from, to, attach] of [
    [0, w0, 'hi'],
    [w1 + 1, nW, 'lo'],
  ] as const) {
    if (to - from < 8) continue;
    // Tranches le long du faîtage occupées par le dépassement
    let a = 0;
    while (a < nA) {
      const occ = (k: number) => {
        let n = 0;
        for (let w = from; w < to; w++) n += at(k, w);
        return n / (to - from) >= 0.5;
      };
      if (!occ(a)) {
        a++;
        continue;
      }
      const s = a;
      while (a < nA && occ(a)) a++;
      if (a - s < 20) continue;
      const r = { a0: s, a1: a, w0: from, w1: to };
      const wing: RoofWing =
        along === 'y'
          ? { x0: toX(r.w0), x1: toX(r.w1), y0: toY(r.a0), y1: toY(r.a1), ridge: 'x', attach: attach === 'hi' ? 'x1' : 'x0' }
          : { x0: toX(r.a0), x1: toX(r.a1), y0: toY(r.w0), y1: toY(r.w1), ridge: 'y', attach: attach === 'hi' ? 'y1' : 'y0' };
      wings.push(wing);
    }
  }
  const bounds = along === 'y' ? { x0: toX(w0), x1: toX(w1 + 1), y0: Y0, y1: Y1 } : { x0: X0, x1: X1, y0: toY(w0), y1: toY(w1 + 1) };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const round = <T extends { x0: number; x1: number; y0: number; y1: number }>(o: T): T => ({ ...o, x0: r2(o.x0), x1: r2(o.x1), y0: r2(o.y0), y1: r2(o.y1) });
  // Les avancées dans le sens du faîtage (pignon prolongé) ne sont pas des ailes : bornes sur la bande pleine
  w0 = Math.max(0, w0);
  w1 = Math.min(nW - 1, w1);
  return { bounds: round(bounds), wings: wings.map(round) };
}
