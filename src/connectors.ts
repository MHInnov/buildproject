import { create } from 'zustand';
import type { Category, Product } from './model/catalog';
import { rowsToProducts } from './catalogImport';

/**
 * Connecteurs de catalogues : recherches de produits chez des services tiers, avec la clé de l'utilisateur.
 * Les appels passent par le relais du serveur (/connecteurs/…, voir nginx.conf) et ne partent
 * que si la clé du connecteur est renseignée dans l'administration.
 */
export interface ConnectorSettings {
  /** Jeton API Apify (console.apify.com > Settings > API & Integrations). */
  apifyToken: string;
  /** Acteur Apify qui renvoie les produits IKEA. */
  apifyActor: string;
  /** Clé API Writ (wt_…) pour la recherche Brico.be. */
  writKey: string;
}

export type ConnectorId = 'ikea' | 'brico';

export const CONNECTORS: { id: ConnectorId; label: string; source: string }[] = [
  { id: 'ikea', label: 'IKEA (via Apify)', source: 'IKEA' },
  { id: 'brico', label: 'Brico.be (via Writ)', source: 'Brico' },
];

const KEY = 'construprojet:connecteurs';

function load(): ConnectorSettings {
  const d: ConnectorSettings = { apifyToken: '', apifyActor: 'mynewhome~ikea', writKey: '' };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ConnectorSettings>) };
  } catch {
    return d;
  }
}

export const useConnectors = create<ConnectorSettings & { update: (p: Partial<ConnectorSettings>) => void }>((set, get) => ({
  ...load(),
  update: (p) => {
    set(p);
    const { apifyToken, apifyActor, writKey } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ apifyToken, apifyActor, writKey }));
    } catch {
      /* stockage indisponible */
    }
  },
}));

export function connectorReady(id: ConnectorId, s: ConnectorSettings = useConnectors.getState()): boolean {
  if (id === 'ikea') return s.apifyToken.trim().length > 10 && s.apifyActor.trim().length > 2;
  return s.writKey.trim().startsWith('wt_');
}

/** Produit trouvé chez un fournisseur, avant ajout au catalogue. */
export interface FoundProduct {
  key: string;
  name: string;
  brand: string;
  price: number | null;
  url?: string;
  image?: string;
  /** Ligne prête pour rowsToProducts (en-têtes du modèle CSV). */
  row: Record<string, unknown>;
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Service injoignable (connexion Internet, ou relais /connecteurs absent : lancez l'application avec Docker ou npm run dev).");
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown; message?: string };
      detail = (typeof j.error === 'object' ? j.error?.message : j.error) ?? (typeof j.detail === 'string' ? j.detail : undefined) ?? j.message ?? detail;
    } catch {
      /* réponse non JSON */
    }
    if (res.status === 401 || res.status === 403) throw new Error(`Clé refusée par le service (${res.status}) : ${detail}`);
    if (res.status === 402 || res.status === 429) throw new Error(`Crédits ou quota épuisés (${res.status}) : ${detail}`);
    throw new Error(`Erreur ${res.status} : ${detail}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Réponse illisible du service.');
  }
}

/** Le premier tableau d'objets trouvé dans la réponse (les services emballent les résultats différemment). */
export function findItems(data: unknown, depth = 0): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    if (data.some((x) => x && typeof x === 'object' && !Array.isArray(x))) return data as Record<string, unknown>[];
    return [];
  }
  if (!data || typeof data !== 'object' || depth > 4) return [];
  const o = data as Record<string, unknown>;
  for (const k of ['products', 'items', 'results', 'data', 'extracted_data', 'result', 'output', 'hits']) {
    const r = k in o ? findItems(o[k], depth + 1) : [];
    if (r.length) return r;
  }
  for (const v of Object.values(o)) {
    const r = findItems(v, depth + 1);
    if (r.length) return r;
  }
  return [];
}

const get = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) {
    const path = k.split('.');
    let v: unknown = o;
    for (const p of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function priceOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = v.replace(/\s/g, '').match(/\d+(?:[.,]\d+)?/);
    return m ? Number(m[0].replace(',', '.')) : null;
  }
  if (v && typeof v === 'object') return priceOf(get(v as Record<string, unknown>, 'value', 'amount', 'current', 'currentPrice', 'price', 'numeral'));
  return null;
}

/** Dimensions « 80x28x202 cm », « Largeur: 80 cm, Profondeur: 28 cm, Hauteur: 202 cm »… */
export function parseDimensions(text: string): { w?: number; d?: number; h?: number } {
  const t = text.toLowerCase().replace(/,(\d)/g, '.$1');
  const out: { w?: number; d?: number; h?: number } = {};
  const named = (re: RegExp) => {
    const m = t.match(re);
    return m ? Number(m[1]) * (/mm/.test(m[2] ?? '') ? 0.1 : 1) : undefined;
  };
  out.w = named(/(?:largeur|width|longueur|length)\s*:?\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  out.d = named(/(?:profondeur|depth)\s*:?\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  out.h = named(/(?:hauteur|height)\s*:?\s*(\d+(?:\.\d+)?)\s*(mm|cm)?/);
  if (out.w === undefined) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*(mm|cm)?/);
    if (m) {
      const k = m[4] === 'mm' ? 0.1 : 1;
      out.w = Number(m[1]) * k;
      out.d = Number(m[2]) * k;
      if (m[3]) out.h = Number(m[3]) * k;
    }
  }
  return out; // en cm
}

/** Couleur approximative d'après le nom (les services ne donnent pas de code couleur). */
const COLOR_WORDS: [RegExp, string][] = [
  [/blanc|white|wit/, '#f2f1ec'],
  [/noir|black|zwart|anthracite/, '#2b2b2b'],
  [/gris|grey|gray|grijs|béton|beton/, '#9a9893'],
  [/beige|lin|sable|crème|creme|naturel/, '#d9ccb4'],
  [/chêne foncé|noyer|walnut|wengé|wenge|brun|brown|marron/, '#6e4b2f'],
  [/chêne|chene|oak|eik|bois|wood|hêtre|bouleau|pin/, '#c49a63'],
  [/vert|green|groen|sauge/, '#7d9474'],
  [/bleu|blue|blauw/, '#4f6d8f'],
  [/rouge|red|rood|terracotta/, '#a8503b'],
  [/jaune|yellow|ocre/, '#d8b24a'],
  [/rose|pink/, '#d9a3a3'],
];
export function colorFromName(name: string): string {
  const n = name.toLowerCase();
  return COLOR_WORDS.find(([re]) => re.test(n))?.[1] ?? '#b5a48c';
}

const SUB_WORDS: [RegExp, string][] = [
  [/canap|sofa|fauteuil|banquette/, 'canape'],
  [/bureau|desk/, 'bureau'],
  [/chaise|tabouret|chair|stool/, 'chaise'],
  [/\blit\b|bed|sommier/, 'lit'],
  [/armoire|penderie|garde-robe|wardrobe/, 'armoire'],
  [/cuisine|kitchen/, 'cuisine'],
  [/table/, 'table'],
  [/étag|etag|biblioth|commode|buffet|meuble|rangement|shelf|bookcase/, 'rangement'],
];

/** Transforme les résultats bruts d'un service en produits proposables. */
export function toFound(items: Record<string, unknown>[], source: string, category: Category): FoundProduct[] {
  return items.flatMap((it, i) => {
    const name = String(get(it, 'name', 'title', 'productName', 'product_name', 'label', 'typeName') ?? '').trim();
    if (!name) return [];
    const type = String(get(it, 'typeName', 'type', 'description', 'subtitle') ?? '');
    const fullName = type && !name.toLowerCase().includes(type.toLowerCase()) ? `${name} ${type}` : name;
    const price = priceOf(get(it, 'price', 'salesPrice', 'priceNumeral', 'currentPrice', 'price_value', 'offers.price'));
    const url = get(it, 'url', 'pipUrl', 'link', 'productUrl', 'product_url') as string | undefined;
    const image = get(it, 'image', 'imageUrl', 'image_url', 'mainImageUrl', 'images.0', 'thumbnail', 'img') as string | undefined;
    const brand = String(get(it, 'brand', 'brandName', 'marque') ?? source);
    const ref = String(get(it, 'id', 'sku', 'itemNo', 'productId', 'reference', 'ean', 'url') ?? `${source}-${i}`);
    const dims = parseDimensions(String(get(it, 'measurements', 'dimensions', 'size', 'itemMeasureReferenceText', 'specifications') ?? '') + ' ' + fullName);
    const sub = SUB_WORDS.find(([re]) => re.test(fullName.toLowerCase()))?.[1];
    const perM2 = /m²|m2/.test(String(get(it, 'priceUnit', 'unit', 'price_unit') ?? '') + String(get(it, 'price') ?? ''));
    const row: Record<string, unknown> = {
      reference: ref,
      nom: fullName,
      marque: brand,
      categorie: category,
      'sous-categorie': sub,
      prix: price ?? undefined,
      couleur: colorFromName(fullName),
      largeur: dims.w,
      profondeur: dims.d,
      hauteur: dims.h,
      lien: url,
      ...(category === 'sol' && perM2 ? { unite: 'm2', 'm2 par paquet': 1 } : {}),
    };
    return [{ key: `${ref}-${i}`, name: fullName, brand, price, url: typeof url === 'string' ? url : undefined, image: typeof image === 'string' ? image : undefined, row }];
  });
}

export async function searchConnector(id: ConnectorId, query: string, max: number, category: Category): Promise<FoundProduct[]> {
  const s = useConnectors.getState();
  if (!connectorReady(id, s)) throw new Error("Connecteur non configuré : renseignez d'abord votre clé.");
  if (id === 'ikea') {
    const data = await call(`/connecteurs/apify/v2/acts/${encodeURIComponent(s.apifyActor.trim())}/run-sync-get-dataset-items?format=json&clean=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apifyToken.trim()}` },
      body: JSON.stringify({ SEARCH_TERM: query, MAX_ITEMS: max }),
    });
    return toFound(findItems(data), 'IKEA', category);
  }
  const params = new URLSearchParams({ function_name: 'search_products', query, page: '1', page_size: String(max), sort: 'default' });
  const data = await call(`/connecteurs/writ/api/marketplace/listings/brico-be-product-search/run?${params}`, {
    headers: { Authorization: `Bearer ${s.writKey.trim()}` },
  });
  return toFound(findItems(data), 'Brico', category);
}

/** Produits du catalogue à partir des résultats cochés. */
export function foundToProducts(found: FoundProduct[]): { products: Product[]; errors: string[] } {
  return rowsToProducts(
    found.map((f) => f.row),
    found[0]?.brand ?? 'Fournisseur',
  );
}
