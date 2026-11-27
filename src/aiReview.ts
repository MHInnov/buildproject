import { aiNameRoom, aiReadStrip, aiReviewOpening } from './ai';
import { useAssets } from './assets';
import { detectRooms, dist, newId } from './model/geometry';
import {
  applyStrip,
  applyVerdict,
  describeOutcome,
  emptyOutcome,
  facadeWalls,
  openingView,
  stripViews,
  viewTransform,
  type AiOpeningVerdict,
  type AiStripOpening,
  type ReviewView,
} from './model/aiReview';
import type { Underlay } from './model/types';
import { useStore } from './store';

/**
 * Relecture d'un niveau retracé par l'IA (locale ou Claude), vue rapprochée par vue rapprochée :
 * chaque ouverture (nature, sens d'ouverture, fausses portes), chaque façade (baies oubliées) et les pièces
 * sans nom. Toutes les corrections sont appliquées d'un coup (un seul « Annuler »), et chaque ouverture
 * touchée garde une note visible dans l'inspecteur.
 */

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Recadre et tourne une partie du plan (fond blanc, JPEG). */
export function renderView(img: CanvasImageSource, ul: Pick<Underlay, 'x' | 'y' | 'scale'>, v: ReviewView): string {
  const c = document.createElement('canvas');
  c.width = v.width;
  c.height = v.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...viewTransform(v, ul));
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.9);
}

const kindName = (k: 'porte' | 'fenetre', sill: number, garage: boolean) => (garage ? 'porte de garage' : k === 'porte' ? 'porte' : sill < 0.25 ? 'porte-fenêtre' : 'fenêtre');

export interface ReviewReport {
  lines: string[];
  warnings: string[];
}

/** Relit un niveau de l'existant sur son plan importé. `progress` reçoit une phrase à afficher. */
export async function reviewLevel(levelId: string, progress: (msg: string) => void, opts: { rooms?: boolean } = {}): Promise<ReviewReport> {
  const rep: ReviewReport = { lines: [], warnings: [] };
  const b = useStore.getState().project.existing;
  const level = b.levels.find((l) => l.id === levelId);
  const ul = level?.underlay;
  const src = ul && useAssets.getState().assets[ul.assetId];
  if (!level || !ul || !src) return rep;
  const img = await loadImage(src);
  const walls = new Map(b.walls.filter((w) => w.levelId === levelId).map((w) => [w.id, w]));
  const openings = b.openings.filter((o) => walls.has(o.wallId));
  const facades = facadeWalls(b, levelId);
  const strips = facades.flatMap((w) => stripViews(w).map((s) => ({ wall: w, ...s })));
  const rooms = opts.rooms === false ? [] : detectRooms(b).filter((r) => r.label.levelId === levelId && (r.label.id.startsWith('auto:') || r.label.name === 'Pièce') && r.area >= 1.5);
  const total = openings.length + strips.length + rooms.length;
  let done = 0;
  let failures = 0;
  const step = (what: string) => progress(`L'IA relit ${level.name} : ${what} (${++done}/${total})…`);
  // Une erreur de connexion arrête tout ; une réponse isolée illisible est seulement sautée
  const tryAsk = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      const m = (e as Error).message;
      if (/injoignable|ne répond pas|n'est pas installé|à temps|clé|401|403/i.test(m) || ++failures > 4) throw e;
      return null;
    }
  };

  const verdicts: { id: string; v: AiOpeningVerdict; flipped: boolean }[] = [];
  for (const o of openings) {
    step('ouvertures');
    const w = walls.get(o.wallId)!;
    const view = openingView(w, o);
    const v = await tryAsk(() => aiReviewOpening(renderView(img, ul, view), { width: o.width, wallThickness: w.thickness, current: kindName(o.kind, o.sill, o.productId === 'ex-porte-garage') }));
    if (v) verdicts.push({ id: o.id, v, flipped: !!view.flipped });
  }
  const seen: { wallId: string; view: ReviewView; from: number; to: number; list: AiStripOpening[] }[] = [];
  for (const s of strips) {
    step('façades');
    const list = await tryAsk(() => aiReadStrip(renderView(img, ul, s.view), { width: s.view.width, height: s.view.height, lengthM: s.to - s.from }));
    if (list?.length) seen.push({ wallId: s.wall.id, view: s.view, from: s.from, to: s.to, list });
  }
  const names: { at: { x: number; y: number }; name: string }[] = [];
  for (const r of rooms) {
    step('pièces');
    const xs = r.polygon.map((p) => p.x);
    const ys = r.polygon.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const length = x1 - x0 + 0.6;
    const depth = y1 - y0 + 0.6;
    const width = Math.round(Math.min(896, Math.max(448, (896 * length) / Math.max(length, depth))) / 28) * 28;
    const view: ReviewView = { center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, u: { x: 1, y: 0 }, n: { x: 0, y: 1 }, length, depth, width, height: Math.max(224, Math.round((width * depth) / length / 28) * 28) };
    const res = await tryAsk(() => aiNameRoom(renderView(img, ul, view), r.area));
    const name = res?.name.trim();
    if (res?.sure && name && name.length <= 40 && !/^pi[eè]ce$/i.test(name)) names.push({ at: r.label.at, name: name[0].toUpperCase() + name.slice(1) });
  }
  if (failures) rep.warnings.push(`${level.name} : ${failures} vue(s) que l'IA n'a pas su lire, laissées telles quelles.`);

  const out = emptyOutcome();
  useStore.getState().editExisting((bb) => {
    for (const { id, v, flipped } of verdicts) applyVerdict(bb, id, v, out, flipped);
    for (const s of seen) applyStrip(bb, s.wallId, s.view, s.from, s.to, s.list, out);
    for (const n of names) {
      bb.rooms = bb.rooms.filter((x) => !(x.levelId === levelId && dist(x.at, n.at) < 0.3));
      bb.rooms.push({ id: newId('r'), levelId, at: n.at, name: n.name, floorProductId: null });
    }
  });
  const line = describeOutcome(level.name, out);
  if (line) rep.lines.push(line);
  if (names.length) rep.lines.push(`${level.name} : ${names.length} pièce(s) nommée(s) par l'IA (${names.map((n) => n.name).join(', ')}).`);
  if (out.doubtful + out.added) rep.lines.push(`Les ouvertures à vérifier sont marquées d'un « ? » orange sur le plan : cliquez dessus pour valider ou supprimer.`);
  return rep;
}
