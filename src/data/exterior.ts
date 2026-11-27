import type { Surface } from '../three/materials';

/**
 * Revêtements extérieurs et bois de charpente, pour la visite 3D (photos ambientCG, voir
 * public/textures/CREDITS.md). Ils ne sont pas chiffrés : ils servent à rendre la maison dans son jardin.
 */
export interface OutdoorMaterial {
  id: string;
  name: string;
  surface: Surface;
}

const mat = (id: string, name: string, color: string, photo: string, kind: 'carpet' | 'concrete' | 'tiles' | 'stone' | 'planks' = 'concrete'): OutdoorMaterial => ({
  id,
  name,
  surface: { color, pattern: { kind, photo }, roughness: undefined },
});

/** Sol du jardin. */
export const LAWNS: OutdoorMaterial[] = [
  mat('gazon', 'Gazon tondu', '#4d6a2c', 'gazon', 'carpet'),
  mat('herbe-jardin', 'Herbe de jardin', '#62822c', 'herbe-jardin', 'carpet'),
  mat('prairie', 'Prairie', '#6f9a45', 'grass', 'carpet'),
  mat('terre', 'Terre nue', '#897874', 'terre'),
  mat('gravier', 'Gravier', '#807c71', 'gravier'),
];

/** Abords de la maison : terrasse, allée ou bande de gravier tout autour. */
export const APRONS: OutdoorMaterial[] = [
  mat('gravier', 'Gravier gris', '#807c71', 'gravier'),
  mat('gravier-blanc', 'Gravier blanc', '#dad6cf', 'gravier-blanc'),
  mat('gravillons', 'Gravillons beiges', '#ccbea0', 'gravillons'),
  mat('pave-granit', 'Pavés granit en éventail', '#575a5a', 'pave-granit', 'stone'),
  mat('paves-anciens', 'Pavés anciens', '#88826f', 'paves-anciens', 'stone'),
  mat('pave-beton', 'Pavés béton', '#706f71', 'pave-beton', 'tiles'),
  mat('dalles-pierre', 'Dalles de pierre (opus incertum)', '#9a927a', 'dalles-pierre', 'stone'),
  mat('dalles-beton', 'Dalles béton', '#77797e', 'dalles-beton', 'tiles'),
  mat('terrasse-bois', 'Terrasse en bois', '#928164', 'terrasse-bois', 'planks'),
];

/** Bois de charpente. */
export const TIMBERS: OutdoorMaterial[] = [
  mat('sapin', 'Sapin (charpente récente)', '#a78364', 'charpente-sapin', 'planks'),
  mat('chene', 'Chêne ancien', '#4a3526', 'charpente-chene', 'planks'),
  mat('brut', 'Bois brut grisé', '#8b7e65', 'bois-brut', 'planks'),
];

export const DEFAULT_LAWN = 'gazon';
export const DEFAULT_APRON_WIDTH = 1.5;

export const outdoorById = (list: OutdoorMaterial[], id: string | null | undefined) => list.find((m) => m.id === id);
