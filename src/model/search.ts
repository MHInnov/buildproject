import type { Catalog, Category, Product, Tone } from './catalog';

/**
 * Recherche en langage naturel dans le catalogue, sans serveur.
 * Ex. : « un grand canapé pas trop foncé à moins de 1000 € ».
 * Elle traduit la phrase en filtres ; une version branchée sur un LLM pourra produire les mêmes filtres.
 */
export interface SearchFilters {
  categories: Category[];
  subcategories: string[];
  tones: Tone[];
  excludeTones: Tone[];
  size: 'grand' | 'petit' | null;
  maxPrice: number | null;
  words: string[];
}

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9€.,<\s-]/g, ' ');

const CATEGORY_WORDS: Record<string, { category: Category; sub?: string; tag?: string }> = {
  sol: { category: 'sol' },
  sols: { category: 'sol' },
  plancher: { category: 'sol' },
  parquet: { category: 'sol', tag: 'parquet' },
  stratifie: { category: 'sol', tag: 'stratifie' },
  vinyle: { category: 'sol', tag: 'vinyle' },
  carrelage: { category: 'sol', tag: 'carrelage' },
  peinture: { category: 'peinture' },
  couleur: { category: 'peinture' },
  faience: { category: 'faience' },
  porte: { category: 'porte' },
  portes: { category: 'porte' },
  fenetre: { category: 'fenetre' },
  fenetres: { category: 'fenetre' },
  chassis: { category: 'fenetre' },
  baie: { category: 'fenetre', tag: 'grand' },
  canape: { category: 'meuble', sub: 'canape' },
  sofa: { category: 'meuble', sub: 'canape' },
  table: { category: 'meuble', sub: 'table' },
  chaise: { category: 'meuble', sub: 'chaise' },
  chaises: { category: 'meuble', sub: 'chaise' },
  lit: { category: 'meuble', sub: 'lit' },
  armoire: { category: 'meuble', sub: 'armoire' },
  penderie: { category: 'meuble', sub: 'armoire' },
  cuisine: { category: 'meuble', sub: 'cuisine' },
  ilot: { category: 'meuble', sub: 'cuisine' },
  bureau: { category: 'meuble', sub: 'bureau' },
  rangement: { category: 'meuble', sub: 'rangement' },
  bibliotheque: { category: 'meuble', sub: 'rangement' },
  meuble: { category: 'meuble' },
  meubles: { category: 'meuble' },
  douche: { category: 'meuble', sub: 'salle-de-bain' },
  vasque: { category: 'meuble', sub: 'salle-de-bain' },
};

const LIGHT = ['clair', 'claire', 'clairs', 'lumineux', 'lumineuse', 'pale', 'blanc', 'blanche'];
const DARK = ['fonce', 'foncee', 'fonces', 'sombre', 'sombres', 'noir', 'noire'];
const BIG = ['grand', 'grande', 'grands', 'large', 'spacieux', 'xxl', 'familial'];
const SMALL = ['petit', 'petite', 'petits', 'compact', 'compacte', 'etroit'];
const STOP = new Set(['un', 'une', 'des', 'le', 'la', 'les', 'de', 'du', 'pour', 'avec', 'et', 'ou', 'a', 'en', 'je', 'veux', 'voudrais', 'cherche', 'pas', 'trop', 'tres', 'plutot', 'mais', 'moins', 'max', 'maximum', 'euros', 'eur', 'sous', 'qui', 'soit', 'mon', 'ma', 'mes']);

export function parseQuery(query: string): SearchFilters {
  const text = normalize(query);
  const f: SearchFilters = { categories: [], subcategories: [], tones: [], excludeTones: [], size: null, maxPrice: null, words: [] };

  const price = /(?:moins de|max(?:imum)?|sous|<|budget(?: de)?|jusqu'?a)\s*(\d+(?:[.,]\d+)?)\s*(k)?/.exec(text) ?? /(\d+(?:[.,]\d+)?)\s*(k)?\s*(?:€|euros?|eur)\s*(?:max|maximum)?/.exec(text);
  if (price) f.maxPrice = Number(price[1].replace(',', '.')) * (price[2] ? 1000 : 1);

  // Négations : « pas trop foncé », « pas trop clair », « pas noir »
  if (/pas (trop |tres )?(fonce|sombre|noir)/.test(text)) f.excludeTones.push('fonce');
  if (/pas (trop |tres )?(clair|blanc|pale)/.test(text)) f.excludeTones.push('clair');
  const cleaned = text.replace(/pas (trop |tres )?\w+/g, ' ');

  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.replace(/[.,]/g, '');
    if (!w || /^\d/.test(w) || w === '€') continue;
    const cat = CATEGORY_WORDS[w];
    if (cat) {
      if (!f.categories.includes(cat.category)) f.categories.push(cat.category);
      if (cat.sub && !f.subcategories.includes(cat.sub)) f.subcategories.push(cat.sub);
      if (cat.tag) f.words.push(cat.tag);
      continue;
    }
    if (LIGHT.includes(w)) f.tones.push('clair');
    else if (DARK.includes(w)) f.tones.push('fonce');
    else if (w === 'moyen' || w === 'moyenne') f.tones.push('moyen');
    else if (BIG.includes(w)) f.size = 'grand';
    else if (SMALL.includes(w)) f.size = 'petit';
    else if (!STOP.has(w) && w.length > 2) f.words.push(w);
  }
  if (f.excludeTones.length && !f.tones.length) {
    f.tones = (['clair', 'moyen', 'fonce'] as Tone[]).filter((t) => !f.excludeTones.includes(t));
  }
  return f;
}

const footprint = (p: Product) => (p.size ? p.size.w * p.size.d : 0);

export interface SearchResult {
  product: Product;
  score: number;
  reasons: string[];
}

export function searchCatalog(catalog: Catalog, query: string, restrictTo?: Category[]): { filters: SearchFilters; results: SearchResult[] } {
  const filters = parseQuery(query);
  let pool = catalog.products;
  const cats = restrictTo?.length ? restrictTo : filters.categories;
  if (cats.length) pool = pool.filter((p) => cats.includes(p.category));
  if (filters.subcategories.length) {
    const sub = pool.filter((p) => p.subcategory && filters.subcategories.includes(p.subcategory));
    if (sub.length) pool = sub;
  }
  if (filters.excludeTones.length) pool = pool.filter((p) => !filters.excludeTones.includes(p.tone));
  if (filters.maxPrice != null) pool = pool.filter((p) => p.price <= filters.maxPrice!);

  // Taille relative à la famille de produits (médiane de l'emprise au sol).
  const medianOf = (group: Product[]) => {
    const v = group.map(footprint).filter((x) => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };

  const results: SearchResult[] = pool.map((p) => {
    let score = 0;
    const reasons: string[] = [];
    if (filters.tones.includes(p.tone)) {
      score += 2;
      reasons.push(`teinte ${p.tone === 'fonce' ? 'foncée' : p.tone === 'clair' ? 'claire' : 'moyenne'}`);
    } else if (filters.tones.length) score -= 1;
    if (filters.size && p.size) {
      const family = catalog.products.filter((q) => q.category === p.category && q.subcategory === p.subcategory);
      const med = medianOf(family);
      const big = footprint(p) > med || p.tags.includes('grand');
      const small = footprint(p) < med || p.tags.includes('petit');
      if ((filters.size === 'grand' && big) || (filters.size === 'petit' && small)) {
        score += 2;
        reasons.push(filters.size);
      } else score -= 1;
    }
    const hay = normalize(`${p.name} ${p.tags.join(' ')}`);
    for (const w of filters.words) {
      if (hay.includes(w) || (w.length > 4 && hay.includes(w.slice(0, -1)))) {
        score += 1.5;
        reasons.push(w);
      }
    }
    if (filters.maxPrice != null) reasons.push(`≤ ${filters.maxPrice} €`);
    return { product: p, score, reasons };
  });
  results.sort((a, b) => b.score - a.score || a.product.price - b.product.price);
  return { filters, results };
}
