import type { Catalog, Product } from './catalog';
import { productById } from './catalog';
import type { ItemOptions } from './types';

/**
 * Objets génériques paramétrables : une seule fiche « Porte intérieure », « Fenêtre PVC », « Canapé »…
 * réglée sur place (couleur, dimensions, simple ou double vantail, variante), plutôt qu'un modèle figé par taille.
 */

/** Couleurs courantes des menuiseries et du mobilier (teintes RAL et bois). */
export const PALETTE: { color: string; label: string }[] = [
  { color: '#f4f4f0', label: 'Blanc (RAL 9016)' },
  { color: '#e9e0d2', label: 'Crème (RAL 9001)' },
  { color: '#c5c7c4', label: 'Gris clair (RAL 7035)' },
  { color: '#8d9095', label: 'Gris moyen' },
  { color: '#383e42', label: 'Anthracite (RAL 7016)' },
  { color: '#1d1d1f', label: 'Noir (RAL 9005)' },
  { color: '#d2b48c', label: 'Chêne clair' },
  { color: '#b5824f', label: 'Chêne doré' },
  { color: '#6b4a33', label: 'Noyer' },
  { color: '#93a38b', label: 'Vert sauge' },
  { color: '#31372b', label: 'Vert sapin (RAL 6009)' },
  { color: '#1f3855', label: 'Bleu acier (RAL 5011)' },
  { color: '#6b1c23', label: 'Rouge basque (RAL 3004)' },
  { color: '#e3dacb', label: 'Beige' },
  { color: '#8b7d6b', label: 'Taupe' },
];

export const isGeneric = (p: Product | undefined): p is Product & { generic: NonNullable<Product['generic']> } => !!p?.generic;

/** Variante retenue (celle choisie, sinon la première). */
export function styleOf(p: Product | undefined, o?: ItemOptions) {
  const styles = p?.generic?.styles;
  if (!styles?.length) return undefined;
  return styles.find((s) => s.id === o?.style) ?? styles[0];
}

/** Nombre de vantaux retenu. */
export const leavesOf = (p: Product | undefined, o?: ItemOptions) => o?.leaves ?? p?.generic?.leaves?.[0] ?? 1;

/**
 * Produit tel que réglé : couleur, dimensions, variante (mots-clés de rendu) et nom complété.
 * Les produits figés sont rendus tels quels.
 */
export function withOptions(p: Product | undefined, o?: ItemOptions): Product | undefined {
  if (!p || !p.generic || !o) return p;
  const st = styleOf(p, o);
  return {
    ...p,
    color: o.color ?? p.color,
    size: p.generic.sized && o.size ? o.size : p.size,
    tags: [...p.tags, ...(st?.tags ?? [])],
    name: `${p.name}${describeOptions(o, p) ? ` (${describeOptions(o, p)})` : ''}`,
  };
}

/** Produit d'un meuble ou d'une ouverture, avec ses réglages. */
export const itemProduct = (catalog: Catalog, item: { productId: string | null; options?: ItemOptions }) => withOptions(productById(catalog, item.productId), item.options);

const colorName = (c: string) => PALETTE.find((x) => x.color.toLowerCase() === c.toLowerCase())?.label.replace(/ \(.*\)$/, '').toLowerCase() ?? c;
const cm = (m: number) => Math.round(m * 100);

/** Réglages en clair : « double vantail, vitrée, anthracite, 160 × 90 cm ». */
export function describeOptions(o: ItemOptions, p?: Product): string {
  const parts: string[] = [];
  if (o.leaves && p?.generic?.leaves && o.leaves !== p.generic.leaves[0]) parts.push(o.leaves === 2 ? 'double vantail' : `${o.leaves} vantaux`);
  else if (o.leaves && !p) parts.push(o.leaves === 2 ? 'double vantail' : `${o.leaves} vantaux`);
  const st = p ? styleOf(p, o) : undefined;
  if (st && o.style) parts.push(st.label.toLowerCase());
  if (o.color) parts.push(colorName(o.color));
  if (o.size) parts.push(`${cm(o.size.w)} × ${cm(o.size.d)} cm`);
  return parts.join(', ');
}

/**
 * Prix d'un objet réglé : prix de la fiche (à sa taille de référence), ajusté selon la variante, les vantaux
 * et la surface (portes, fenêtres) ou l'emprise (meubles). Les produits figés gardent leur prix.
 */
export function itemPrice(p: Product, o?: ItemOptions, dims?: { w: number; h: number }): number {
  if (!p.generic) return p.price;
  let k = styleOf(p, o)?.factor ?? 1;
  const leaves = leavesOf(p, o);
  const base = p.generic.leaves?.[0] ?? 1;
  if (leaves > base) k *= 1 + 0.25 * (leaves - base);
  const ref = p.size;
  if (ref) {
    let ratio = 1;
    if (dims) ratio = (dims.w * dims.h) / Math.max(0.1, ref.w * ref.h);
    else if (p.generic.sized && o?.size) ratio = (o.size.w * o.size.d) / Math.max(0.05, ref.w * ref.d);
    k *= Math.min(4, Math.max(0.4, ratio)) ** 0.7;
  }
  return Math.round(p.price * k);
}
