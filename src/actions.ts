import { detectRooms, newId, wallSideFacingRoom } from './model/geometry';
import { applyOperations, pushOperation as pushOp } from './model/operations';
import type { Condition, FloorZone, FurnitureItem, Opening, Room, RoomLabel, Viewpoint, WallSide } from './model/types';
import { useStore } from './store';

/**
 * Actions communes au plan 2D et à la visite 3D.
 * À l'étape « existant » elles modifient directement l'existant ;
 * ensuite, elles ajoutent des opérations au projet.
 */
const isExisting = () => useStore.getState().step === 'existant';
const st = () => useStore.getState();

function ensureLabel(rooms: RoomLabel[], label: RoomLabel): RoomLabel {
  let l = rooms.find((r) => r.id === label.id);
  if (!l) {
    l = { ...label, id: newId('r') };
    rooms.push(l);
  }
  return l;
}

export function setRoomFloor(room: Room, productId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      ensureLabel(b.rooms, room.label).floorProductId = productId;
    });
  } else st().addOperation({ type: 'setFloor', roomId: room.label.id, productId });
}

export function renameRoom(room: Room, name: string) {
  st().editExisting((b) => {
    ensureLabel(b.rooms, room.label).name = name;
  });
}

export function setWallFinish(wallId: string, side: WallSide, productId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      const w = b.walls.find((x) => x.id === wallId);
      if (w) w.finish[side] = productId;
    });
  } else st().addOperation({ type: 'setWallFinish', wallId, side, productId });
}

/** Applique un revêtement à toutes les faces de mur tournées vers la pièce. */
export function finishRoomWalls(room: Room, productId: string, walls = currentWalls()) {
  const targets = room.wallIds
    .map((id) => walls.find((w) => w.id === id))
    .flatMap((w) => {
      if (!w) return [];
      const side = wallSideFacingRoom(w, room);
      return side ? [{ wallId: w.id, side }] : [];
    });
  if (isExisting()) {
    st().editExisting((b) => {
      for (const t of targets) {
        const w = b.walls.find((x) => x.id === t.wallId);
        if (w) w.finish[t.side] = productId;
      }
    });
  } else {
    st().updateProject((p) => {
      let ops = p.operations;
      for (const t of targets) ops = pushOp(ops, { type: 'setWallFinish', wallId: t.wallId, side: t.side, productId });
      p.operations = ops;
    });
  }
}


function currentWalls() {
  const p = st().project;
  return isExisting() ? p.existing.walls : applyOperations(p.existing, p.operations).walls;
}

export function currentRooms(): Room[] {
  const p = st().project;
  return detectRooms(isExisting() ? p.existing : applyOperations(p.existing, p.operations));
}

export function removeWall(wallId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      b.walls = b.walls.filter((w) => w.id !== wallId);
      b.openings = b.openings.filter((o) => o.wallId !== wallId);
    });
  } else st().addOperation({ type: 'demolishWall', wallId });
  st().select(null);
}

export function addOpening(opening: Opening) {
  if (isExisting()) st().editExisting((b) => void b.openings.push(opening));
  else st().addOperation({ type: 'addOpening', opening });
}

export function replaceOpening(openingId: string, productId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      const o = b.openings.find((x) => x.id === openingId);
      if (o) o.productId = productId;
    });
  } else st().addOperation({ type: 'replaceOpening', openingId, productId });
}

export function removeOpening(openingId: string) {
  if (isExisting()) st().editExisting((b) => void (b.openings = b.openings.filter((o) => o.id !== openingId)));
  else st().addOperation({ type: 'removeOpening', openingId });
  st().select(null);
}

export function addFurniture(productId: string, x: number, y: number, rotation = 0): string {
  const item: FurnitureItem = { id: newId('f'), levelId: st().levelId, productId, x, y, rotation };
  if (isExisting()) st().editExisting((b) => void b.furniture.push(item));
  else st().addOperation({ type: 'addFurniture', item });
  return item.id;
}

export function moveFurniture(id: string, x: number, y: number, rotation: number) {
  if (isExisting()) {
    st().editExisting((b) => {
      const f = b.furniture.find((i) => i.id === id);
      if (f) Object.assign(f, { x, y, rotation });
    });
  } else st().addOperation({ type: 'moveFurniture', furnitureId: id, x, y, rotation });
}

export function removeFurniture(id: string) {
  if (isExisting()) st().editExisting((b) => void (b.furniture = b.furniture.filter((f) => f.id !== id)));
  else st().addOperation({ type: 'removeFurniture', furnitureId: id });
  st().select(null);
}

/** Remplace un meuble par un autre produit, au même endroit. */
export function swapFurniture(item: FurnitureItem, productId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      const f = b.furniture.find((i) => i.id === item.id);
      if (f) f.productId = productId;
    });
    return;
  }
  st().updateProject((p) => {
    let ops = pushOp(p.operations, { type: 'removeFurniture', furnitureId: item.id });
    const added = { ...item, id: newId('f'), productId };
    ops = pushOp(ops, { type: 'addFurniture', item: added });
    p.operations = ops;
    queueMicrotask(() => st().select({ kind: 'furniture', id: added.id }));
  });
}

/** État d'un élément existant (relevé). */
export function setCondition(target: { kind: 'wall' | 'opening' | 'room' | 'roof'; id: string; room?: Room }, condition: Condition | undefined) {
  st().editExisting((b) => {
    if (target.kind === 'wall') {
      const w = b.walls.find((x) => x.id === target.id);
      if (w) w.condition = condition;
    } else if (target.kind === 'opening') {
      const o = b.openings.find((x) => x.id === target.id);
      if (o) o.condition = condition;
    } else if (target.kind === 'room' && target.room) {
      ensureLabel(b.rooms, target.room.label).floorCondition = condition;
    } else if (target.kind === 'roof' && b.roof) b.roof.condition = condition;
  });
}

export function setRoofCovering(productId: string) {
  if (isExisting()) st().editExisting((b) => void (b.roof && (b.roof.coveringId = productId)));
  else st().addOperation({ type: 'setRoofCovering', productId });
}

export function setRoofInsulation(productId: string) {
  if (isExisting()) st().editExisting((b) => void (b.roof && (b.roof.insulationId = productId)));
  else st().addOperation({ type: 'setRoofInsulation', productId });
}

export function updateViewpoint(id: string, fn: (v: Viewpoint) => void) {
  st().updateProject((p) => {
    const v = p.viewpoints.find((x) => x.id === id);
    if (v) fn(v);
  });
}

export function removeViewpoint(id: string) {
  st().updateProject((p) => void (p.viewpoints = p.viewpoints.filter((v) => v.id !== id)));
  st().select(null);
}

/** Zone de sol (sol posé sur une partie de pièce). */
export function addFloorZone(zone: FloorZone) {
  if (isExisting()) st().editExisting((b) => void (b.floorZones ??= []).push(zone));
  else st().addOperation({ type: 'addFloorZone', zone });
  st().select({ kind: 'zone', id: zone.id });
}

export function setFloorZoneProduct(id: string, productId: string) {
  if (isExisting()) {
    st().editExisting((b) => {
      const z = b.floorZones?.find((x) => x.id === id);
      if (z) z.productId = productId;
    });
  } else st().addOperation({ type: 'setFloorZone', zoneId: id, productId });
}

/** Une zone peut être déplacée ou redimensionnée dans l'existant, ou si le projet l'a créée. */
export function canEditZone(id: string): boolean {
  if (isExisting()) return true;
  return st().project.operations.some((o) => o.type === 'addFloorZone' && o.zone.id === id);
}

export function editFloorZone(id: string, fn: (z: FloorZone) => void) {
  if (isExisting()) {
    st().editExisting((b) => {
      const z = b.floorZones?.find((x) => x.id === id);
      if (z) fn(z);
    });
    return;
  }
  st().updateProject((p) => {
    for (const o of p.operations) if (o.type === 'addFloorZone' && o.zone.id === id) fn(o.zone);
  });
}

export function removeFloorZone(id: string) {
  if (isExisting()) st().editExisting((b) => void (b.floorZones = (b.floorZones ?? []).filter((z) => z.id !== id)));
  else st().addOperation({ type: 'removeFloorZone', zoneId: id });
  st().select(null);
}
