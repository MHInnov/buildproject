/**
 * Relecture d'un plan retracé par une IA de vision (locale ou Claude), par petites vues.
 *
 * Un petit modèle de vision situe mal les choses sur une grande image, mais reconnaît bien ce qu'il voit
 * sur une vue rapprochée. On lui montre donc, une par une :
 *  - chaque ouverture trouvée par le retraçage, recadrée et tournée pour que le mur soit horizontal
 *    (le mur va de a, à gauche, vers b, à droite) : porte, fenêtre, porte de garage ou rien du tout
 *    (fausse porte sur un pointillé), charnière à gauche ou à droite, ouverture vers le haut ou le bas ;
 *  - chaque façade, par tronçons, pour retrouver les baies que le retraçage a manquées.
 * Ce fichier ne contient que la géométrie et la façon d'appliquer les réponses (testables sans navigateur).
 * Le recadrage des images se fait dans src/aiReview.ts.
 */
import { levelOutline } from './footprint';
import { dist, newId, pointInPolygon } from './geometry';
import type { Building, Opening, OpeningSwing, Point, Wall } from './types';

/** Ce que l'IA a vu d'une ouverture ou d'une baie. */
export type AiOpeningKind = 'porte' | 'porte-fenetre' | 'fenetre' | 'porte-garage' | 'rien';

export interface AiOpeningVerdict {
  kind: AiOpeningKind;
  /** Côté de la charnière sur la vue (mur horizontal) ; « inconnu » pour une fenêtre ou si l'arc n'est pas lisible. */
  hinge: 'gauche' | 'droite' | 'inconnu';
  /** Côté vers lequel le battant s'ouvre sur la vue. */
  opens: 'haut' | 'bas' | 'inconnu';
  leaves: number;
  /** L'IA est sûre d'elle (sinon l'ouverture est seulement signalée « à vérifier »). */
  sure: boolean;
}

/** Baie vue sur un tronçon de façade : bords gauche et droit en pixels de la vue. */
export interface AiStripOpening {
  kind: Exclude<AiOpeningKind, 'rien'>;
  x_start: number;
  x_end: number;
}

/** Une vue à montrer à l'IA : un rectangle du plan, tourné, en coordonnées du monde (mètres). */
export interface ReviewView {
  /** Centre de la vue. */
  center: Point;
  /** Direction horizontale de la vue (le long du mur, de a vers b) et verticale (vers le bas de la vue). */
  u: Point;
  n: Point;
  /** Étendue en mètres, le long du mur et en travers. */
  length: number;
  depth: number;
  /** Taille de l'image en pixels (multiples de 28, la grille des modèles Qwen-VL). */
  width: number;
  height: number;
  /**
   * La vue va de b (à gauche) vers a (à droite) : tournée d'un demi-tour pour que les textes du plan restent
   * à l'endroit. La gauche de la vue est alors le côté b du mur, et le bas sa face droite.
   */
  flipped?: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const to28 = (n: number) => Math.max(224, Math.round(n / 28) * 28);

export function wallFrame(w: Wall): { L: number; u: Point; n: Point } {
  const L = dist(w.a, w.b) || 1;
  const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
  // Normale « gauche » du mur : (-u.y, u.x). L'image a son axe y vers le bas, comme le plan : une fois le
  // mur tourné à l'horizontale (u vers la droite), cette normale pointe vers le bas de la vue.
  return { L, u, n: { x: -u.y, y: u.x } };
}

/**
 * Sens de lecture de la vue : le long du mur, de a vers b, sauf si cela met le dessin la tête en bas
 * (mur tracé de droite à gauche, ou de bas en haut) ; on le lit alors de b vers a.
 */
function viewAxes(w: Wall): { u: Point; n: Point; flipped: boolean } {
  const { u, n } = wallFrame(w);
  const flipped = u.x < -1e-6 || (Math.abs(u.x) <= 1e-6 && u.y < 0);
  return flipped ? { u: { x: -u.x, y: -u.y }, n: { x: -n.x, y: -n.y }, flipped } : { u, n, flipped };
}

/** Vue rapprochée d'une ouverture : la baie au centre, ses jambages et le débattement d'une porte. */
export function openingView(w: Wall, o: Opening): ReviewView {
  const { u } = wallFrame(w);
  const ax = viewAxes(w);
  const center = { x: w.a.x + u.x * o.offset, y: w.a.y + u.y * o.offset };
  const length = Math.max(1.6, o.width + 1.4);
  // Assez profond pour voir l'arc d'une porte de 90 cm de chaque côté du mur
  const depth = Math.max(w.thickness, 0.1) + 2.2;
  const width = 560;
  return { center, u: ax.u, n: ax.n, flipped: ax.flipped, length, depth, width, height: to28((width * depth) / length) };
}

/** Tronçons d'un mur (4,5 m au plus) pour chercher les baies manquées, avec leur début et fin le long du mur. */
export function stripViews(w: Wall): { view: ReviewView; from: number; to: number }[] {
  const { L, u } = wallFrame(w);
  const ax = viewAxes(w);
  if (L < 0.8) return [];
  const count = Math.ceil(L / 4.5);
  const step = L / count;
  const out: { view: ReviewView; from: number; to: number }[] = [];
  for (let i = 0; i < count; i++) {
    const from = i * step;
    const to = (i + 1) * step;
    const mid = (from + to) / 2;
    // Un peu de marge de part et d'autre : une baie à cheval sur deux tronçons reste visible en entier
    const length = to - from + 0.8;
    const depth = Math.max(w.thickness, 0.1) + 1.6;
    const width = 1008;
    out.push({ view: { center: { x: w.a.x + u.x * mid, y: w.a.y + u.y * mid }, u: ax.u, n: ax.n, flipped: ax.flipped, length, depth, width, height: to28((width * depth) / length) }, from, to });
  }
  return out;
}

/**
 * Transformation d'un pixel de l'image du plan (calque : coin en (ul.x, ul.y), ul.scale mètres par pixel) vers
 * un pixel de la vue, au format de CanvasRenderingContext2D.setTransform(a, b, c, d, e, f).
 */
export function viewTransform(v: ReviewView, ul: { x: number; y: number; scale: number }): [number, number, number, number, number, number] {
  const k = v.width / v.length; // pixels de la vue par mètre
  const s = ul.scale;
  const q = { x: ul.x - v.center.x, y: ul.y - v.center.y };
  return [k * s * v.u.x, k * s * v.n.x, k * s * v.u.y, k * s * v.n.y, v.width / 2 + k * (q.x * v.u.x + q.y * v.u.y), v.height / 2 + k * (q.x * v.n.x + q.y * v.n.y)];
}

/** Abscisse le long du mur (mètres depuis a) d'un pixel horizontal d'une vue en tronçon. */
export function stripToOffset(w: Wall, v: ReviewView, px: number): number {
  const { u } = wallFrame(w);
  const along = (px / v.width - 0.5) * v.length * (v.flipped ? -1 : 1);
  return (v.center.x - w.a.x) * u.x + (v.center.y - w.a.y) * u.y + along;
}

/**
 * Sens d'ouverture lu sur la vue (mur horizontal) : charnière à gauche = côté a, battant vers le bas = face
 * gauche du mur ; l'inverse sur une vue retournée.
 */
export function verdictSwing(v: Pick<AiOpeningVerdict, 'hinge' | 'opens'>, flipped = false): OpeningSwing | null {
  if (v.hinge === 'inconnu' || v.opens === 'inconnu') return null;
  const left = v.hinge === 'gauche' !== flipped;
  const down = v.opens === 'bas' !== flipped;
  return { hinge: left ? 'a' : 'b', side: down ? 'gauche' : 'droite' };
}

function inside(p: Point, polys: Point[][]): boolean {
  return polys.some((poly) => pointInPolygon(p, poly));
}

/** Murs de façade d'un niveau : un de leurs côtés donne dehors (hors du contour de la maison). */
export function facadeWalls(b: Building, levelId: string): Wall[] {
  const walls = b.walls.filter((w) => w.levelId === levelId);
  const outline = levelOutline(walls);
  if (!outline.length) return [];
  return walls.filter((w) => {
    if (dist(w.a, w.b) < 0.8) return false;
    const { n } = wallFrame(w);
    const d = w.thickness / 2 + 0.25;
    // Sondé à plusieurs endroits du mur : un angle rentrant peut masquer un des points
    return [0.25, 0.5, 0.75].some((t) => {
      const m = { x: w.a.x + (w.b.x - w.a.x) * t, y: w.a.y + (w.b.y - w.a.y) * t };
      return [1, -1].some((s) => !inside({ x: m.x + n.x * d * s, y: m.y + n.y * d * s }, outline));
    });
  });
}

/** Repère laissé sur un élément lu ou corrigé par l'IA, montré dans l'inspecteur et sur le plan. */
export type AiMark = NonNullable<Opening['ai']>;

const DOOR = 'ex-porte-isoplane';
const WINDOW = 'ex-fenetre-bois-simple';
const GARAGE = 'ex-porte-garage';

const label = (k: AiOpeningKind) => ({ porte: 'porte', 'porte-fenetre': 'porte-fenêtre', fenetre: 'fenêtre', 'porte-garage': 'porte de garage', rien: 'rien' })[k];

function currentKind(o: Opening): AiOpeningKind {
  if (o.productId === GARAGE) return 'porte-garage';
  if (o.kind === 'porte') return 'porte';
  return o.sill < 0.25 ? 'porte-fenetre' : 'fenetre';
}

/** Donne à l'ouverture la nature lue (produit, hauteur, allège par défaut). */
function setKind(o: Opening, k: Exclude<AiOpeningKind, 'rien'>): void {
  if (k === 'porte-garage') {
    o.kind = 'porte';
    o.productId = GARAGE;
    o.height = 2.15;
    o.sill = 0;
    delete o.swing;
  } else if (k === 'porte') {
    o.kind = 'porte';
    o.productId = DOOR;
    o.height = 2.05;
    o.sill = 0;
  } else {
    // Porte-fenêtre : un châssis vitré toute hauteur, compté comme une fenêtre posée au sol
    o.kind = 'fenetre';
    o.productId = WINDOW;
    o.sill = k === 'porte-fenetre' ? 0 : 0.9;
    o.height = k === 'porte-fenetre' ? 2.15 : 1.25;
    delete o.swing;
  }
  delete o.options;
}

export interface ReviewOutcome {
  removed: number;
  changed: number;
  confirmed: number;
  doubtful: number;
  added: number;
}

export const emptyOutcome = (): ReviewOutcome => ({ removed: 0, changed: 0, confirmed: 0, doubtful: 0, added: 0 });

/**
 * Applique le verdict de l'IA sur une ouverture retracée. Une ouverture que l'IA ne voit pas est retirée
 * seulement si elle en est sûre (sinon signalée), une fenêtre n'est jamais mise dans une cloison.
 */
export function applyVerdict(b: Building, openingId: string, v: AiOpeningVerdict, out: ReviewOutcome = emptyOutcome(), flipped = false): ReviewOutcome {
  const o = b.openings.find((x) => x.id === openingId);
  const w = o && b.walls.find((x) => x.id === o.wallId);
  if (!o || !w) return out;
  if (v.kind === 'rien') {
    if (v.sure) {
      b.openings = b.openings.filter((x) => x.id !== openingId);
      out.removed++;
    } else {
      o.ai = { status: 'a-verifier', note: "L'IA ne voit pas d'ouverture ici (pointillé, trait de meuble ?)." };
      out.doubtful++;
    }
    return out;
  }
  const notes: string[] = [];
  const was = currentKind(o);
  const kindOk = !(w.kind === 'cloison' && (v.kind === 'fenetre' || v.kind === 'porte-fenetre' || v.kind === 'porte-garage'));
  if (v.kind !== was && kindOk) {
    if (v.sure) {
      setKind(o, v.kind);
      notes.push(`${label(was)} devenue ${label(v.kind)}`);
    } else {
      o.ai = { status: 'a-verifier', note: `L'IA y voit plutôt une ${label(v.kind)}.` };
      out.doubtful++;
      return out;
    }
  }
  if (o.kind === 'porte' && o.productId !== GARAGE) {
    const sw = verdictSwing(v, flipped);
    if (sw && (!o.swing || o.swing.hinge !== sw.hinge || o.swing.side !== sw.side)) {
      o.swing = sw;
      notes.push("sens d'ouverture corrigé");
    }
    const leaves = Math.round(v.leaves);
    if (leaves === 2 && (o.options?.leaves ?? 1) !== 2) {
      o.options = { ...o.options, leaves: 2 };
      notes.push('deux vantaux');
    }
  }
  if (notes.length) {
    o.ai = { status: 'corrige', note: `Corrigé par l'IA : ${notes.join(', ')}.` };
    out.changed++;
  } else {
    o.ai = { status: 'confirme', note: "Confirmé par l'IA." };
    out.confirmed++;
  }
  return out;
}

/**
 * Ajoute les baies vues sur un tronçon de façade que le retraçage n'avait pas : signalées « à vérifier »
 * (l'IA les situe à une dizaine de centimètres près).
 */
export function applyStrip(b: Building, wallId: string, v: ReviewView, from: number, to: number, seen: AiStripOpening[], out: ReviewOutcome = emptyOutcome()): ReviewOutcome {
  const w = b.walls.find((x) => x.id === wallId);
  if (!w) return out;
  const L = dist(w.a, w.b);
  for (const s of seen) {
    const x0 = Math.min(s.x_start, s.x_end);
    const x1 = Math.max(s.x_start, s.x_end);
    if (!(x1 > x0) || x0 < -v.width * 0.05 || x1 > v.width * 1.05) continue;
    // Sur une vue retournée, le bord gauche de la baie est le plus loin de a
    let a = Math.min(stripToOffset(w, v, x0), stripToOffset(w, v, x1));
    let c = Math.max(stripToOffset(w, v, x0), stripToOffset(w, v, x1));
    const mid = (a + c) / 2;
    // Chaque baie n'est retenue que dans le tronçon qui porte son milieu (les marges se recouvrent)
    if (mid < from - 0.01 || mid >= to + 0.01) continue;
    a = Math.max(0.05, a);
    c = Math.min(L - 0.05, c);
    const width = r2(c - a);
    if (width < 0.45 || width > 3.6) continue;
    const offset = r2((a + c) / 2);
    const overlap = b.openings.some((x) => x.wallId === w.id && Math.abs(x.offset - offset) < (x.width + width) / 2 - 0.05);
    if (overlap) continue;
    if (w.kind === 'cloison' && s.kind !== 'porte') continue;
    const o: Opening = { id: newId('o'), wallId: w.id, kind: 'fenetre', offset, width, height: 1.25, sill: 0.9, productId: WINDOW };
    setKind(o, s.kind);
    o.ai = { status: 'a-verifier', note: `Ajoutée par l'IA (${label(s.kind)} oubliée par le retraçage) : vérifiez sa position et sa largeur.` };
    b.openings.push(o);
    out.added++;
  }
  return out;
}

/** Phrase de compte rendu d'une relecture. */
export function describeOutcome(levelName: string, r: ReviewOutcome): string | null {
  const parts: string[] = [];
  if (r.confirmed) parts.push(`${r.confirmed} ouverture(s) confirmée(s)`);
  if (r.changed) parts.push(`${r.changed} corrigée(s)`);
  if (r.removed) parts.push(`${r.removed} fausse(s) ouverture(s) retirée(s)`);
  if (r.added) parts.push(`${r.added} baie(s) oubliée(s) ajoutée(s)`);
  if (r.doubtful) parts.push(`${r.doubtful} à vérifier`);
  return parts.length ? `${levelName}, relecture par l'IA : ${parts.join(', ')}.` : null;
}
