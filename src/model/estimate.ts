import { itemPrice, withOptions } from './generic';
import type { Catalog, LaborTask, Product } from './catalog';
import { productById, taskById } from './catalog';
import { detectRooms, inRoom, wallFaceArea, wallLength } from './geometry';
import { applyOperations } from './operations';
import { roofArea, roofInsulationArea } from './roof';
import type { Building, FloorZone, ItemOptions, Lot, Operation, Project, Room, Wall } from './types';
import { CONDITION_LABELS, LOT_ORDER } from './types';

export interface MaterialLine {
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  total: number;
  /** Détail du métré, ex. « 18,4 m² + 8 % de chute = 19,9 m² ». */
  takeoff?: string;
}

export interface LaborLine {
  taskId: string;
  label: string;
  quantity: number;
  unit: string;
  min: number;
  max: number;
}

export interface EstimateLine {
  id: string;
  lot: Lot;
  title: string;
  subtitle?: string;
  materials: MaterialLine[];
  labor: LaborLine[];
  warnings: string[];
  materialTotal: number;
  laborMin: number;
  laborMax: number;
}

export interface LotSummary {
  lot: Lot;
  lines: EstimateLine[];
  materialTotal: number;
  laborMin: number;
  laborMax: number;
}

export interface Estimate {
  lots: LotSummary[];
  materialTotal: number;
  /** Main d'œuvre HTVA. */
  laborMin: number;
  laborMax: number;
  vatRate: number;
  /** Total TVAC : matériaux (prix publics TTC) + main d'œuvre TVAC. */
  totalMin: number;
  totalMax: number;
  warnings: string[];
  /** Éléments de l'existant en mauvais état que le projet ne traite pas encore. */
  attention: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number, d = 1) => n.toLocaleString('fr-BE', { maximumFractionDigits: d, minimumFractionDigits: 0 });

function labor(task: LaborTask, quantity: number): LaborLine {
  return { taskId: task.id, label: task.label, quantity: round2(quantity), unit: task.unit, min: round2(task.min * quantity), max: round2(task.max * quantity) };
}

function finalize(line: Omit<EstimateLine, 'materialTotal' | 'laborMin' | 'laborMax'>): EstimateLine {
  return {
    ...line,
    materialTotal: round2(line.materials.reduce((s, m) => s + m.total, 0)),
    laborMin: round2(line.labor.reduce((s, l) => s + l.min, 0)),
    laborMax: round2(line.labor.reduce((s, l) => s + l.max, 0)),
  };
}

/** Matériau vendu au paquet (m²) : quantité arrondie au paquet supérieur, chute incluse. */
export function packMaterial(p: Product, area: number): MaterialLine {
  const waste = p.waste ?? 0.08;
  const needed = area * (1 + waste);
  const packs = Math.ceil(needed / (p.packSize ?? 1) - 1e-9);
  return {
    label: p.name,
    quantity: packs,
    unit: `paquet${packs > 1 ? 's' : ''} de ${fmt(p.packSize ?? 1, 2)} m²`,
    unitPrice: p.price,
    total: round2(packs * p.price),
    takeoff: `${fmt(area)} m² + ${Math.round(waste * 100)} % de chute = ${fmt(needed)} m²`,
  };
}

/** Peinture : litres = surface × couches ÷ rendement, arrondis au pot supérieur. */
export function paintMaterial(p: Product, area: number): MaterialLine {
  const coats = p.coats ?? 2;
  const liters = (area * coats) / (p.coverage ?? 10);
  const pots = Math.max(1, Math.ceil(liters / (p.packSize ?? 1) - 1e-9));
  return {
    label: p.name,
    quantity: pots,
    unit: `pot${pots > 1 ? 's' : ''} de ${fmt(p.packSize ?? 1)} L`,
    unitPrice: p.price,
    total: round2(pots * p.price),
    takeoff: `${fmt(area)} m² × ${coats} couches ÷ ${p.coverage ?? 10} m²/L = ${fmt(liters)} L`,
  };
}

const zoneArea = (z: FloorZone) => Math.max(0, z.w) * Math.max(0, z.h);
const zoneInRoom = (z: FloorZone, r: Room) => z.levelId === r.label.levelId && inRoom({ x: z.x + z.w / 2, y: z.y + z.h / 2 }, r);

function floorLaborTask(p: Product, catalog: Catalog): LaborTask {
  if (p.tags.includes('carrelage')) return taskById(catalog, 'pose-carrelage-sol');
  if (p.tags.includes('parquet')) return taskById(catalog, 'pose-parquet');
  return taskById(catalog, 'pose-flottant');
}

export function computeEstimate(project: Project, catalog: Catalog): Estimate {
  const { existing, operations } = project;
  const projected = applyOperations(existing, operations);
  const rooms = detectRooms(projected);
  const lines: EstimateLine[] = [];
  const warnings: string[] = [];
  const vatRate = project.olderThan10Years ? 0.06 : 0.21;

  const stateBefore = (i: number): Building => applyOperations(existing, operations.slice(0, i));
  const existingWallIds = new Set(existing.walls.map((w) => w.id));
  const isExistingWall = (id: string) => existingWallIds.has(id) || [...existingWallIds].some((e) => id.startsWith(`${e}.`));

  let needsStabilityStudy = false;
  const floorsByProduct = new Map<string, { area: number; plinth: number; rooms: string[]; removal: Map<string, number> }>();
  const finishesByProduct = new Map<string, { area: number; walls: number; removal: Map<string, number> }>();
  const addTo = (m: Map<string, number>, k: string | undefined, q: number) => {
    if (k) m.set(k, (m.get(k) ?? 0) + q);
  };
  const furnitureByProduct = new Map<string, number>();

  operations.forEach((op: Operation, i: number) => {
    switch (op.type) {
      case 'demolishWall': {
        const before = stateBefore(i);
        const w = before.walls.find((x) => x.id === op.wallId);
        if (!w) return;
        const area = wallFaceArea(w, before.openings);
        const L = wallLength(w);
        const items: LaborLine[] = [];
        const lineWarnings: string[] = [];
        if (w.kind === 'porteur') {
          items.push(labor(taskById(catalog, 'demol-porteur'), area));
          items.push(labor(taskById(catalog, 'renfort-porteur'), L));
          needsStabilityStudy = true;
          lineWarnings.push('Mur porteur : ne jamais démolir sans étude de stabilité ni étançonnement.');
        } else {
          items.push(labor(taskById(catalog, 'demol-cloison'), area));
        }
        items.push(labor(taskById(catalog, 'evacuation'), Math.max(0.5, area * w.thickness * 1.3)));
        items.push(labor(taskById(catalog, 'raccord-sol'), L));
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'demolition',
            title: `Démolition ${w.kind === 'porteur' ? 'du mur porteur' : 'de la cloison'} (${fmt(L, 2)} m)`,
            subtitle: `${fmt(area)} m² de mur, épaisseur ${Math.round(w.thickness * 100)} cm`,
            materials: [],
            labor: items,
            warnings: lineWarnings,
          }),
        );
        return;
      }
      case 'addWall': {
        const w: Wall = op.wall;
        const L = wallLength(w);
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'gros-oeuvre',
            title: `Nouvelle cloison (${fmt(L, 2)} m)`,
            subtitle: `${fmt(L * w.height)} m² fourniture et pose`,
            materials: [],
            labor: [labor(taskById(catalog, 'cloison-plaque'), L * w.height)],
            warnings: [],
          }),
        );
        return;
      }
      case 'addOpening': {
        const o = op.opening;
        const base = productById(catalog, o.productId);
        const p = base && { ...withOptions(base, o.options)!, price: itemPrice(base, o.options, { w: o.width, h: o.height }) };
        const items: LaborLine[] = [];
        if (isExistingWall(o.wallId)) items.push(labor(taskById(catalog, 'creation-baie'), 1));
        items.push(labor(taskById(catalog, o.kind === 'porte' ? 'pose-porte' : 'pose-chassis'), 1));
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'menuiserie',
            title: `Nouvelle ${o.kind === 'porte' ? 'porte' : 'fenêtre'} ${Math.round(o.width * 100)} × ${Math.round(o.height * 100)} cm`,
            subtitle: p?.name,
            materials: p ? [{ label: p.name, quantity: 1, unit: 'pièce', unitPrice: p.price, total: p.price }] : [],
            labor: items,
            warnings: isExistingWall(o.wallId) ? ['Ouverture dans un mur existant : vérifier s\'il est porteur.'] : [],
          }),
        );
        return;
      }
      case 'removeOpening': {
        const before = stateBefore(i);
        const o = before.openings.find((x) => x.id === op.openingId);
        if (!o) return;
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'menuiserie',
            title: `Suppression d'une ${o.kind === 'porte' ? 'porte' : 'fenêtre'}`,
            subtitle: `${fmt(o.width * o.height)} m² à reboucher`,
            materials: [],
            labor: [
              labor(taskById(catalog, o.kind === 'porte' ? 'depose-porte' : 'depose-chassis'), 1),
              labor(taskById(catalog, 'rebouchage-baie'), o.width * o.height),
            ],
            warnings: [],
          }),
        );
        return;
      }
      case 'replaceOpening': {
        const before = stateBefore(i);
        const o = before.openings.find((x) => x.id === op.openingId);
        const base = productById(catalog, op.productId);
        if (!o || !base) return;
        const p = { ...withOptions(base, op.options)!, price: itemPrice(base, op.options, { w: o.width, h: o.height }) };
        const porte = o.kind === 'porte';
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'menuiserie',
            title: `Remplacement ${porte ? 'de porte' : 'de châssis'} ${Math.round(o.width * 100)} × ${Math.round(o.height * 100)} cm`,
            subtitle: p.name,
            materials: [{ label: p.name, quantity: 1, unit: 'pièce', unitPrice: p.price, total: p.price }],
            labor: [
              labor(taskById(catalog, porte ? 'depose-porte' : 'depose-chassis'), 1),
              labor(taskById(catalog, porte ? 'pose-porte' : 'pose-chassis'), 1),
            ],
            warnings: [],
          }),
        );
        return;
      }
      case 'setFloor': {
        const room = rooms.find((r) => r.label.id === op.roomId);
        if (!room) return;
        const doors = projected.openings.filter((o) => o.kind === 'porte' && room.wallIds.includes(o.wallId));
        const plinth = Math.max(0, room.perimeter - doors.reduce((s, d) => s + d.width, 0));
        const acc = floorsByProduct.get(op.productId) ?? { area: 0, plinth: 0, rooms: [] as string[], removal: new Map<string, number>() };
        // Les zones de sol posées dans la pièce gardent leur propre revêtement.
        const zonesArea = (projected.floorZones ?? []).filter((z) => z.productId && zoneInRoom(z, room)).reduce((t, z) => t + zoneArea(z), 0);
        const area = Math.max(0, room.area - zonesArea);
        acc.area += area;
        acc.plinth += plinth;
        acc.rooms.push(room.label.name);
        // La dépose dépend du revêtement actuel (carrelage, moquette, plancher…).
        const before = stateBefore(i).rooms.find((r) => r.id === op.roomId);
        const old = productById(catalog, before?.floorProductId);
        addTo(acc.removal, old ? old.removal : 'depose-sol', area);
        floorsByProduct.set(op.productId, acc);
        return;
      }
      case 'addFloorZone':
      case 'setFloorZone': {
        const id = op.type === 'addFloorZone' ? op.zone.id : op.zoneId;
        const z = projected.floorZones?.find((x) => x.id === id);
        if (!z?.productId) return;
        const before = stateBefore(i);
        const room = rooms.find((r) => zoneInRoom(z, r));
        const acc = floorsByProduct.get(z.productId) ?? { area: 0, plinth: 0, rooms: [] as string[], removal: new Map<string, number>() };
        const area = zoneArea(z);
        acc.area += area;
        acc.rooms.push(`zone de ${room?.label.name ?? 'pièce'}`);
        // Sous la zone : l'ancien revêtement de la zone, sinon celui de la pièce.
        const oldZone = before.floorZones?.find((x) => x.id === id);
        const oldRoom = room && before.rooms.find((r) => r.id === room.label.id);
        const old = productById(catalog, oldZone?.productId ?? oldRoom?.floorProductId);
        addTo(acc.removal, old ? old.removal : 'depose-sol', area);
        floorsByProduct.set(z.productId, acc);
        return;
      }
      case 'setWallFinish': {
        const w = projected.walls.find((x) => x.id === op.wallId);
        if (!w) return;
        const acc = finishesByProduct.get(op.productId) ?? { area: 0, walls: 0, removal: new Map<string, number>() };
        const area = wallFaceArea(w, projected.openings);
        acc.area += area;
        acc.walls += 1;
        const beforeWall = stateBefore(i).walls.find((x) => x.id === op.wallId);
        addTo(acc.removal, productById(catalog, beforeWall?.finish[op.side])?.removal, area);
        finishesByProduct.set(op.productId, acc);
        return;
      }
      case 'addFurniture': {
        const p = productById(catalog, op.item.productId);
        if (p?.category === 'escalier') {
          // Un nouvel escalier sans escalier existant au même niveau demande d'ouvrir le plancher.
          const hadStair = existing.furniture.some((f) => f.levelId === op.item.levelId && productById(catalog, f.productId)?.category === 'escalier');
          const labor_ = [labor(taskById(catalog, 'pose-escalier'), 1)];
          if (!hadStair) labor_.push(labor(taskById(catalog, 'creation-tremie'), 1));
          lines.push(
            finalize({
              id: `op-${i}`,
              lot: 'escaliers',
              title: p.name,
              subtitle: hadStair ? "Remplacement de l'escalier existant" : 'Nouvel escalier : trémie à créer dans le plancher',
              materials: [{ label: p.name, quantity: 1, unit: 'pièce', unitPrice: p.price, total: p.price }],
              labor: labor_,
              warnings: hadStair ? [] : ['Ouvrir un plancher touche à la structure : faites vérifier par un professionnel.'],
            }),
          );
          return;
        }
        // Meubles identiques (même fiche, mêmes réglages) regroupés
        const key = JSON.stringify([op.item.productId, op.item.options ?? null]);
        furnitureByProduct.set(key, (furnitureByProduct.get(key) ?? 0) + 1);
        return;
      }
      case 'setRoofCovering': {
        const p = productById(catalog, op.productId);
        const area = roofArea(projected);
        if (!p || area <= 0) return;
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'toiture',
            title: `Nouvelle couverture : ${p.name.replace(/ \(m²\)$/, '')}`,
            subtitle: `${fmt(area)} m² de toiture, débords compris`,
            materials: [packMaterial(p, area)],
            labor: [labor(taskById(catalog, 'depose-couverture'), area), labor(taskById(catalog, 'pose-couverture'), area)],
            warnings: ['Un échafaudage et une autorisation peuvent être nécessaires : à confirmer avec le couvreur.'],
          }),
        );
        return;
      }
      case 'addRoofWindow': {
        const p = productById(catalog, op.window.productId);
        const pitch = projected.roof?.pitch ?? 45;
        const h = op.window.length / Math.cos((pitch * Math.PI) / 180);
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'menuiserie',
            title: `Nouvelle fenêtre de toit ${Math.round(op.window.width * 100)} × ${Math.round(h * 100)} cm`,
            subtitle: p?.name ?? 'Modèle à choisir',
            materials: p ? [{ label: p.name, quantity: 1, unit: 'pièce', unitPrice: p.price, total: p.price }] : [],
            labor: [labor(taskById(catalog, 'tremie-toit'), 1), labor(taskById(catalog, 'pose-fenetre-toit'), 1)],
            warnings: ['Une fenêtre de toit sur la façade à rue peut demander un permis : à vérifier à la commune.'],
          }),
        );
        return;
      }
      case 'replaceRoofWindow': {
        const p = productById(catalog, op.productId);
        const w = stateBefore(i).roof?.windows?.find((x) => x.id === op.windowId);
        if (!p || !w) return;
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'menuiserie',
            title: 'Remplacement de fenêtre de toit',
            subtitle: p.name,
            materials: [{ label: p.name, quantity: 1, unit: 'pièce', unitPrice: p.price, total: p.price }],
            labor: [labor(taskById(catalog, 'depose-fenetre-toit'), 1), labor(taskById(catalog, 'pose-fenetre-toit'), 1)],
            warnings: [],
          }),
        );
        return;
      }
      case 'removeRoofWindow': {
        const w = stateBefore(i).roof?.windows?.find((x) => x.id === op.windowId);
        if (!w) return;
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'toiture',
            title: "Suppression d'une fenêtre de toit",
            subtitle: 'Toiture refermée et isolée',
            materials: [],
            labor: [labor(taskById(catalog, 'depose-fenetre-toit'), 1), labor(taskById(catalog, 'rebouchage-toit'), 1)],
            warnings: [],
          }),
        );
        return;
      }
      case 'setRoofInsulation': {
        const p = productById(catalog, op.productId);
        const area = roofInsulationArea(projected);
        if (!p || area <= 0 || p.existingOnly) return;
        const flat = projected.roof?.type === 'plat';
        lines.push(
          finalize({
            id: `op-${i}`,
            lot: 'isolation',
            title: `Isolation de toiture : ${p.name}`,
            subtitle: `${fmt(area)} m² ${flat ? 'de toit plat' : 'de rampants'}${p.rValue ? ` · R = ${p.rValue}` : ''}`,
            materials: [packMaterial(p, area)],
            labor: [labor(taskById(catalog, flat ? 'isolation-toit-plat' : 'isolation-rampants'), area)],
            warnings: [],
          }),
        );
        return;
      }
      default:
        return;
    }
  });

  for (const [pid, acc] of floorsByProduct) {
    const p = productById(catalog, pid);
    if (!p || acc.area <= 0) continue;
    const pose = floorLaborTask(p, catalog);
    lines.push(
      finalize({
        id: `floor-${pid}`,
        lot: pose.lot,
        title: `Sol : ${p.name}`,
        subtitle: `${acc.rooms.join(', ')} · ${fmt(acc.area)} m²`,
        materials: [packMaterial(p, acc.area)],
        labor: [...[...acc.removal].map(([t, q]) => labor(taskById(catalog, t), q)), labor(pose, acc.area), labor(taskById(catalog, 'plinthes'), acc.plinth)],
        warnings: [],
      }),
    );
  }

  for (const [pid, acc] of finishesByProduct) {
    const p = productById(catalog, pid);
    if (!p || acc.area <= 0) continue;
    const isPaint = p.category === 'peinture';
    const removal = [...acc.removal].map(([t, q]) => labor(taskById(catalog, t), q));
    let lot: Lot = 'carrelage';
    let kind = 'Faïence';
    let pose: LaborLine[] = [labor(taskById(catalog, 'pose-faience'), acc.area)];
    if (isPaint) {
      lot = 'peinture';
      kind = 'Peinture';
      pose = [labor(taskById(catalog, 'prep-murs'), acc.area), labor(taskById(catalog, 'peinture-murs'), acc.area)];
    } else if (p.category === 'mur') {
      const t = p.tags.includes('lambris') ? 'pose-lambris' : p.tags.includes('brique') ? 'pose-parement' : 'pose-papier-peint';
      const task = taskById(catalog, t);
      lot = task.lot;
      kind = 'Revêtement mural';
      pose = [labor(task, acc.area)];
    }
    lines.push(
      finalize({
        id: `finish-${pid}`,
        lot,
        title: `${kind} : ${p.name}`,
        subtitle: `${acc.walls} face${acc.walls > 1 ? 's' : ''} de mur · ${fmt(acc.area)} m² ouvertures déduites`,
        materials: [isPaint ? paintMaterial(p, acc.area) : packMaterial(p, acc.area)],
        labor: [...removal, ...pose],
        warnings: [],
      }),
    );
  }

  for (const [key, qty] of furnitureByProduct) {
    const [pid, options] = JSON.parse(key) as [string, ItemOptions | null];
    const base = productById(catalog, pid);
    if (!base) continue;
    const p = { ...withOptions(base, options ?? undefined)!, price: itemPrice(base, options ?? undefined) };
    const task =
      p.subcategory === 'cuisine'
        ? 'pose-cuisine'
        : p.id === 'wc-suspendu'
          ? 'pose-wc-suspendu'
          : p.subcategory === 'salle-de-bain' || p.subcategory === 'wc'
            ? 'pose-sanitaire'
            : p.subcategory === 'chauffage'
              ? 'pose-radiateur'
              : 'montage-meuble';
    lines.push(
      finalize({
        id: `furn-${key}`,
        lot: taskById(catalog, task).lot,
        title: `${qty > 1 ? `${qty} × ` : ''}${p.name}`,
        materials: [{ label: p.name, quantity: qty, unit: 'pièce', unitPrice: p.price, total: round2(qty * p.price) }],
        labor: [labor(taskById(catalog, task), qty)],
        warnings: [],
      }),
    );
  }

  if (needsStabilityStudy) {
    lines.push(
      finalize({
        id: 'etude-stabilite',
        lot: 'gros-oeuvre',
        title: 'Étude de stabilité',
        subtitle: 'Obligatoire avant toute démolition de mur porteur',
        materials: [],
        labor: [labor(taskById(catalog, 'etude-stabilite'), 1)],
        warnings: [],
      }),
    );
    warnings.push('Le projet touche un mur porteur : faites intervenir un architecte ou un ingénieur en stabilité.');
  }

  const lots: LotSummary[] = LOT_ORDER.map((lot) => {
    const ls = lines.filter((l) => l.lot === lot);
    return {
      lot,
      lines: ls,
      materialTotal: round2(ls.reduce((s, l) => s + l.materialTotal, 0)),
      laborMin: round2(ls.reduce((s, l) => s + l.laborMin, 0)),
      laborMax: round2(ls.reduce((s, l) => s + l.laborMax, 0)),
    };
  }).filter((l) => l.lines.length > 0);

  const attention = attentionPoints(project, catalog);

  const materialTotal = round2(lots.reduce((s, l) => s + l.materialTotal, 0));
  const laborMin = round2(lots.reduce((s, l) => s + l.laborMin, 0));
  const laborMax = round2(lots.reduce((s, l) => s + l.laborMax, 0));
  return {
    lots,
    materialTotal,
    laborMin,
    laborMax,
    vatRate,
    totalMin: round2(materialTotal + laborMin * (1 + vatRate)),
    totalMax: round2(materialTotal + laborMax * (1 + vatRate)),
    warnings,
    attention,
  };
}

/** Relève les éléments existants signalés en mauvais état (ou non isolés) que le projet ne traite pas. */
export function attentionPoints(project: Project, catalog: Catalog): string[] {
  const { existing, operations } = project;
  const out: string[] = [];
  const rooms = detectRooms(existing);
  const roomOf = (wallId: string) => rooms.find((r) => r.wallIds.includes(wallId))?.label.name;
  const touched = (pred: (op: Operation) => boolean) => operations.some(pred);
  const bad = (c?: string) => c === 'mauvais';
  for (const o of existing.openings) {
    if (!bad(o.condition)) continue;
    if (touched((op) => (op.type === 'replaceOpening' || op.type === 'removeOpening') && op.openingId === o.id)) continue;
    const where = roomOf(o.wallId);
    out.push(`${o.kind === 'porte' ? 'Porte' : 'Fenêtre'}${where ? ` (${where})` : ''} : ${CONDITION_LABELS.mauvais.toLowerCase()}, ${productById(catalog, o.productId)?.name ?? 'modèle non précisé'}.`);
  }
  for (const r of rooms) {
    if (!bad(r.label.floorCondition)) continue;
    if (touched((op) => op.type === 'setFloor' && op.roomId === r.label.id)) continue;
    out.push(`Sol de ${r.label.name} : ${CONDITION_LABELS.mauvais.toLowerCase()} (${productById(catalog, r.label.floorProductId)?.name ?? 'revêtement non précisé'}).`);
  }
  for (const w of existing.walls) {
    if (!bad(w.condition)) continue;
    if (touched((op) => (op.type === 'demolishWall' && (op.wallId === w.id || op.wallId.startsWith(`${w.id}.`))) || (op.type === 'setWallFinish' && op.wallId === w.id))) continue;
    out.push(`Mur${roomOf(w.id) ? ` (${roomOf(w.id)})` : ''} signalé en mauvais état (humidité, fissures ?) : à faire diagnostiquer.`);
  }
  const roof = existing.roof;
  if (roof) {
    if (bad(roof.condition) && !touched((op) => op.type === 'setRoofCovering')) out.push('Toiture signalée en mauvais état : la couverture n’est pas encore prévue dans le projet.');
    const ins = productById(catalog, roof.insulationId);
    if ((!ins || !ins.rValue) && !touched((op) => op.type === 'setRoofInsulation'))
      out.push('Toiture non isolée : c’est souvent le poste le plus rentable d’une rénovation (et il peut ouvrir droit à des primes).');
  }
  return out;
}

export const euro = (n: number) =>
  n.toLocaleString('fr-BE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
