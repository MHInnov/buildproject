import * as THREE from 'three';
import type { Pattern, Product } from '../model/catalog';
import { patternTile } from '../textures/patterns';
import { applyPhoto, photoFor } from './photoMaterials';

/**
 * Matériaux 3D : textures photo (voir photoMaterials.ts), ou textures dessinées en repli.
 * Les coordonnées de texture des géométries sont en mètres : la répétition vaut 1 / taille du module,
 * ce qui garde les carreaux et les lames à leur taille réelle.
 */
export const HIGHLIGHT = new THREE.Color('#1f6feb');

const texCache = new Map<string, THREE.Texture>();
const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Motifs en relief : on réutilise la texture comme carte de relief (joints creusés). */
const BUMPY = new Set(['tiles', 'bricks', 'stone', 'planks', 'parquet', 'rooftiles', 'slate', 'paneling', 'carpet', 'plaster', 'concrete', 'zinc']);

function texture(pattern: Pattern, color: string): { map: THREE.Texture; w: number; h: number } {
  const tile = patternTile(pattern, color, 256);
  const key = `${JSON.stringify(pattern)}|${color}`;
  let t = texCache.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(tile.canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.repeat.set(1 / tile.w, 1 / tile.h);
    texCache.set(key, t);
  }
  return { map: t, w: tile.w, h: tile.h };
}

export interface Surface {
  color: string;
  pattern?: Pattern;
  roughness?: number;
  metalness?: number;
}

export const fromProduct = (p: Product | undefined, fallback: Surface): Surface =>
  p ? { color: p.color, pattern: p.pattern, roughness: p.roughness } : fallback;

/** Matériau d'une surface, mis en cache (un seul par aspect). Les surfaces à motif reçoivent une texture photo. */
export function surfaceMaterial(s: Surface, selected = false, opts: { side?: THREE.Side; bump?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${s.color}|${JSON.stringify(s.pattern ?? null)}|${s.roughness}|${s.metalness}|${selected ? 1 : 0}|${opts.side ?? 0}|${opts.bump ?? ''}`;
  let m = matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color: s.color, roughness: s.roughness ?? 0.85, metalness: s.metalness ?? 0, side: opts.side ?? THREE.FrontSide });
  const photo = s.pattern ? photoFor(s.pattern) : null;
  if (s.pattern && photo) {
    applyPhoto(m, photo, s.pattern, s.color, s.roughness, { normal: opts.bump });
  } else if (s.pattern) {
    // Motif sans photo équivalente : texture dessinée
    const { map } = texture(s.pattern, s.color);
    m.color.set('#ffffff');
    m.map = map;
    if (BUMPY.has(s.pattern.kind)) {
      m.bumpMap = map;
      m.bumpScale = opts.bump ?? 1.2;
    }
  }
  if (selected) {
    m.emissive = HIGHLIGHT;
    m.emissiveIntensity = 0.3;
  }
  matCache.set(key, m);
  return m;
}

export function plain(color: string, roughness = 0.8, selected = false, metalness = 0): THREE.MeshStandardMaterial {
  return surfaceMaterial({ color, roughness, metalness }, selected);
}

export const glassMaterial = new THREE.MeshStandardMaterial({ color: '#d6e8f2', transparent: true, opacity: 0.18, roughness: 0.02, metalness: 0.1, envMapIntensity: 1.4, depthWrite: false });
export const chrome = new THREE.MeshStandardMaterial({ color: '#d9dde0', roughness: 0.15, metalness: 1 });
export const ceramic = new THREE.MeshStandardMaterial({ color: '#fbfbfa', roughness: 0.12, metalness: 0 });

/** Revêtement de façade par défaut d'une maison belge : brique rouge. */
export const FACADE: Surface = { color: '#9b5a40', pattern: { kind: 'bricks', w: 0.21, h: 0.065, joint: '#cdc4b4' }, roughness: 0.95 };
export const PLASTER: Surface = { color: '#f1efe9', pattern: { kind: 'plaster' }, roughness: 0.92 };
export const CEILING: Surface = { color: '#fbfaf7', pattern: { kind: 'plaster' }, roughness: 0.95 };
export const RAW_FLOOR: Surface = { color: '#b9b2a6', pattern: { kind: 'concrete', w: 1, h: 1 }, roughness: 0.9 };
export const ROOF_UNDERSIDE: Surface = { color: '#c9a77a', pattern: { kind: 'paneling', w: 0.6 }, roughness: 0.8 };

/**
 * Boîte dont les coordonnées de texture sont en mètres.
 * u0 : décalage le long du mur (pour que les joints se suivent d'un tronçon à l'autre), v0 : hauteur de départ.
 */
export function meterBox(w: number, h: number, d: number, u0 = 0, v0 = 0): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // 6 faces × 4 sommets : +x, -x, +y, -y, +z, -z
  const dims: [number, number, number, number][] = [
    [d, h, 0, v0],
    [d, h, 0, v0],
    [w, d, u0, 0],
    [w, d, u0, 0],
    [w, h, u0, v0],
    [w, h, -(u0 + w), v0],
  ];
  for (let f = 0; f < 6; f++) {
    const [du, dv, ou, ov] = dims[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, ou + uv.getX(i) * du, ov + uv.getY(i) * dv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** Ciel en dégradé (jour ou nuit), utilisé comme fond de scène. */
export function skyTexture(night: boolean): THREE.Texture {
  const key = `sky|${night}`;
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  if (night) {
    g.addColorStop(0, '#05070f');
    g.addColorStop(0.5, '#141b2e');
    g.addColorStop(0.52, '#1d2232');
    g.addColorStop(1, '#0b0d12');
  } else {
    g.addColorStop(0, '#5d8fc9');
    g.addColorStop(0.48, '#cfe0ef');
    g.addColorStop(0.52, '#e8e4da');
    g.addColorStop(1, '#a5a79a');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** Gazon autour de la maison. */
export const GRASS: Surface = { color: '#5f7f3e', pattern: { kind: 'carpet', photo: 'grass' }, roughness: 1 };
