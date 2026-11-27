import * as THREE from 'three';
import type { Pattern } from '../model/catalog';
import manifest from './photoTextures.json';

/**
 * Textures photo (PBR : couleur, relief, rugosité) des matériaux de la visite 3D.
 * Photos ambientCG (CC0) embarquées dans l'application, voir public/textures/CREDITS.md.
 *
 * Chaque produit du catalogue garde son aspect dessiné (`pattern`) pour le plan 2D ;
 * en 3D on choisit la photo la plus proche et on la met à l'échelle réelle du produit
 * (taille des carreaux, largeur des lames…), puis on la teinte à la couleur du produit.
 */
export type PhotoKey = keyof typeof manifest;

interface PhotoInfo {
  source: string;
  aspect: number;
  avg: number[];
  rough: number;
}
const INFO = manifest as Record<PhotoKey, PhotoInfo>;

export const isPhotoKey = (k: string | undefined): k is PhotoKey => !!k && k in INFO;

/** Photo utilisée pour un aspect de matériau. */
export function photoFor(p: Pattern): PhotoKey | null {
  if (isPhotoKey(p.photo)) return p.photo;
  const w = p.w ?? 0.2;
  const h = p.h ?? w;
  switch (p.kind) {
    case 'planks':
      if (w >= 0.5) return 'wood'; // portes : panneau de bois
      if (h >= 2.5) return 'old-planks';
      if (h >= 1.9) return 'wood'; // meubles, menuiseries
      return 'oak-planks';
    case 'parquet':
      return 'herringbone';
    case 'tiles':
      if (p.accent && w <= 0.25) return 'cement';
      return w >= 0.3 ? 'tiles-large' : 'tiles-old';
    case 'bricks':
      return h < 0.06 || w < 0.18 ? 'subway' : 'brick';
    case 'stone':
      return 'stone';
    case 'wallpaper':
      return 'wallpaper';
    case 'paneling':
      return 'paneling';
    case 'plaster':
      return 'plaster';
    case 'concrete':
      return 'concrete';
    case 'carpet':
      return 'carpet';
    case 'slate':
      return 'slate';
    case 'rooftiles':
      return 'rooftiles';
    case 'zinc':
      return 'zinc';
    default:
      return null;
  }
}

/** Taille réelle couverte par une photo (largeur, hauteur en mètres), selon les dimensions du produit. */
export function photoSize(key: PhotoKey, p: Pattern): [number, number] {
  const w = p.w ?? 0.2;
  const h = p.h ?? w;
  const a = INFO[key].aspect;
  const uniform = (W: number): [number, number] => [W, W * a];
  const fixed = SIZES[key];
  if (fixed) return uniform(fixed(w));
  switch (key) {
    case 'oak-planks':
      return uniform(10 * w); // ≈ 10 lames sur la photo
    case 'old-planks':
      return [10 * w, 5 * w];
    case 'herringbone':
      return uniform(13 * w);
    case 'tiles-large':
    case 'cement':
    case 'zellige':
      return [8 * w, 8 * h];
    case 'tiles-old':
    case 'terracotta':
      return [6 * w, 6 * h];
    case 'subway':
      return [4 * w, 4 * h];
    case 'brick':
      return [11 * (w + 0.01), 16 * (h + 0.01)];
    case 'paneling':
      return uniform(7 * w);
    case 'rooftiles':
      return uniform(8 * w);
    case 'slate':
      return uniform(7 * w);
    case 'marble':
      return uniform(Math.max(1.2, 2 * w));
    case 'stone':
      return uniform(2.4);
    case 'plaster':
      return uniform(2);
    case 'crepi':
      return uniform(1.2);
    case 'wallpaper':
      return uniform(0.9);
    case 'concrete':
      return uniform(2.5);
    case 'carpet':
      return uniform(0.8);
    case 'zinc':
      return uniform(1);
    case 'grass':
      return uniform(2.5);
    case 'fabric':
      return uniform(0.5);
    case 'wood':
      return uniform(1);
    default:
      return uniform(1);
  }
}

/**
 * Photos de matériaux précis (relevé de l'existant, façades, toitures, extérieurs) : largeur couverte
 * par la photo en mètres, selon la taille d'élément du produit (w) quand elle compte.
 */
const SIZES: Partial<Record<PhotoKey, (w: number) => number>> = {
  'tuiles-canal': (w) => 7 * w,
  'tuiles-canal-anciennes': (w) => 7 * w,
  'tuiles-plates': (w) => 8 * w,
  'tuiles-plates-anciennes': (w) => 8 * w,
  'tuiles-beton': (w) => 6 * w,
  'ardoise-ecailles': (w) => 10 * w,
  'ardoise-ancienne': (w) => 10 * w,
  'charpente-chene': () => 1.2,
  'charpente-sapin': () => 1.2,
  'bois-brut': () => 1.2,
  'plancher-ancien': (w) => 9 * w,
  'plancher-sapin': (w) => 9 * w,
  'parquet-mosaique': (w) => 7.5 * w,
  tomettes: (w) => 7 * w,
  'carrelage-ancien': (w) => 3 * w,
  'brique-rouge': (w) => 7 * (w + 0.01),
  'brique-ancienne': (w) => 10 * (w + 0.01),
  'brique-jaune': (w) => 9 * (w + 0.01),
  'pierre-calcaire': () => 2.2,
  moellons: () => 2,
  meuliere: () => 2.4,
  'enduit-ancien': () => 2,
  'enduit-ecaille': () => 2,
  'enduit-taloche': () => 2,
  'bardage-bois': (w) => 14 * w,
  'bardage-gris': (w) => 14 * w,
  'bardage-peint': (w) => 16 * w,
  gazon: () => 2.5,
  'herbe-jardin': () => 2.5,
  terre: () => 2.5,
  gravier: () => 1,
  'gravier-blanc': () => 1,
  gravillons: () => 0.8,
  'pave-granit': () => 1.5,
  'paves-anciens': () => 1,
  'pave-beton': () => 1.3,
  'dalles-pierre': () => 2.4,
  'dalles-beton': () => 1.7,
  'terrasse-bois': () => 2,
};

/** Force de la teinte (1 = couleur exacte du produit, 0 = couleur de la photo). */
const TINT: Partial<Record<PhotoKey, number>> = { brick: 0.55, stone: 0.5, rooftiles: 0.6, slate: 0.7, terracotta: 0.7, cement: 0.5, zellige: 0.8, grass: 0.5, 'old-planks': 0.85, 'oak-planks': 0.9, herringbone: 0.9, 'enduit-ancien': 0.8, 'enduit-ecaille': 0.6, 'enduit-taloche': 1, 'bardage-peint': 0.8, 'carrelage-ancien': 0.6 };

/** Photos de matériaux précis : on garde leurs couleurs naturelles, juste nuancées par la couleur du produit. */
const NATURAL = 0.3;

/** Relief atténué pour les surfaces lisses (peinture, papier peint). */
const NORMAL: Partial<Record<PhotoKey, number>> = { plaster: 0.35, wallpaper: 0.5, 'tiles-large': 0.8, 'enduit-taloche': 0.6 };

const loader = new THREE.TextureLoader();
const images = new Map<string, Promise<HTMLImageElement>>();
function image(url: string): Promise<HTMLImageElement> {
  let p = images.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((t) => t.image as HTMLImageElement);
    p.catch(() => images.delete(url));
    images.set(url, p);
  }
  return p;
}

/**
 * Habille un matériau avec la photo : les textures arrivent en arrière-plan,
 * en attendant le matériau garde la couleur unie du produit (jamais d'écran noir).
 */
export function applyPhoto(m: THREE.MeshStandardMaterial, key: PhotoKey, pattern: Pattern, color: string, roughness: number | undefined, opts: { normal?: number } = {}) {
  const info = INFO[key];
  const [W, H] = photoSize(key, pattern);
  const base = `${import.meta.env.BASE_URL}textures/${key}/`;
  // Teinte : couleur du produit ÷ couleur moyenne de la photo (en linéaire), pour garder le grain de la photo.
  const c = new THREE.Color(color);
  const target = [c.r, c.g, c.b];
  // Les photos très colorées (brique, tuiles, bois) gardent une partie de leurs nuances naturelles.
  const k = TINT[key] ?? (SIZES[key] ? NATURAL : 1);
  const tint = new THREE.Color(...(target.map((t, i) => Math.min(2.5, Math.max(0.05, t / Math.max(0.01, info.avg[i]))) ** k) as [number, number, number]));
  const rough = Math.min(3, Math.max(0.2, (roughness ?? info.rough) / Math.max(0.05, info.rough)));
  const make = (img: HTMLImageElement, srgb: boolean) => {
    const t = new THREE.Texture(img);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / W, 1 / H);
    if (key === 'wood') t.rotation = Math.PI / 2; // fil du bois vertical (portes, façades de meubles)
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  Promise.all([image(`${base}color.jpg`), image(`${base}normal.jpg`), image(`${base}rough.jpg`)])
    .then(([col, nor, rgh]) => {
      m.map = make(col, true);
      m.normalMap = make(nor, false);
      const s = opts.normal ?? NORMAL[key] ?? 1;
      m.normalScale.set(s, s);
      m.roughnessMap = make(rgh, false);
      m.roughness = rough;
      m.color.copy(tint);
      m.needsUpdate = true;
    })
    .catch(() => undefined);
}
