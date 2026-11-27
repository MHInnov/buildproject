import type { Building, DwellingKind } from './types';

/** Le logement est un appartement : pas de toiture, de jardin ni d'abords, un plafond plat en haut. */
export const isFlat = (b: Pick<Building, 'kind'>): boolean => b.kind === 'appartement';

export const dwellingName = (b: Pick<Building, 'kind'>, def = false): string =>
  isFlat(b) ? (def ? "l'appartement" : 'appartement') : def ? 'la maison' : 'maison';

/**
 * Passe d'une maison à un appartement (ou l'inverse). Un appartement perd sa toiture, son terrain et ses
 * abords (le plafond du dernier niveau est la dalle de l'étage au-dessus) ; une maison retrouve une toiture
 * à deux pans par défaut sur son dernier niveau.
 */
export function setDwellingKind(b: Building, kind: DwellingKind): void {
  if (kind === 'appartement') {
    b.kind = 'appartement';
    b.storey ??= 0;
    b.roof = null;
    delete b.site;
    if (b.outdoor) b.outdoor = { ...b.outdoor, apron: null };
    return;
  }
  delete b.kind;
  delete b.storey;
  if (!b.roof && b.levels.length) {
    const top = [...b.levels].sort((p, q) => q.elevation - p.elevation)[0];
    b.roof = { type: 'deux-pans', levelId: top.id, pitch: 35, overhang: 0.3, ridge: 'x', coveringId: null, insulationId: null };
  }
}
