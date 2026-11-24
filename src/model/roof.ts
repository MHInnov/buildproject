import type { Building, Level, Point, Roof, Room } from './types';
import { levelById } from './levels';
import { pointInPolygon } from './geometry';

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

/** Cadre de la toiture : rectangle englobant les murs du niveau qui la porte. */
export function roofFrame(b: Building, roof: Roof | null = b.roof): RoofFrame | null {
  if (!roof) return null;
  const level = levelById(b, roof.levelId);
  if (!level) return null;
  const walls = b.walls.filter((w) => w.levelId === level.id);
  if (!walls.length) return null;
  const half = (w: (typeof walls)[number]) => w.thickness / 2;
  const minX = Math.min(...walls.map((w) => Math.min(w.a.x, w.b.x) - half(w)));
  const maxX = Math.max(...walls.map((w) => Math.max(w.a.x, w.b.x) + half(w)));
  const minY = Math.min(...walls.map((w) => Math.min(w.a.y, w.b.y) - half(w)));
  const maxY = Math.max(...walls.map((w) => Math.max(w.a.y, w.b.y) + half(w)));
  const wallTop = Math.max(...walls.map((w) => w.height));
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
      if (!pointInPolygon(p, room.polygon)) continue;
      all++;
      if (roofHeightAt(f, roof, p) >= threshold) ok++;
    }
  }
  return all ? (room.area * ok) / all : 0;
}
