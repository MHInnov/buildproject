import type { Lot } from './types';

export type Category = 'sol' | 'peinture' | 'mur' | 'faience' | 'porte' | 'fenetre' | 'meuble' | 'escalier' | 'toiture' | 'isolation';

/**
 * Aspect d'un matériau, dessiné par l'application (aucune image à télécharger) :
 * - planks : lames de bois (w = largeur de lame, h = longueur)
 * - parquet : chevrons ou bâtons rompus (w = largeur de lame)
 * - tiles : carreaux (w × h), joint de couleur `joint`
 * - bricks : briques (w × h)
 * - stone : pierres irrégulières
 * - wallpaper : papier peint à motif (couleur `accent`)
 * - paneling : lambris vertical (w = largeur de lame)
 * - plaster, concrete, carpet, smooth : surfaces continues avec grain plus ou moins marqué
 * - slate, rooftiles, zinc : couvertures de toiture
 */
export type PatternKind =
  | 'planks'
  | 'parquet'
  | 'tiles'
  | 'bricks'
  | 'stone'
  | 'wallpaper'
  | 'paneling'
  | 'plaster'
  | 'concrete'
  | 'carpet'
  | 'smooth'
  | 'slate'
  | 'rooftiles'
  | 'zinc';

export interface Pattern {
  kind: PatternKind;
  w?: number;
  h?: number;
  joint?: string;
  accent?: string;
  /** Photo à utiliser en 3D quand l'aspect seul ne suffit pas (ex. 'terracotta', 'marble'), voir three/photoMaterials.ts. */
  photo?: string;
}
export type Tone = 'clair' | 'moyen' | 'fonce';

export interface Product {
  id: string;
  category: Category;
  /** Pour les meubles : canape, table, chaise, lit, armoire, cuisine, bureau, rangement... */
  subcategory?: string;
  name: string;
  brand: string;
  /**
   * Unité de vente :
   * - 'paquet' : un paquet couvre `packSize` m² (sols, faïence)
   * - 'pot' : un pot contient `packSize` litres (peinture)
   * - 'piece' : à la pièce (portes, fenêtres, meubles)
   */
  saleUnit: 'paquet' | 'pot' | 'piece';
  packSize?: number;
  /** Prix TTC indicatif par unité de vente, en euros. */
  price: number;
  /** Date du relevé de prix (ISO). */
  priceDate: string;
  color: string;
  tone: Tone;
  tags: string[];
  /** Dimensions en mètres (largeur, profondeur, hauteur). */
  size?: { w: number; d: number; h: number };
  /** Peinture : rendement en m² par litre et nombre de couches. */
  coverage?: number;
  coats?: number;
  /** Taux de chute pour les revêtements (0.08 = 8 %). */
  waste?: number;
  /** Aspect du matériau pour le plan et la 3D. */
  pattern?: Pattern;
  /** Rugosité pour le rendu 3D (0 = brillant, 1 = mat). */
  roughness?: number;
  /** Matériau qu'on trouve dans une maison existante mais qu'on ne vend pas (relevé de l'existant uniquement). */
  existingOnly?: boolean;
  /** Tâche de dépose propre à ce matériau, utilisée quand le projet le remplace. */
  removal?: string;
  /**
   * Objet générique paramétrable : une seule fiche par type d'objet, réglée sur place (couleur, dimensions,
   * vantaux, variante). Le prix est celui de la taille `size` et de la première variante, ajusté selon les réglages.
   */
  generic?: GenericSpec;
  /** Ancienne fiche remplacée par un objet générique : gardée pour les projets existants, plus proposée. */
  hidden?: boolean;
  /** Isolation : résistance thermique R (m².K/W). */
  rValue?: number;
}

export interface GenericStyle {
  id: string;
  label: string;
  /** Coefficient de prix par rapport à la première variante. */
  factor: number;
  /** Mots-clés de rendu ajoutés au produit (ex. 'vitré'). */
  tags?: string[];
}

export interface GenericSpec {
  /** Variantes proposées ; la première est celle par défaut. */
  styles?: GenericStyle[];
  /** Nombres de vantaux proposés (portes, fenêtres). */
  leaves?: number[];
  /** Couleur réglable (palette + couleur libre). */
  color?: boolean;
  /** Dimensions d'un meuble réglables (les portes et fenêtres se règlent toujours sur le plan). */
  sized?: boolean;
  /** Bornes des dimensions (m). */
  min?: { w: number; d: number; h: number };
  max?: { w: number; d: number; h: number };
}

export interface LaborTask {
  id: string;
  lot: Lot;
  label: string;
  unit: 'm²' | 'm' | 'pièce' | 'forfait' | 'm³';
  /** Fourchette de prix main d'œuvre HTVA par unité, en euros. */
  min: number;
  max: number;
}

export interface Catalog {
  products: Product[];
  tasks: LaborTask[];
}

export function productById(catalog: Catalog, id: string | null | undefined): Product | undefined {
  if (!id) return undefined;
  return catalog.products.find((p) => p.id === id);
}

export function taskById(catalog: Catalog, id: string): LaborTask {
  const t = catalog.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`Tâche inconnue : ${id}`);
  return t;
}
