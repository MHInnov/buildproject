/**
 * Noms des pièces lus sur un plan par OCR (sans IA) : les mots reconnus sont rapprochés d'un vocabulaire
 * de pièces, en tolérant les fautes de lecture d'un lettrage manuscrit ou au normographe
 * (« Coisine », « hambre », « S. de Bain »).
 */

/** Mot reconnu, en pixels de la page. `line` regroupe les mots d'une même ligne de texte. */
export interface OcrWord {
  text: string;
  conf: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  line: number;
}

export interface RoomText {
  name: string;
  x: number;
  y: number;
}

/** Mot-clé (sans accents, en minuscules) → nom de la pièce. */
const KEYS: [string, string][] = [
  ['salon', 'Salon'],
  ['sejour', 'Séjour'],
  ['living', 'Séjour'],
  ['manger', 'Salle à manger'],
  ['cuisine', 'Cuisine'],
  ['chambre', 'Chambre'],
  ['bain', 'Salle de bain'],
  ['bains', 'Salle de bain'],
  ['douche', 'Douche'],
  ['wc', 'WC'],
  ['toilette', 'WC'],
  ['hall', 'Hall'],
  ['entree', 'Entrée'],
  ['vestiaire', 'Vestiaire'],
  ['degagement', 'Dégagement'],
  ['couloir', 'Couloir'],
  ['palier', 'Palier'],
  ['bureau', 'Bureau'],
  ['garage', 'Garage'],
  ['buanderie', 'Buanderie'],
  ['cellier', 'Cellier'],
  ['debarras', 'Débarras'],
  ['rangement', 'Rangement'],
  ['dressing', 'Dressing'],
  ['grenier', 'Grenier'],
  ['cave', 'Cave'],
  ['chaufferie', 'Chaufferie'],
  ['atelier', 'Atelier'],
  ['veranda', 'Véranda'],
  ['mezzanine', 'Mezzanine'],
  ['lingerie', 'Lingerie'],
  ['vide', 'Vide'],
];

/** Mots d'une note technique (« S. de bain étage », « voir plan… ») : la ligne n'est pas le nom d'une pièce. */
const NOTE = ['etage', 'voir', 'pour', 'sous', 'colonne', 'poutre', 'poutrelle', 'evacuation', 'ventilation', 'partir', 'descente', 'chute', 'conduit'];

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Le mot lu est-il ce mot-clé (à une ou deux fautes près, ou amputé de sa première ou dernière lettre) ? */
export function matchesKey(word: string, key: string): boolean {
  if (word === key) return true;
  // Les mots courts doivent être exacts (« wc », « hall », « vide », « cave », « bain »)
  if (key.length <= 4) return key === 'bain' && word === 'bains';
  if (word.length < 4) return false;
  const tol = key.length >= 8 ? 2 : 1;
  if (editDistance(word, key) <= tol) return true;
  // Première ou dernière lettre perdue (« hambre », « cuisin »)
  return word.length >= 5 && word.length === key.length - 1 && (key.endsWith(word) || key.startsWith(word));
}

/**
 * Noms de pièces trouvés parmi les mots lus. `near` : distance (px de la page) sous laquelle deux lectures
 * du même nom (tuiles qui se chevauchent, plusieurs rotations) n'en font qu'une.
 */
export function roomNamesFromWords(words: OcrWord[], near: number): RoomText[] {
  const found: (RoomText & { conf: number })[] = [];
  const byLine = new Map<number, OcrWord[]>();
  for (const w of words) {
    if (!byLine.has(w.line)) byLine.set(w.line, []);
    byLine.get(w.line)!.push(w);
  }
  for (const line of byLine.values()) {
    const norm = line.map((w) => normalize(w.text));
    if (norm.some((t) => t.length >= 4 && NOTE.some((k) => editDistance(t, k) <= (k.length >= 5 ? 1 : 0)))) continue;
    for (let i = 0; i < line.length; i++) {
      const w = line[i];
      const n = norm[i];
      if (w.conf < 55 || !n) continue;
      // Un mot coupé en deux par la lecture (« Gard ge ») : on essaie aussi avec le suivant
      const joined = i + 1 < line.length && line[i + 1].conf >= 55 ? n + norm[i + 1] : '';
      const hit = KEYS.find(([k]) => matchesKey(n, k)) ?? (joined ? KEYS.find(([k]) => k.length > 4 && matchesKey(joined, k)) : undefined);
      if (!hit) continue;
      let name = hit[1];
      let box = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
      const next = norm.slice(i + 1, i + 4);
      // « Chambre 2 », « Hall de nuit », « Vide sur hall »
      if (name === 'Chambre') {
        const num = next.findIndex((t) => /^[1-9]$/.test(t));
        // (un chiffre mal lu donnerait un faux numéro : seulement s'il est lu avec assurance)
        if (num >= 0 && num <= 1 && line[i + 1 + num].conf >= 45) name = `Chambre ${next[num]}`;
      }
      if (name === 'Hall' && next.some((t) => t.length === 4 && editDistance(t, 'nuit') <= 1)) name = 'Hall de nuit';
      if (name === 'Hall' && norm.slice(0, i).some((t) => t === 'entree')) continue;
      if (name === 'Vide' && next.length === 0 && line.length === 1 && w.conf < 75) continue;
      // Le nom couvre toute la ligne : son centre est celui de la ligne
      for (const o of line) {
        box = { x0: Math.min(box.x0, o.x0), y0: Math.min(box.y0, o.y0), x1: Math.max(box.x1, o.x1), y1: Math.max(box.y1, o.y1) };
      }
      found.push({ name, x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, conf: w.conf });
      break;
    }
  }
  // Doublons : même nom (ou « Chambre » et « Chambre 2 ») lu deux fois au même endroit
  found.sort((a, b) => b.name.length - a.name.length || b.conf - a.conf);
  const out: RoomText[] = [];
  for (const f of found) {
    const base = (s: string) => s.replace(/ \d$/, '').replace(/ de nuit$/, '');
    if (out.some((o) => base(o.name) === base(f.name) && Math.hypot(o.x - f.x, o.y - f.y) < near)) continue;
    out.push({ name: f.name, x: Math.round(f.x), y: Math.round(f.y) });
  }
  return out;
}
