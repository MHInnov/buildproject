import { detectRooms, newId, projectOnSegment, wallLength, wallSideFacingRoom } from './model/geometry';
import { productById } from './model/catalog';
import { applyOperations, pushOperation as pushOp } from './model/operations';
import { placeRoofWindow, roofWindowLength } from './model/roof';
import type { Condition, FloorZone, FurnitureItem, Opening, Point, Room, RoofWindow, RoomLabel, Viewpoint, Wall, WallSide } from './model/types';
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

/** Hauteur d'un mur (relevé dans l'existant, modification dans le projet). */
export function setWallHeight(wallId: string, height: number) {
  if (isExisting()) {
    st().editExisting((b) => {
      const w = b.walls.find((x) => x.id === wallId);
      if (w) w.height = height;
    });
  } else st().addOperation({ type: 'setWallHeight', wallId, height });
}

/**
 * Hauteurs propres à une pièce : plafond et niveau du sol.
 * Si le plafond monte au-dessus des murs de la pièce (dans l'existant), les murs suivent.
 */
export function setRoomHeights(room: Room, patch: { ceilingHeight?: number; floorOffset?: number }) {
  if (isExisting()) {
    st().editExisting((b) => {
      const l = ensureLabel(b.rooms, room.label);
      Object.assign(l, patch);
      const top = (l.floorOffset ?? 0) + (l.ceilingHeight ?? 0);
      for (const id of room.wallIds) {
        const w = b.walls.find((x) => x.id === id);
        if (w && l.ceilingHeight !== undefined && w.height < top) w.height = Math.round(top * 100) / 100;
      }
    });
  } else st().addOperation({ type: 'setRoomHeights', roomId: room.label.id, ...patch });
}

/** Pose une porte ou une fenêtre standard sur un mur, centrée au plus près du point donné. Renvoie son id. */
export function addOpeningAt(wall: Wall, p: Point, kind: 'porte' | 'fenetre'): string | null {
  const catalog = st().catalog;
  const productId = kind === 'porte' ? 'porte-int-blanche' : 'chassis-pvc-blanc';
  const prod = productById(catalog, productId);
  const L = wallLength(wall);
  const width = Math.min(prod?.size?.w ?? (kind === 'porte' ? 0.83 : 1.2), L - 0.1);
  if (width < 0.3) return null;
  const t = projectOnSegment(p, wall.a, wall.b).t;
  const offset = Math.min(L - width / 2, Math.max(width / 2, Math.round(t * L * 20) / 20));
  const o: Opening = {
    id: newId('o'),
    wallId: wall.id,
    kind,
    offset,
    width,
    height: prod?.size?.h ?? (kind === 'porte' ? 2.01 : 1.35),
    sill: kind === 'porte' ? 0 : 0.9,
    productId,
  };
  addOpening(o);
  return o.id;
}

// ----- Fenêtres de toit -----

const DEFAULT_ROOF_WINDOW = 'velux-rotation-78x118';

/** Bâtiment affiché (existant, ou projet avec ses modifications). */
const currentBuilding = () => (isExisting() ? st().project.existing : applyOperations(st().project.existing, st().project.operations));

/** Pose une fenêtre de toit (type Velux) près du point cliqué, dans le pan du toit. Renvoie son id, ou null hors du toit. */
export function addRoofWindowAt(p: Point, productId = DEFAULT_ROOF_WINDOW): string | null {
  const b = currentBuilding();
  if (!b.roof) return null;
  const prod = productById(st().catalog, productId);
  const width = prod?.size?.w ?? 0.78;
  const length = roofWindowLength(b.roof, prod?.size?.h ?? 1.18);
  const at = placeRoofWindow(b, p, width, length);
  if (!at) return null;
  const win: RoofWindow = { id: newId('rw'), ...at, width, length, productId: isExisting() ? 'ex-fenetre-toit' : productId };
  if (isExisting()) st().editExisting((x) => void (x.roof && (x.roof.windows ??= []).push(win)));
  else st().addOperation({ type: 'addRoofWindow', window: win });
  return win.id;
}

/** Modifie une fenêtre de toit relevée, ou ajoutée dans le projet (les autres ne se déplacent pas dans le projet). */
export function editRoofWindow(id: string, fn: (w: RoofWindow) => void) {
  if (isExisting()) {
    st().editExisting((b) => {
      const w = b.roof?.windows?.find((x) => x.id === id);
      if (w) fn(w);
    });
    return;
  }
  st().updateProject((p) => {
    for (const o of p.operations) if (o.type === 'addRoofWindow' && o.window.id === id) fn(o.window);
  });
}

/** Change le modèle d'une fenêtre de toit ; ses dimensions suivent celles du modèle. */
export function replaceRoofWindow(id: string, productId: string) {
  const b = currentBuilding();
  const prod = productById(st().catalog, productId);
  const resize = (w: RoofWindow) => {
    w.productId = productId;
    if (prod?.size && b.roof) {
      w.width = prod.size.w;
      w.length = roofWindowLength(b.roof, prod.size.h);
      const at = placeRoofWindow(b, w, w.width, w.length);
      if (at) Object.assign(w, at);
    }
  };
  const added = !isExisting() && st().project.operations.some((o) => o.type === 'addRoofWindow' && o.window.id === id);
  if (isExisting() || added) editRoofWindow(id, resize);
  else st().addOperation({ type: 'replaceRoofWindow', windowId: id, productId });
}

export function removeRoofWindow(id: string) {
  if (isExisting()) st().editExisting((b) => void (b.roof && (b.roof.windows = (b.roof.windows ?? []).filter((w) => w.id !== id))));
  else st().addOperation({ type: 'removeRoofWindow', windowId: id });
  st().select(null);
}
