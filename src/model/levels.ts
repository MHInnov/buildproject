import type { Building, Level, Project } from './types';

export const DEFAULT_LEVEL_ID = 'rdc';

export const defaultLevel = (): Level => ({ id: DEFAULT_LEVEL_ID, name: 'Rez-de-chaussée', elevation: 0, height: 2.6, slab: 0.22 });

export function levelById(b: Building, id: string | null | undefined): Level | undefined {
  return b.levels.find((l) => l.id === id);
}

/** Niveau situé juste au-dessus (ou undefined pour le dernier). */
export function levelAbove(b: Building, id: string): Level | undefined {
  const sorted = [...b.levels].sort((m, n) => m.elevation - n.elevation);
  const i = sorted.findIndex((l) => l.id === id);
  return i >= 0 ? sorted[i + 1] : undefined;
}

export function levelBelow(b: Building, id: string): Level | undefined {
  const sorted = [...b.levels].sort((m, n) => m.elevation - n.elevation);
  const i = sorted.findIndex((l) => l.id === id);
  return i > 0 ? sorted[i - 1] : undefined;
}

/** Hauteur à franchir pour monter au niveau supérieur (sol à sol). */
export function floorToFloor(l: Level): number {
  return l.height + l.slab;
}

/** Ne garde que les éléments d'un niveau (les ouvertures suivent leur mur). */
export function onLevel(b: Building, levelId: string): Building {
  const walls = b.walls.filter((w) => w.levelId === levelId);
  const ids = new Set(walls.map((w) => w.id));
  return {
    levels: b.levels,
    walls,
    openings: b.openings.filter((o) => ids.has(o.wallId)),
    rooms: b.rooms.filter((r) => r.levelId === levelId),
    furniture: b.furniture.filter((f) => f.levelId === levelId),
    floorZones: (b.floorZones ?? []).filter((z) => z.levelId === levelId),
    roof: b.roof,
  };
}

/** Met à jour les projets enregistrés avec une version précédente (un seul niveau, pas de toit). */
export function migrateProject(raw: unknown): Project | null {
  const p = raw as Omit<Partial<Project>, 'version'> & { version?: number; existing?: Partial<Building> };
  if (!p || typeof p !== 'object' || !p.existing) return null;
  if (p.version !== 1 && p.version !== 2) return null;
  const b = p.existing as Building;
  if (!Array.isArray(b.levels) || b.levels.length === 0) b.levels = [defaultLevel()];
  const first = b.levels[0].id;
  for (const w of b.walls ?? []) w.levelId ??= first;
  for (const r of b.rooms ?? []) r.levelId ??= first;
  for (const f of b.furniture ?? []) f.levelId ??= first;
  b.walls ??= [];
  b.openings ??= [];
  b.rooms ??= [];
  b.furniture ??= [];
  b.floorZones ??= [];
  b.roof ??= null;
  for (const op of p.operations ?? []) {
    if (op.type === 'addWall') op.wall.levelId ??= first;
    if (op.type === 'addFurniture') op.item.levelId ??= first;
  }
  return {
    ...(p as unknown as Project),
    version: 2,
    operations: p.operations ?? [],
    viewpoints: p.viewpoints ?? [],
    artisans: p.artisans ?? [],
    assignments: p.assignments ?? {},
  };
}
