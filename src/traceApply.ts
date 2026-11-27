import { dist, insertWall, newId, projectOnSegment } from './model/geometry';
import type { AiPlanResult } from './ai';
import type { Building, Level, Opening, OpeningSwing, Underlay, Wall } from './model/types';
import type { VectorizeResult } from './model/vectorize';

/**
 * Remplace les murs d'un niveau par ceux d'un retraçage. Les coordonnées retracées (en mètres,
 * depuis le coin de l'image) sont mises à l'échelle `k` puis décalées de (dx, dy).
 */
export function applyTrace(b: Building, levelId: string, r: VectorizeResult, dx: number, dy: number, k = 1): void {
  const level = b.levels.find((l) => l.id === levelId);
  if (!level) return;
  const old = new Set(b.walls.filter((w) => w.levelId === levelId).map((w) => w.id));
  b.walls = b.walls.filter((w) => !old.has(w.id));
  b.openings = b.openings.filter((o) => !old.has(o.wallId));
  const P = (p: { x: number; y: number }) => ({ x: Math.round((p.x * k + dx) * 100) / 100, y: Math.round((p.y * k + dy) * 100) / 100 });
  const placed: { wall: Wall; openings: VectorizeResult['openings'] }[] = [];
  // Un même mur lu deux fois (mêmes bouts à 3 cm près) : un seul est posé, avec les ouvertures des deux
  const same = (m: { a: { x: number; y: number }; b: { x: number; y: number } }, n: typeof m) =>
    (dist(m.a, n.a) < 0.03 && dist(m.b, n.b) < 0.03) || (dist(m.a, n.b) < 0.03 && dist(m.b, n.a) < 0.03);
  const canon = r.walls.map((tw, i) => r.walls.findIndex((x, j) => j <= i && same(x, tw)));
  r.walls.forEach((tw, i) => {
    if (canon[i] !== i) return;
    const wall: Wall = {
      id: newId('w'),
      levelId,
      a: P(tw.a),
      b: P(tw.b),
      thickness: Math.round(tw.thickness * k * 100) / 100,
      height: level.height,
      kind: tw.thickness >= 0.2 ? 'porteur' : 'cloison',
      finish: { gauche: null, droite: null },
      ...(tw.layers ? { layers: tw.layers.map((l) => ({ ...l, thickness: Math.round(l.thickness * k * 100) / 100 })) } : {}),
    };
    insertWall(b, wall);
    placed.push({ wall, openings: r.openings.filter((o) => canon[o.wall] === i) });
  });
  // Façade d'une porte de garage : la baie et son poteau sont lus minces, le mur reste une façade
  const thick = placed.map((p) => p.wall.thickness).filter((t) => t >= 0.2).sort((m, n) => m - n);
  const facade = thick.length ? thick[Math.floor(thick.length / 2)] : 0.3;
  // Murs épais d'une même maison : une seule épaisseur (lue à quelques cm près, les tronçons d'une même
  // façade feraient des ressauts visibles), sauf un mur nettement plus épais (cheminée, mur mitoyen)
  for (const w of b.walls) if (w.levelId === levelId && w.thickness >= 0.2 && Math.abs(w.thickness - facade) <= 0.12) w.thickness = facade;
  for (const p of placed) {
    if (!p.openings.some((o) => o.garage) || p.wall.thickness >= 0.2) continue;
    for (const w of b.walls.filter((x) => x.levelId === levelId && dist(x.a, x.b) > 0 && onSegment(x, p.wall))) {
      w.thickness = facade;
      w.kind = 'porteur';
    }
    p.wall.thickness = facade;
    p.wall.kind = 'porteur';
  }
  // Les ouvertures sont rattachées au tronçon de mur qui les contient après découpe.
  for (const { wall, openings } of placed) {
    const L = dist(wall.a, wall.b);
    for (const o of openings) {
      const t = (o.offset * k) / L;
      const pt = { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
      const piece = b.walls.find((w) => w.levelId === levelId && projectOnSegment(pt, w.a, w.b).d < 0.02 && projectOnSegment(pt, w.a, w.b).t > 0 && projectOnSegment(pt, w.a, w.b).t < 1);
      if (!piece) continue;
      const op: Opening = {
        id: newId('o'),
        wallId: piece.id,
        kind: o.kind,
        offset: Math.round(dist(piece.a, pt) * 100) / 100,
        width: Math.round(o.width * k * 100) / 100,
        height: o.garage ? 2.15 : o.kind === 'porte' ? 2.05 : 1.25,
        sill: o.kind === 'porte' ? 0 : 0.9,
        productId: o.garage ? 'ex-porte-garage' : o.kind === 'porte' ? 'ex-porte-isoplane' : 'ex-fenetre-bois-simple',
      };
      if (o.kind === 'porte' && o.swing) op.swing = swingOnPiece(wall, piece, o.swing);
      if (o.kind === 'porte' && (o.leaves ?? 1) > 1) op.options = { leaves: o.leaves };
      // Même baie lue deux fois (une large et ses morceaux entre trumeaux) : la première lecture reste
      const twin = b.openings.find((x) => x.wallId === op.wallId && Math.abs(x.offset - op.offset) < ((x.width + op.width) / 2) * 0.6);
      if (twin) continue;
      b.openings.push(op);
    }
  }
}

/** Sens d'ouverture lu sur le mur retracé, ramené au tronçon qui porte la porte (sa direction peut différer). */
function swingOnPiece(wall: Wall, piece: Wall, sw: OpeningSwing): OpeningSwing {
  const L = dist(wall.a, wall.b) || 1;
  const u = { x: (wall.b.x - wall.a.x) / L, y: (wall.b.y - wall.a.y) / L };
  const Lp = dist(piece.a, piece.b) || 1;
  const up = { x: (piece.b.x - piece.a.x) / Lp, y: (piece.b.y - piece.a.y) / Lp };
  // charnière : vers a (-u) ou vers b (+u) ; débattement : normale gauche (-u.y, u.x) ou son opposée
  const h = sw.hinge === 'a' ? -1 : 1;
  const sg = sw.side === 'gauche' ? 1 : -1;
  const n = { x: -u.y * sg, y: u.x * sg };
  const np = { x: -up.y, y: up.x };
  return { hinge: h * (u.x * up.x + u.y * up.y) < 0 ? 'a' : 'b', side: n.x * np.x + n.y * np.y > 0 ? 'gauche' : 'droite' };
}

/** Tronçon `x` pris sur le mur `w` (découpé à l'insertion). */
function onSegment(x: Wall, w: Wall): boolean {
  return projectOnSegment(x.a, w.a, w.b).d < 0.02 && projectOnSegment(x.b, w.a, w.b).d < 0.02;
}

/** Niveau du rez-de-chaussée : celui dont le sol est le plus proche de 0. */
export function groundLevel(b: Building): Level {
  return [...b.levels].sort((m, n) => Math.abs(m.elevation) - Math.abs(n.elevation))[0];
}

/** Applique des hauteurs lues sur une coupe aux niveaux, du plus bas au plus haut, le rez-de-chaussée restant à 0. */
export function applyStoreys(b: Building, storeys: { height: number; slab: number }[], firstLevelId?: string): string[] {
  const sorted = [...b.levels].sort((m, n) => m.elevation - n.elevation);
  const start = firstLevelId ? Math.max(0, sorted.findIndex((l) => l.id === firstLevelId)) : 0;
  const changed: string[] = [];
  storeys.forEach((s, i) => {
    const l = sorted[start + i];
    if (!l || s.height < 1.6 || s.height > 6) return;
    const before = l.height;
    l.height = s.height;
    if (s.slab > 0.08 && s.slab < 0.6) l.slab = s.slab;
    for (const w of b.walls) if (w.levelId === l.id && Math.abs(w.height - before) < 0.01) w.height = l.height;
    changed.push(l.id);
  });
  // Altitudes : le rez-de-chaussée reste à 0, on empile au-dessus et en dessous
  const g = groundLevel(b);
  const gi = sorted.indexOf(g);
  for (let i = gi + 1; i < sorted.length; i++) sorted[i].elevation = Math.round((sorted[i - 1].elevation + sorted[i - 1].height + sorted[i - 1].slab) * 100) / 100;
  for (let i = gi - 1; i >= 0; i--) sorted[i].elevation = Math.round((sorted[i + 1].elevation - sorted[i].height - sorted[i].slab) * 100) / 100;
  return changed;
}

/**
 * Ajoute ce que l'IA a lu sur un plan : noms des pièces, et les portes et fenêtres que le retraçage a manquées.
 * L'IA situe mal les ouvertures à quelques centimètres près : elle ne fait que compléter, et ne met
 * jamais de fenêtre dans une cloison.
 */
export function applyAiReading(b: Building, levelId: string, ul: Pick<Underlay, 'x' | 'y' | 'scale'>, res: AiPlanResult): void {
  const at = (p: { x: number; y: number }) => ({ x: ul.x + p.x * ul.scale, y: ul.y + p.y * ul.scale });
  for (const r of res.rooms) {
    const p = at(r);
    b.rooms = b.rooms.filter((x) => !(x.levelId === levelId && dist(x.at, p) < 0.5));
    b.rooms.push({ id: newId('r'), levelId, at: p, name: r.name, floorProductId: null });
  }
  const walls = b.walls.filter((w) => w.levelId === levelId);
  for (const o of res.openings) {
    const pt = at(o);
    let best: { w: Wall; d: number } | null = null;
    for (const w of walls) {
      const d = projectOnSegment(pt, w.a, w.b).d;
      if (d < 0.2 && (!best || d < best.d)) best = { w, d };
    }
    if (!best) continue;
    if (o.kind === 'fenetre' && best.w.kind === 'cloison') continue;
    const w = best.w;
    const offset = Math.round(dist(w.a, projectOnSegment(pt, w.a, w.b).point) * 100) / 100;
    if (b.openings.some((x) => x.wallId === w.id && Math.abs(x.offset - offset) < 0.5 + x.width / 2)) continue;
    b.openings.push({
      id: newId('o'),
      wallId: w.id,
      kind: o.kind,
      offset,
      width: Math.round(Math.max(0.5, Math.min(3, o.width_px * ul.scale)) * 100) / 100,
      height: o.kind === 'porte' ? 2.05 : 1.25,
      sill: o.kind === 'porte' ? 0 : 0.9,
      productId: o.kind === 'porte' ? 'ex-porte-isoplane' : 'ex-fenetre-bois-simple',
    });
  }
}
