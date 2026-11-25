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
      if (o) {
        o.productId = op.productId;
        if (op.options) o.options = structuredClone(op.options);
        else delete o.options;
      }
      return;
    }
    case 'setFloor': {
      const label = b.rooms.find((r) => r.id === op.roomId);
      if (label) label.floorProductId = op.productId;
      else {
        const auto = parseAutoRoomId(op.roomId);
        if (auto) b.rooms.push({ id: op.roomId, levelId: auto.levelId, at: auto.at, name: 'Pièce', floorProductId: op.productId });
      }
      return;
    }
    case 'addFloorZone':
      (b.floorZones ??= []).push(structuredClone(op.zone));
      return;
    case 'setFloorZone': {
      const z = b.floorZones?.find((x) => x.id === op.zoneId);
      if (z) z.productId = op.productId;
      return;
    }
    case 'setWallHeight': {
      const w = b.walls.find((x) => x.id === op.wallId);
      if (w) w.height = op.height;
      return;
    }
    case 'setRoomHeights': {
      let label = b.rooms.find((r) => r.id === op.roomId);
      if (!label) {
        const auto = parseAutoRoomId(op.roomId);
        if (!auto) return;
        label = { id: op.roomId, levelId: auto.levelId, at: auto.at, name: 'Pièce', floorProductId: null };
        b.rooms.push(label);
      }
      if (op.ceilingHeight !== undefined) label.ceilingHeight = op.ceilingHeight;
      if (op.floorOffset !== undefined) label.floorOffset = op.floorOffset;
      return;
    }
    case 'removeFloorZone':
      b.floorZones = (b.floorZones ?? []).filter((z) => z.id !== op.zoneId);
      return;
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
    case 'setFurnitureOptions': {
      const f = b.furniture.find((x) => x.id === op.furnitureId);
      if (f) {
        if (op.options) f.options = structuredClone(op.options);
        else delete f.options;
      }
      return;
    }
    case 'setRoofCovering':
      if (b.roof) b.roof.coveringId = op.productId;
      return;
    case 'setRoofInsulation':
      if (b.roof) b.roof.insulationId = op.productId;
      return;
    case 'addRoofWindow':
      if (b.roof) (b.roof.windows ??= []).push(structuredClone(op.window));
      return;
    case 'removeRoofWindow':
      if (b.roof?.windows) b.roof.windows = b.roof.windows.filter((w) => w.id !== op.windowId);
      return;
    case 'replaceRoofWindow': {
      const w = b.roof?.windows?.find((x) => x.id === op.windowId);
      if (w) w.productId = op.productId;
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
    case 'setFloorZone':
      return `zone:${op.zoneId}`;
    case 'setWallHeight':
      return `wallh:${op.wallId}`;
    case 'setRoomHeights':
      return `roomh:${op.roomId}`;
    case 'replaceOpening':
      return `opening:${op.openingId}`;
    case 'moveFurniture':
      return `move:${op.furnitureId}`;
    case 'setFurnitureOptions':
      return `furnopt:${op.furnitureId}`;
    case 'setRoofCovering':
      return 'roof:covering';
    case 'setRoofInsulation':
      return 'roof:insulation';
    case 'replaceRoofWindow':
      return `roofwin:${op.windowId}`;
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
  if (op.type === 'setRoomHeights') {
    // Les réglages successifs d'une même pièce se cumulent.
    const prev = ops.find((o): o is Extract<Operation, { type: 'setRoomHeights' }> => o.type === 'setRoomHeights' && o.roomId === op.roomId);
    if (prev) {
      const merged = { ...prev, ...Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)) } as Operation;
      return [...ops.filter((o) => o !== prev), merged];
    }
  }
  const k = targetKey(op);
  let next = k ? ops.filter((o) => targetKey(o) !== k) : [...ops];

  if (op.type === 'removeFurniture') {
    const added = next.find((o) => o.type === 'addFurniture' && o.item.id === op.furnitureId);
    const same = (o: Operation) => (o.type === 'moveFurniture' || o.type === 'setFurnitureOptions') && o.furnitureId === op.furnitureId;
    if (added) return next.filter((o) => !(o.type === 'addFurniture' && o.item.id === op.furnitureId) && !same(o));
    next = next.filter((o) => !same(o));
  }
  if (op.type === 'moveFurniture') {
    const added = next.find((o): o is Extract<Operation, { type: 'addFurniture' }> => o.type === 'addFurniture' && o.item.id === op.furnitureId);
    if (added) {
      return next.map((o) =>
        o === added ? { ...added, item: { ...added.item, x: op.x, y: op.y, rotation: op.rotation } } : o,
      );
    }
  }
  if (op.type === 'setFurnitureOptions') {
    const added = next.find((o): o is Extract<Operation, { type: 'addFurniture' }> => o.type === 'addFurniture' && o.item.id === op.furnitureId);
    if (added) {
      const item = { ...added.item, options: op.options };
      if (!op.options) delete item.options;
      return next.map((o) => (o === added ? { ...added, item } : o));
    }
  }
  if (op.type === 'removeOpening') {
    const added = next.find((o) => o.type === 'addOpening' && o.opening.id === op.openingId);
    if (added) return next.filter((o) => o !== added && !(o.type === 'replaceOpening' && o.openingId === op.openingId));
    next = next.filter((o) => !(o.type === 'replaceOpening' && o.openingId === op.openingId));
  }
  if (op.type === 'replaceOpening') {
    const added = next.find((o): o is Extract<Operation, { type: 'addOpening' }> => o.type === 'addOpening' && o.opening.id === op.openingId);
    if (added) {
      const opening = { ...added.opening, productId: op.productId, options: op.options };
      if (!op.options) delete opening.options;
      return next.map((o) => (o === added ? { ...added, opening } : o));
    }
  }
  if (op.type === 'removeRoofWindow') {
    const added = next.find((o) => o.type === 'addRoofWindow' && o.window.id === op.windowId);
    if (added) return next.filter((o) => o !== added && !(o.type === 'replaceRoofWindow' && o.windowId === op.windowId));
    next = next.filter((o) => !(o.type === 'replaceRoofWindow' && o.windowId === op.windowId));
  }
  if (op.type === 'replaceRoofWindow') {
    const added = next.find((o): o is Extract<Operation, { type: 'addRoofWindow' }> => o.type === 'addRoofWindow' && o.window.id === op.windowId);
    if (added) return next.map((o) => (o === added ? { ...added, window: { ...added.window, productId: op.productId } } : o));
  }
  if (op.type === 'setWallHeight') {
    const added = next.find((o): o is Extract<Operation, { type: 'addWall' }> => o.type === 'addWall' && o.wall.id === op.wallId);
    if (added) return next.map((o) => (o === added ? { ...added, wall: { ...added.wall, height: op.height } } : o));
  }
  if (op.type === 'setFloorZone') {
    const added = next.find((o): o is Extract<Operation, { type: 'addFloorZone' }> => o.type === 'addFloorZone' && o.zone.id === op.zoneId);
    if (added) return next.map((o) => (o === added ? { ...added, zone: { ...added.zone, productId: op.productId } } : o));
  }
  if (op.type === 'removeFloorZone') {
    const added = next.find((o) => o.type === 'addFloorZone' && o.zone.id === op.zoneId);
    if (added) return next.filter((o) => o !== added && !(o.type === 'setFloorZone' && o.zoneId === op.zoneId));
    next = next.filter((o) => !(o.type === 'setFloorZone' && o.zoneId === op.zoneId));
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
