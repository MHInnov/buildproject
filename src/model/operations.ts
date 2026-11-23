import { cloneBuilding, insertWall, parseAutoRoomId } from './geometry';
import type { Building, Operation } from './types';

/** Applique les opérations du projet à l'existant et renvoie le bâtiment projeté. */
export function applyOperations(existing: Building, ops: Operation[]): Building {
  const b = cloneBuilding(existing);
  for (const op of ops) applyOne(b, op);
  return b;
}

function applyOne(b: Building, op: Operation): void {
  switch (op.type) {
    case 'demolishWall':
      b.walls = b.walls.filter((w) => w.id !== op.wallId);
      b.openings = b.openings.filter((o) => o.wallId !== op.wallId);
      return;
    case 'addWall':
      insertWall(b, structuredClone(op.wall));
      return;
    case 'addOpening':
      if (b.walls.some((w) => w.id === op.opening.wallId)) b.openings.push(structuredClone(op.opening));
      return;
    case 'removeOpening':
      b.openings = b.openings.filter((o) => o.id !== op.openingId);
      return;
    case 'replaceOpening': {
      const o = b.openings.find((x) => x.id === op.openingId);
      if (o) o.productId = op.productId;
      return;
    }
    case 'setFloor': {
      const label = b.rooms.find((r) => r.id === op.roomId);
      if (label) label.floorProductId = op.productId;
      else {
        const at = parseAutoRoomId(op.roomId);
        if (at) b.rooms.push({ id: op.roomId, at, name: 'Pièce', floorProductId: op.productId });
      }
      return;
    }
    case 'setWallFinish': {
      const w = b.walls.find((x) => x.id === op.wallId);
      if (w) w.finish[op.side] = op.productId;
      return;
    }
    case 'addFurniture':
      b.furniture.push(structuredClone(op.item));
      return;
    case 'removeFurniture':
      b.furniture = b.furniture.filter((f) => f.id !== op.furnitureId);
      return;
    case 'moveFurniture': {
      const f = b.furniture.find((x) => x.id === op.furnitureId);
      if (f) {
        f.x = op.x;
        f.y = op.y;
        f.rotation = op.rotation;
      }
      return;
    }
  }
}

/** Clé de cible : deux opérations de même clé se remplacent (la dernière gagne). */
function targetKey(op: Operation): string | null {
  switch (op.type) {
    case 'setFloor':
      return `floor:${op.roomId}`;
    case 'setWallFinish':
      return `finish:${op.wallId}:${op.side}`;
    case 'replaceOpening':
      return `opening:${op.openingId}`;
    case 'moveFurniture':
      return `move:${op.furnitureId}`;
    default:
      return null;
  }
}

/**
 * Ajoute une opération en simplifiant la liste :
 * - une modification de la même cible remplace la précédente ;
 * - supprimer un élément ajouté dans le projet annule simplement son ajout.
 */
export function pushOperation(ops: Operation[], op: Operation): Operation[] {
  const k = targetKey(op);
  let next = k ? ops.filter((o) => targetKey(o) !== k) : [...ops];

  if (op.type === 'removeFurniture') {
    const added = next.find((o) => o.type === 'addFurniture' && o.item.id === op.furnitureId);
    if (added) return next.filter((o) => !(o.type === 'addFurniture' && o.item.id === op.furnitureId) && !(o.type === 'moveFurniture' && o.furnitureId === op.furnitureId));
    next = next.filter((o) => !(o.type === 'moveFurniture' && o.furnitureId === op.furnitureId));
  }
  if (op.type === 'moveFurniture') {
    const added = next.find((o): o is Extract<Operation, { type: 'addFurniture' }> => o.type === 'addFurniture' && o.item.id === op.furnitureId);
    if (added) {
      return next.map((o) =>
        o === added ? { ...added, item: { ...added.item, x: op.x, y: op.y, rotation: op.rotation } } : o,
      );
    }
  }
  if (op.type === 'removeOpening') {
    const added = next.find((o) => o.type === 'addOpening' && o.opening.id === op.openingId);
    if (added) return next.filter((o) => o !== added && !(o.type === 'replaceOpening' && o.openingId === op.openingId));
    next = next.filter((o) => !(o.type === 'replaceOpening' && o.openingId === op.openingId));
  }
  if (op.type === 'replaceOpening') {
    const added = next.find((o): o is Extract<Operation, { type: 'addOpening' }> => o.type === 'addOpening' && o.opening.id === op.openingId);
    if (added) return next.map((o) => (o === added ? { ...added, opening: { ...added.opening, productId: op.productId } } : o));
  }
  if (op.type === 'demolishWall') {
    const added = next.find((o) => o.type === 'addWall' && (o.wall.id === op.wallId || op.wallId.startsWith(`${o.wall.id}.`)));
    if (added && added.type === 'addWall' && added.wall.id === op.wallId) {
      return next.filter((o) => o !== added && !(o.type === 'setWallFinish' && o.wallId === op.wallId));
    }
    next = next.filter((o) => !(o.type === 'setWallFinish' && o.wallId === op.wallId));
  }
  return [...next, op];
}
