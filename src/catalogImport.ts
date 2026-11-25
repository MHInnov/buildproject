import type { Catalog, Category, PatternKind, Product, Tone } from './model/catalog';

/**
 * Catalogues fournisseurs importés (fichier CSV ou JSON fourni par la marque ou un distributeur).
 * Ils sont gardés dans ce navigateur et s'ajoutent au catalogue de démonstration.
 */
export interface ImportedCatalog {
  id: string;
  name: string;
  importedAt: string;
  products: Product[];
}

const KEY = 'construprojet:catalogues';

export function loadImported(): ImportedCatalog[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ImportedCatalog[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveImported(list: ImportedCatalog[]): string | null {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return null;
  } catch {
    return 'Stockage du navigateur plein : le catalogue est utilisable maintenant mais ne sera pas conservé.';
  }
}

export function mergeCatalogs(base: Catalog, list: ImportedCatalog[]): Catalog {
  const ids = new Set(base.products.map((p) => p.id));
  const extra = list.flatMap((c) => c.products).filter((p) => !ids.has(p.id) && (ids.add(p.id), true));
  return { ...base, products: [...base.products, ...extra] };
}

const CATEGORIES: Record<string, Category> = {
  sol: 'sol', sols: 'sol', floor: 'sol', flooring: 'sol', parquet: 'sol', stratifie: 'sol', carrelage: 'sol', vinyle: 'sol',
  peinture: 'peinture', paint: 'peinture',
  mur: 'mur', murs: 'mur', 'revetement-mural': 'mur', 'papier-peint': 'mur', wall: 'mur',
  faience: 'faience', 'wall-tiles': 'faience',
  porte: 'porte', door: 'porte',
  fenetre: 'fenetre', window: 'fenetre',
  meuble: 'meuble', meubles: 'meuble', furniture: 'meuble', mobilier: 'meuble',
};

const SUBCATEGORIES: Record<string, string> = {
  canape: 'canape', sofa: 'canape', fauteuil: 'canape', armchair: 'canape',
  table: 'table', 'table-basse': 'table', 'coffee-table': 'table',
  bureau: 'bureau', desk: 'bureau',
  chaise: 'chaise', chair: 'chaise', tabouret: 'chaise', stool: 'chaise',
  lit: 'lit', bed: 'lit',
  armoire: 'armoire', wardrobe: 'armoire', penderie: 'armoire',
  rangement: 'rangement', commode: 'rangement', etagere: 'rangement', bibliotheque: 'rangement', storage: 'rangement', bookcase: 'rangement', buffet: 'rangement',
  cuisine: 'cuisine', kitchen: 'cuisine',
  wc: 'wc', toilette: 'wc', toilet: 'wc',
  'salle-de-bain': 'salle-de-bain', vasque: 'salle-de-bain', lavabo: 'salle-de-bain', bathroom: 'salle-de-bain',
  radiateur: 'chauffage', chauffage: 'chauffage',
};

const PATTERNS: Record<string, PatternKind> = {
  lames: 'planks', lame: 'planks', planks: 'planks', bois: 'planks', stratifie: 'planks', wood: 'planks',
  chevrons: 'parquet', 'batons-rompus': 'parquet', parquet: 'parquet', herringbone: 'parquet',
  carrelage: 'tiles', carreaux: 'tiles', tiles: 'tiles', tile: 'tiles',
  beton: 'concrete', concrete: 'concrete', pierre: 'stone', stone: 'stone',
  moquette: 'carpet', carpet: 'carpet', lisse: 'smooth', smooth: 'smooth',
  enduit: 'plaster', plaster: 'plaster', 'papier-peint': 'wallpaper', wallpaper: 'wallpaper', lambris: 'paneling', brique: 'bricks', bricks: 'bricks',
};

/** Colonnes reconnues (en-têtes en français ou en anglais, sans accents ni majuscules). */
const COLUMNS: Record<string, string[]> = {
  ref: ['reference', 'ref', 'id', 'sku', 'article', 'code'],
  name: ['nom', 'name', 'designation', 'libelle', 'produit', 'product'],
  brand: ['marque', 'brand', 'fabricant', 'fournisseur'],
  category: ['categorie', 'category', 'famille', 'type'],
  subcategory: ['sous-categorie', 'souscategorie', 'subcategory', 'sous-famille'],
  price: ['prix', 'price', 'prix-ttc', 'prix-unitaire'],
  unit: ['unite', 'unit', 'unite-de-vente'],
  pack: ['m2-par-paquet', 'm2-paquet', 'surface-paquet', 'contenance', 'pack-size', 'packsize', 'litres'],
  color: ['couleur', 'color', 'couleur-hex', 'hex'],
  w: ['largeur', 'width', 'largeur-cm', 'l'],
  d: ['profondeur', 'depth', 'profondeur-cm', 'p'],
  h: ['hauteur', 'height', 'hauteur-cm', 'h'],
  pattern: ['aspect', 'motif', 'pattern', 'pose'],
  plankW: ['largeur-lame', 'largeur-lame-cm', 'largeur-carreau', 'largeur-carreau-cm', 'format-largeur'],
  plankL: ['longueur-lame', 'longueur-lame-cm', 'longueur-carreau', 'longueur-carreau-cm', 'format-longueur'],
  tags: ['mots-cles', 'tags', 'style'],
  url: ['lien', 'url', 'page'],
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[²()]/g, (c) => (c === '²' ? '2' : ''))
    .replace(/[\s_/]+/g, '-');

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v.replace(/\s|€/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

/** Lecture d'un CSV (séparateur ; , ou tabulation, champs entre guillemets). */
export function parseCsv(text: string): Record<string, string>[] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.replace(/^﻿/, ''));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function pick(row: Record<string, unknown>, field: keyof typeof COLUMNS): unknown {
  for (const [k, v] of Object.entries(row)) if (COLUMNS[field].includes(norm(k)) && v !== '' && v != null) return v;
  return undefined;
}

function toneOf(hex: string): Tone {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.72 ? 'clair' : l > 0.4 ? 'moyen' : 'fonce';
}

const slug = (s: string) => norm(s).replace(/[^a-z0-9-]/g, '').slice(0, 40);

const DEFAULT_SIZE: Record<string, { w: number; d: number; h: number }> = {
  canape: { w: 2, d: 0.9, h: 0.8 },
  table: { w: 1.4, d: 0.8, h: 0.75 },
  bureau: { w: 1.2, d: 0.6, h: 0.75 },
  chaise: { w: 0.45, d: 0.5, h: 0.8 },
  lit: { w: 1.5, d: 2.0, h: 0.9 },
  armoire: { w: 1.0, d: 0.6, h: 2.0 },
  rangement: { w: 0.8, d: 0.4, h: 1.0 },
  cuisine: { w: 2.4, d: 0.62, h: 0.9 },
};

export interface ImportResult {
  products: Product[];
  errors: string[];
}

/** Transforme les lignes d'un fichier fournisseur en produits du catalogue. */
export function rowsToProducts(rows: Record<string, unknown>[], defaultBrand: string): ImportResult {
  const products: Product[] = [];
  const errors: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const line = `Ligne ${i + 2}`;
    const name = String(pick(row, 'name') ?? '').trim();
    const category = CATEGORIES[norm(String(pick(row, 'category') ?? ''))];
    const price = num(pick(row, 'price'));
    if (!name) return void errors.push(`${line} : nom manquant`);
    if (!category) return void errors.push(`${line} (${name}) : catégorie inconnue « ${String(pick(row, 'category') ?? '')} » (sol, peinture, mur, faience, porte, fenetre ou meuble)`);
    if (price === undefined) return void errors.push(`${line} (${name}) : prix manquant`);
    const brand = String(pick(row, 'brand') ?? defaultBrand).trim() || defaultBrand;
    const ref = String(pick(row, 'ref') ?? name);
    let id = `imp-${slug(brand)}-${slug(ref)}`;
    for (let n = 2; seen.has(id); n++) id = `imp-${slug(brand)}-${slug(ref)}-${n}`;
    seen.add(id);
    const rawColor = String(pick(row, 'color') ?? '').trim();
    const color = /^#?[0-9a-f]{6}$/i.test(rawColor) ? `#${rawColor.replace('#', '').toLowerCase()}` : '#b5a48c';
    const cm = (f: keyof typeof COLUMNS) => {
      const v = num(pick(row, f));
      return v === undefined ? undefined : v > 10 ? v / 100 : v; // cm → m (une valeur ≤ 10 est déjà en mètres)
    };
    const unitRaw = norm(String(pick(row, 'unit') ?? ''));
    const surface = category === 'sol' || category === 'faience' || category === 'mur';
    const saleUnit: Product['saleUnit'] =
      unitRaw.startsWith('paq') || unitRaw.startsWith('boi') || unitRaw.startsWith('pack') || unitRaw.startsWith('m2')
        ? 'paquet'
        : unitRaw.startsWith('pot') || unitRaw.startsWith('l')
          ? 'pot'
          : unitRaw
            ? 'piece'
            : category === 'peinture'
              ? 'pot'
              : surface
                ? 'paquet'
                : 'piece';
    const pack = num(pick(row, 'pack')) ?? (unitRaw.startsWith('m2') ? 1 : undefined);
    const p: Product = {
      id,
      category,
      name,
      brand,
      saleUnit,
      price,
      priceDate: today,
      color,
      tone: toneOf(color),
      tags: [
        ...String(pick(row, 'tags') ?? '')
          .split(/[,|]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        brand.toLowerCase(),
      ],
    };
    if (saleUnit !== 'piece') p.packSize = pack ?? (saleUnit === 'pot' ? 2.5 : 2);
    if (category === 'peinture') Object.assign(p, { coverage: 10, coats: 2, pattern: { kind: 'plaster' }, roughness: 0.9 });
    if (surface) {
      const kind = PATTERNS[norm(String(pick(row, 'pattern') ?? ''))] ?? (category === 'faience' ? 'tiles' : category === 'mur' ? 'wallpaper' : 'planks');
      const w = cm('plankW');
      const l = cm('plankL');
      p.pattern = { kind, ...(w ? { w } : kind === 'planks' ? { w: 0.19 } : {}), ...(l ? { h: l } : kind === 'planks' ? { h: 1.29 } : {}) };
      p.waste = kind === 'tiles' ? 0.1 : 0.08;
      p.roughness = kind === 'tiles' ? 0.4 : 0.6;
    }
    if (category === 'meuble' || category === 'porte' || category === 'fenetre') {
      const sub = SUBCATEGORIES[norm(String(pick(row, 'subcategory') ?? ''))];
      if (category === 'meuble') p.subcategory = sub ?? 'rangement';
      const w = cm('w');
      const d = cm('d');
      const h = cm('h');
      const def = DEFAULT_SIZE[p.subcategory ?? ''] ?? { w: 0.8, d: 0.6, h: category === 'porte' ? 2.04 : category === 'fenetre' ? 1.25 : 0.8 };
      p.size = { w: w ?? def.w, d: d ?? def.d, h: h ?? def.h };
    }
    products.push(p);
  });
  return { products, errors };
}

export function parseCatalogFile(text: string, fileName: string, defaultBrand: string): ImportResult {
  const trimmed = text.trim();
  if (fileName.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return { products: [], errors: [`JSON illisible : ${(e as Error).message}`] };
    }
    const rows = Array.isArray(data) ? data : ((data as { products?: unknown[] }).products ?? []);
    return rowsToProducts(rows as Record<string, unknown>[], defaultBrand);
  }
  return rowsToProducts(parseCsv(text), defaultBrand);
}

/** Modèle à remplir (ou à demander au fournisseur), ouvrable dans Excel. */
export const CSV_TEMPLATE = [
  'reference;nom;marque;categorie;sous-categorie;prix;unite;m2 par paquet;couleur;largeur cm;profondeur cm;hauteur cm;aspect;largeur lame cm;longueur lame cm;mots-cles',
  'IMP-001;Stratifié chêne naturel 8 mm;Ma marque;sol;;34,90;paquet;2,22;#b88a55;;;;lames;19;128;bois,chaleureux',
  'IMP-002;Carrelage grès cérame 60x60 gris;Ma marque;sol;;39,90;paquet;1,44;#7d7f82;;;;carrelage;60;60;moderne',
  'IMP-003;Canapé 3 places tissu vert;Ma marque;meuble;canape;699;piece;;#5f7a63;228;95;83;;;;cosy',
  'IMP-004;Bibliothèque blanche 80 cm;Ma marque;meuble;rangement;79;piece;;#f2f2ef;80;28;202;;;;rangement',
].join('\r\n');
