import type { Lot } from './types';

export type Category = 'sol' | 'peinture' | 'faience' | 'porte' | 'fenetre' | 'meuble';
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
