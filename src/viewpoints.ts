import { addFurniture, addOpening, replaceOpening, setRoomFloor, setWallFinish } from './actions';
import type { Catalog, Product } from './model/catalog';
import { detectRooms, dist, newId, inRoom, wallLength, wallNormal } from './model/geometry';
import { onLevel } from './model/levels';
import { applyOperations } from './model/operations';
import type { Building, Point, Viewpoint, Wall } from './model/types';
import { useStore } from './store';

export type PhotoTarget = 'sol' | 'mur' | 'porte' | 'fenetre' | 'meuble';

export const TARGET_LABELS: Record<PhotoTarget, string> = {
  sol: 'Sol',
  mur: 'Mur',
  porte: 'Porte',
  fenetre: 'Fenêtre',
  meuble: 'Meuble ou sanitaire',
};

export const TARGET_CATEGORIES: Record<PhotoTarget, Product['category'][]> = {
  sol: ['sol'],
  mur: ['peinture', 'mur', 'faience'],
  porte: ['porte'],
  fenetre: ['fenetre'],
  meuble: ['meuble', 'escalier'],
};

/**
 * Rayon issu d'un point de la photo.
 * La photo est supposée prise à l'horizontale (appareil droit) : u, v de 0 à 1 depuis le coin haut gauche.
 */
export function photoRay(v: Viewpoint, u: number, w: number, aspect: number): { yaw: number; pitch: number } {
  const tanH = Math.tan((v.fov * Math.PI) / 360);
  const tanV = tanH / aspect;
  const yaw = (v.direction * Math.PI) / 180 + Math.atan((u - 0.5) * 2 * tanH);
  const pitch = Math.atan((0.5 - w) * 2 * tanV);
  return { yaw, pitch };
}

/** Premier mur touché par un rayon horizontal partant du point de vue. */
export function castToWall(b: Building, from: Point, yaw: number): { wall: Wall; point: Point; distance: number } | null {
  const d = { x: Math.cos(yaw), y: Math.sin(yaw) };
  let best: { wall: Wall; point: Point; distance: number } | null = null;
  for (const w of b.walls) {
    const e = { x: w.b.x - w.a.x, y: w.b.y - w.a.y };
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const ax = w.a.x - from.x;
    const ay = w.a.y - from.y;
    const t = (ax * e.y - ay * e.x) / den;
    const s = (ax * d.y - ay * d.x) / den;
    if (t <= 0.05 || s < -0.001 || s > 1.001) continue;
    // On s'arrête à la face du mur, pas à son axe.
    const distance = Math.max(0.05, t - w.thickness / 2);
    if (!best || distance < best.distance) best = { wall: w, point: { x: from.x + d.x * t, y: from.y + d.y * t }, distance };
  }
  return best;
}

function currentBuilding(): Building {
  const s = useStore.getState();
  const b = s.step === 'existant' ? s.project.existing : applyOperations(s.project.existing, s.project.operations);
  return b;
}

export interface PlaceResult {
  ok: boolean;
  message: string;
}

/** Applique ce qu'on a reconnu sur la photo au bon endroit du plan. */
export function placeFromPhoto(v: Viewpoint, u: number, w: number, aspect: number, target: PhotoTarget, product: Product, apparentWidth?: number): PlaceResult {
  const full = currentBuilding();
  const b = onLevel(full, v.levelId);
  const { yaw, pitch } = photoRay(v, u, w, aspect);
  const hit = castToWall(b, v, yaw);

  if (target === 'sol') {
    // Pièce sous le point visé (ou celle du point de vue).
    let p: Point = v;
    if (pitch < -0.02) {
      const d = Math.min(v.eye / Math.tan(-pitch), hit ? hit.distance - 0.05 : 30);
      p = { x: v.x + Math.cos(yaw) * d, y: v.y + Math.sin(yaw) * d };
    }
    const rooms = detectRooms(b);
    const room = rooms.find((r) => inRoom(p, r)) ?? rooms.find((r) => inRoom(v, r));
    if (!room) return { ok: false, message: 'Aucune pièce fermée à cet endroit : tracez d’abord les murs.' };
    setRoomFloor(room, product.id);
    return { ok: true, message: `Sol de ${room.label.name} : ${product.name}` };
  }

  if (!hit) return { ok: false, message: 'Aucun mur dans cette direction : vérifiez la position et l’orientation du point de vue.' };
  const L = wallLength(hit.wall);
  const along = dist(hit.wall.a, hit.point);

  if (target === 'mur') {
    const n = wallNormal(hit.wall, 'gauche');
    const side = n.x * (v.x - hit.point.x) + n.y * (v.y - hit.point.y) > 0 ? 'gauche' : 'droite';
    setWallFinish(hit.wall.id, side, product.id);
    return { ok: true, message: `Mur à ${hit.distance.toFixed(1).replace('.', ',')} m : ${product.name}` };
  }

  if (target === 'porte' || target === 'fenetre') {
    const kind = target;
    const near = b.openings.find((o) => o.wallId === hit.wall.id && o.kind === kind && Math.abs(o.offset - along) < o.width / 2 + 0.3);
    if (near) {
      replaceOpening(near.id, product.id);
      return { ok: true, message: `${kind === 'porte' ? 'Porte' : 'Fenêtre'} existante mise à jour : ${product.name}` };
    }
    // Largeur : celle vue sur la photo si on la connaît, sinon celle du produit.
    let width = product.size?.w ?? (kind === 'porte' ? 0.83 : 1.2);
    if (apparentWidth && apparentWidth > 0.01) {
      const tanH = Math.tan((v.fov * Math.PI) / 360);
      width = Math.min(3, Math.max(0.5, apparentWidth * 2 * tanH * (hit.distance + hit.wall.thickness / 2)));
    }
    width = Math.min(width, L - 0.1);
    const offset = Math.min(L - width / 2, Math.max(width / 2, along));
    addOpening({
      id: newId('o'),
      wallId: hit.wall.id,
      kind,
      offset,
      width: Math.round(width * 100) / 100,
      height: product.size?.h ?? (kind === 'porte' ? 2.01 : 1.25),
      sill: kind === 'porte' ? 0 : 0.9,
      productId: product.id,
    });
    return { ok: true, message: `${kind === 'porte' ? 'Porte' : 'Fenêtre'} placée sur le mur, à ${hit.distance.toFixed(1).replace('.', ',')} m` };
  }

  // Meuble : point de contact au sol, reculé de la moitié de sa profondeur.
  const depth = product.size?.d ?? 0.6;
  let d = pitch < -0.02 ? v.eye / Math.tan(-pitch) : hit.distance - depth / 2;
  d = Math.min(d, hit.distance - depth / 2 - 0.02);
  d = Math.max(0.5, d);
  const x = Math.round((v.x + Math.cos(yaw) * d) * 20) / 20;
  const y = Math.round((v.y + Math.sin(yaw) * d) * 20) / 20;
  const rotation = Math.round(((yaw * 180) / Math.PI + 90 + 360) % 360 / 90) * 90 % 360;
  const prev = useStore.getState().levelId;
  useStore.setState({ levelId: v.levelId });
  addFurniture(product.id, x, y, rotation);
  useStore.setState({ levelId: prev });
  return { ok: true, message: `${product.name} placé à ${d.toFixed(1).replace('.', ',')} m` };
}

/** Couleur moyenne autour d'un point de l'image. */
export function sampleColor(img: HTMLImageElement, u: number, w: number): string {
  const c = document.createElement('canvas');
  const size = 24;
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const sx = u * img.naturalWidth - size / 2;
  const sy = w * img.naturalHeight - size / 2;
  ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
  const d = ctx.getImageData(0, 0, size, size).data;
  let r = 0;
  let g = 0;
  let bl = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    bl += d[i + 2];
  }
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Produits d'une famille, du plus proche au plus éloigné de la couleur relevée. */
export function closestByColor(catalog: Catalog, target: PhotoTarget, color: string, includeExisting: boolean): Product[] {
  const [r, g, b] = rgb(color);
  const cats = TARGET_CATEGORIES[target];
  return catalog.products
    .filter((p) => !p.hidden && cats.includes(p.category) && (includeExisting || !p.existingOnly))
    .map((p) => {
      const [pr, pg, pb] = rgb(p.color);
      // Distance perceptuelle simple (rouge-moyen)
      const rm = (r + pr) / 2;
      const d = Math.sqrt((2 + rm / 256) * (r - pr) ** 2 + 4 * (g - pg) ** 2 + (2 + (255 - rm) / 256) * (b - pb) ** 2);
      return { p, d: d - (p.existingOnly && includeExisting ? 25 : 0) };
    })
    .sort((x, y) => x.d - y.d)
    .map((x) => x.p);
}


