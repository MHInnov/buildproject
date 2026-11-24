import { applyOperations } from './operations';
import type { Operation, Project, Wall } from './types';
import type { Catalog } from './catalog';
import { productById } from './catalog';

export interface ProjectDiff {
  demolished: Wall[];
  newWallIds: Set<string>;
  newFurnitureIds: Set<string>;
  newOpeningIds: Set<string>;
}

const derivesFrom = (id: string, base: Set<string>) => {
  if (base.has(id)) return true;
  for (const b of base) if (id.startsWith(`${b}.`)) return true;
  return false;
};

export function projectDiff(project: Project): ProjectDiff {
  const demolished: Wall[] = [];
  project.operations.forEach((op, i) => {
    if (op.type !== 'demolishWall') return;
    const before = applyOperations(project.existing, project.operations.slice(0, i));
    const w = before.walls.find((x) => x.id === op.wallId);
    if (w) demolished.push(w);
  });
  const projected = applyOperations(project.existing, project.operations);
  const existingWalls = new Set(project.existing.walls.map((w) => w.id));
  return {
    demolished,
    newWallIds: new Set(projected.walls.filter((w) => !derivesFrom(w.id, existingWalls)).map((w) => w.id)),
    newFurnitureIds: new Set(project.operations.flatMap((o) => (o.type === 'addFurniture' ? [o.item.id] : []))),
    newOpeningIds: new Set(project.operations.flatMap((o) => (o.type === 'addOpening' ? [o.opening.id] : []))),
  };
}

const fmtDim = (n: number) => n.toLocaleString('fr-BE', { maximumFractionDigits: 2 });

/** Description lisible d'une opération pour la liste des modifications. */
export function describeOperation(op: Operation, catalog: Catalog, roomName: (id: string) => string): string {
  const pn = (id: string | null) => productById(catalog, id)?.name ?? 'produit inconnu';
  switch (op.type) {
    case 'demolishWall':
      return 'Démolir un mur';
    case 'addWall':
      return 'Construire une cloison';
    case 'addOpening':
      return `Créer une ${op.opening.kind === 'porte' ? 'porte' : 'fenêtre'} (${pn(op.opening.productId)})`;
    case 'removeOpening':
      return 'Supprimer une ouverture';
    case 'replaceOpening':
      return `Remplacer par : ${pn(op.productId)}`;
    case 'setFloor':
      return `Sol de ${roomName(op.roomId)} : ${pn(op.productId)}`;
    case 'setWallFinish':
      return `Mur : ${pn(op.productId)}`;
    case 'addFloorZone':
      return `Zone de sol ${fmtDim(op.zone.w)} × ${fmtDim(op.zone.h)} m : ${op.zone.productId ? pn(op.zone.productId) : 'revêtement à choisir'}`;
    case 'setFloorZone':
      return `Zone de sol : ${pn(op.productId)}`;
    case 'removeFloorZone':
      return 'Retirer une zone de sol';
    case 'addFurniture':
      return `Ajouter : ${pn(op.item.productId)}`;
    case 'removeFurniture':
      return 'Retirer un meuble';
    case 'moveFurniture':
      return 'Déplacer un meuble';
    case 'setRoofCovering':
      return `Toiture : ${pn(op.productId)}`;
    case 'setRoofInsulation':
      return `Isolation de toiture : ${pn(op.productId)}`;
  }
}
