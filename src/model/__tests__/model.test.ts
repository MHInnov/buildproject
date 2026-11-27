import { describe, expect, it } from 'vitest';
import { DEMO_CATALOG } from '../../data/catalog';
import { demoBuilding, demoProject } from '../../data/demoProject';
import { computeEstimate, packMaterial, paintMaterial } from '../estimate';
import { detectRooms, insertWall } from '../geometry';
import { applyOperations, pushOperation } from '../operations';
import { parseQuery, searchCatalog } from '../search';
import { defaultLevel } from '../levels';
import type { Building, Wall } from '../types';

const w = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({
  id, levelId: 'rdc', a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 0, height: 2.5, kind: 'cloison', finish: { gauche: null, droite: null },
});
const empty = (): Building => ({ levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null });

describe('détection des pièces', () => {
  it('un carré donne une pièce de 16 m²', () => {
    const b = empty();
    insertWall(b, w('a', 0, 0, 4, 0));
    insertWall(b, w('b', 4, 0, 4, 4));
    insertWall(b, w('c', 4, 4, 0, 4));
    insertWall(b, w('d', 0, 4, 0, 0));
    const rooms = detectRooms(b);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].area).toBeCloseTo(16);
  });

  it('le sens de tracé ne change rien', () => {
    const b = empty();
    insertWall(b, w('a', 0, 0, 0, 3));
    insertWall(b, w('b', 0, 3, 5, 3));
    insertWall(b, w('c', 5, 0, 5, 3));
    insertWall(b, w('d', 5, 0, 0, 0));
    expect(detectRooms(b).map((r) => r.area)).toEqual([15]);
  });

  it('une cloison en T coupe la pièce en deux', () => {
    const b = empty();
    insertWall(b, w('a', 0, 0, 6, 0));
    insertWall(b, w('b', 6, 0, 6, 4));
    insertWall(b, w('c', 6, 4, 0, 4));
    insertWall(b, w('d', 0, 4, 0, 0));
    insertWall(b, w('e', 2, 0, 2, 4));
    const areas = detectRooms(b).map((r) => r.area).sort((x, y) => x - y);
    expect(areas).toEqual([8, 16]);
  });

  it('une pièce dessinée au milieu d\'une autre est retirée de celle-ci', () => {
    const b = empty();
    for (const x of [w('a', 0, 0, 10, 0), w('b', 10, 0, 10, 8), w('c', 10, 8, 0, 8), w('d', 0, 8, 0, 0)]) insertWall(b, x);
    for (const x of [w('e', 2, 2, 5, 2), w('f', 5, 2, 5, 5), w('g', 5, 5, 2, 5), w('h', 2, 5, 2, 2)]) insertWall(b, x);
    b.rooms.push({ id: 'ilot', levelId: 'rdc', at: { x: 3.5, y: 3.5 }, name: 'Bureau', floorProductId: null });
    const rooms = detectRooms(b);
    const ilot = rooms.find((r) => r.label.id === 'ilot')!;
    const autour = rooms.find((r) => r.label.id !== 'ilot')!;
    expect(ilot.area).toBeCloseTo(9);
    expect(autour.area).toBeCloseTo(80 - 9);
    expect(autour.holes).toHaveLength(1);
    // L'étiquette de la grande pièce n'est pas posée dans l'îlot
    expect(autour.label.at.x < 2 || autour.label.at.x > 5 || autour.label.at.y < 2 || autour.label.at.y > 5).toBe(true);
  });

  it('la maison de démo a 4 pièces étiquetées', () => {
    const rooms = detectRooms(demoBuilding());
    expect(rooms.filter((r) => r.label.levelId === 'rdc').map((r) => r.label.name).sort()).toEqual(['Chambre', 'Cuisine', 'Salle de bain', 'Séjour']);
    expect(rooms.filter((r) => r.label.levelId === 'combles').map((r) => r.label.name)).toEqual(['Grenier']);
  });
});

describe('opérations', () => {
  it('démolir la cloison fusionne séjour et chambre', () => {
    const b = demoBuilding();
    const ops = pushOperation([], { type: 'demolishWall', wallId: 'w-c1' });
    const rooms = detectRooms(applyOperations(b, ops));
    expect(rooms.filter((r) => r.label.levelId === 'rdc')).toHaveLength(3);
    expect(b.walls.some((x) => x.id === 'w-c1')).toBe(true); // l'existant n'est pas modifié
  });

  it('une modification de la même cible remplace la précédente', () => {
    let ops = pushOperation([], { type: 'setFloor', roomId: 'r-sejour', productId: 'sol-strat-gris' });
    ops = pushOperation(ops, { type: 'setFloor', roomId: 'r-sejour', productId: 'sol-parquet-chene' });
    expect(ops).toHaveLength(1);
  });

  it('retirer un meuble ajouté annule son ajout', () => {
    let ops = pushOperation([], { type: 'addFurniture', item: { id: 'x', levelId: 'rdc', productId: 'chaise-bois', x: 1, y: 1, rotation: 0 } });
    ops = pushOperation(ops, { type: 'removeFurniture', furnitureId: 'x' });
    expect(ops).toHaveLength(0);
  });
});

describe('métré', () => {
  const sol = DEMO_CATALOG.products.find((p) => p.id === 'sol-strat-chene-clair')!;
  const peinture = DEMO_CATALOG.products.find((p) => p.id === 'peint-vert-sauge')!;
  it('arrondit au paquet supérieur avec la chute', () => {
    const m = packMaterial(sol, 20); // 20 × 1,08 = 21,6 m² / 2,2 = 9,8 → 10 paquets
    expect(m.quantity).toBe(10);
    expect(m.total).toBe(390);
  });
  it('calcule les pots de peinture', () => {
    const m = paintMaterial(peinture, 30); // 30 × 2 / 10 = 6 L → 3 pots de 2,5 L
    expect(m.quantity).toBe(3);
  });
});

describe('chiffrage', () => {
  it('un projet vide coûte 0', () => {
    expect(computeEstimate(demoProject(), DEMO_CATALOG).totalMax).toBe(0);
  });

  it('chiffre sol, démolition porteuse et meuble par poste', () => {
    const p = demoProject();
    p.operations = [
      { type: 'setFloor', roomId: 'r-sejour', productId: 'sol-parquet-chene' },
      { type: 'demolishWall', wallId: 'w-refend.1' },
      { type: 'addFurniture', item: { id: 'n', levelId: 'rdc', productId: 'canape-angle-beige', x: 3, y: 2, rotation: 0 } },
    ];
    const e = computeEstimate(p, DEMO_CATALOG);
    const lots = e.lots.map((l) => l.lot);
    expect(lots).toEqual(['demolition', 'gros-oeuvre', 'sols', 'mobilier']);
    expect(e.warnings.length).toBeGreaterThan(0);
    expect(e.totalMin).toBeLessThan(e.totalMax);
    const sol = e.lots.find((l) => l.lot === 'sols')!.lines[0];
    expect(sol.materials[0].quantity).toBeGreaterThan(0);
  });
});

describe('recherche', () => {
  it('comprend « grand canapé pas trop foncé »', () => {
    const f = parseQuery('Un grand canapé pas trop foncé');
    expect(f.categories).toEqual(['meuble']);
    expect(f.subcategories).toEqual(['canape']);
    expect(f.excludeTones).toEqual(['fonce']);
    expect(f.size).toBe('grand');
    const { results } = searchCatalog(DEMO_CATALOG, 'Un grand canapé pas trop foncé');
    // Un seul canapé générique, réglable (dimensions, couleur) ; les anciennes fiches figées ne sont plus proposées
    expect(results[0].product.id).toBe('canape-3p-gris');
    expect(results.some((r) => r.product.hidden)).toBe(false);
  });

  it('applique un budget maximum', () => {
    const { results } = searchCatalog(DEMO_CATALOG, 'sol bois clair moins de 40 €');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.product.price <= 40)).toBe(true);
    expect(results[0].product.tone).toBe('clair');
  });
});

describe('découpe 3D des murs', () => {
  it('laisse le vide de la fenêtre et garde allège et linteau', async () => {
    const { wallPieces } = await import('../../three/BuildingMeshes');
    const wall = w('m', 0, 0, 4, 0);
    const pieces = wallPieces(wall, [{ id: 'o', wallId: 'm', kind: 'fenetre', offset: 2, width: 1, height: 1.2, sill: 0.9, productId: null }]);
    // gauche, allège, linteau, droite
    expect(pieces).toHaveLength(4);
    const solid = pieces.reduce((s, p) => s + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
    expect(solid).toBeCloseTo(4 * 2.5 - 1 * 1.2);
  });
});

describe('visite : étages et escalier', () => {
  it("monte l'escalier de la maison de démo jusqu'aux combles", async () => {
    const { walkWorld, groundAt } = await import('../../three/physics');
    const b = demoBuilding();
    const world = walkWorld(b, DEMO_CATALOG);
    // Escalier en x = 0,6, de y = 4,45 (départ) à y = 0,85 (arrivée)
    let y = groundAt(world, { x: 0.6, y: 4.6 }, 0);
    expect(y).toBe(0);
    for (let py = 4.4; py >= 0.9; py -= 0.1) y = groundAt(world, { x: 0.6, y: py }, y);
    expect(y).toBeGreaterThan(2.6);
    // Arrivé en haut, on marche sur le plancher des combles
    y = groundAt(world, { x: 0.6, y: 0.6 }, y);
    y = groundAt(world, { x: 3, y: 0.6 }, y);
    expect(y).toBeCloseTo(2.82);
    // Au rez-de-chaussée, loin de l'escalier, on reste en bas
    expect(groundAt(world, { x: 3, y: 3 }, 0)).toBe(0);
  });
});

describe('visite : collisions', () => {
  const square = (): Building => {
    const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null };
    const w = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({ id, levelId: 'rdc', a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 0.2, height: 2.5, kind: 'porteur', finish: { gauche: null, droite: null } });
    for (const x of [w('n', 0, 0, 4, 0), w('e', 4, 0, 4, 4), w('s', 4, 4, 0, 4), w('o', 0, 4, 0, 0)]) insertWall(b, x);
    b.openings.push({ id: 'p', wallId: 'n', kind: 'porte', productId: 'ex-porte-bois', offset: 2, width: 0.9, height: 2.05, sill: 0 });
    b.furniture.push({ id: 'c', levelId: 'rdc', productId: 'canape-3p-gris', x: 2, y: 3, rotation: 0 });
    return b;
  };

  it('une porte fermée bloque, une porte ouverte laisse passer', async () => {
    const { walkWorld, blocked } = await import('../../three/physics');
    const world = walkWorld(square(), DEMO_CATALOG);
    expect(blocked(world, { x: 2, y: 0 }, 0, () => false)).toBe(true);
    expect(blocked(world, { x: 2, y: 0 }, 0, () => true)).toBe(false);
  });

  it('on ne traverse ni les meubles ni le vantail ouvert', async () => {
    const { walkWorld, blocked } = await import('../../three/physics');
    const world = walkWorld(square(), DEMO_CATALOG);
    const open = () => true;
    expect(blocked(world, { x: 2, y: 3 }, 0, open)).toBe(true);
    expect(blocked(world, { x: 3.2, y: 3 }, 0, open)).toBe(true);
    expect(blocked(world, { x: 2, y: 2 }, 0, open)).toBe(false);
    // Vantail rabattu dans la pièce depuis la paumelle (x = 1,56)
    expect(blocked(world, { x: 1.56, y: 0.5 }, 0, open)).toBe(true);
  });
});

describe('zones de sol', () => {
  const zone = { id: 'z1', levelId: 'rdc', x: 6.5, y: 0.5, w: 2, h: 1.5, productId: 'sol-carrelage-ciment' };

  it('une zone ajoutée puis modifiée reste une seule opération', () => {
    let ops = pushOperation([], { type: 'addFloorZone', zone: { ...zone, productId: null } });
    ops = pushOperation(ops, { type: 'setFloorZone', zoneId: 'z1', productId: 'sol-carrelage-ciment' });
    expect(ops).toHaveLength(1);
    const b = applyOperations(demoBuilding(), ops);
    expect(b.floorZones?.[0].productId).toBe('sol-carrelage-ciment');
    expect(pushOperation(ops, { type: 'removeFloorZone', zoneId: 'z1' })).toHaveLength(0);
  });

  it('la zone est chiffrée à part et déduite du sol de la pièce', () => {
    const p = demoProject();
    const room = detectRooms(p.existing).find((r) => r.label.id === 'r-cuisine')!;
    p.operations = [{ type: 'setFloor', roomId: 'r-cuisine', productId: 'sol-strat-chene-clair' }];
    const before = computeEstimate(p, DEMO_CATALOG);
    const areaOf = (e: ReturnType<typeof computeEstimate>, pid: string) =>
      e.lots.flatMap((l) => l.lines).find((l) => l.id === `floor-${pid}`)?.materials[0];
    expect(areaOf(before, 'sol-strat-chene-clair')).toBeTruthy();
    p.operations.push({ type: 'addFloorZone', zone });
    const after = computeEstimate(p, DEMO_CATALOG);
    const lines = after.lots.flatMap((l) => l.lines);
    const zoneLine = lines.find((l) => l.id === 'floor-sol-carrelage-ciment')!;
    expect(zoneLine.subtitle).toContain('3 m²');
    const solLine = lines.find((l) => l.id === 'floor-sol-strat-chene-clair')!;
    expect(solLine.subtitle).toContain(`${(room.area - 3).toLocaleString('fr-BE', { maximumFractionDigits: 1 })}`);
  });
});

describe('textures photo', () => {
  it('chaque aspect du catalogue a une photo à son échelle réelle', async () => {
    const { photoFor, photoSize } = await import('../../three/photoMaterials');
    for (const p of DEMO_CATALOG.products) {
      if (!p.pattern) continue;
      const key = photoFor(p.pattern);
      expect(key, p.id).toBeTruthy();
      const [w, h] = photoSize(key!, p.pattern);
      expect(w).toBeGreaterThan(0.2);
      expect(h).toBeGreaterThan(0.2);
    }
    // 60 × 60 cm : 8 carreaux sur la photo
    expect(photoSize('tiles-large', { kind: 'tiles', w: 0.6, h: 0.6 })).toEqual([4.8, 4.8]);
  });
});

describe('hauteurs par pièce et par mur', () => {
  it('les réglages successifs d’une pièce se cumulent en une opération', () => {
    let ops = pushOperation([], { type: 'setRoomHeights', roomId: 'r-cuisine', ceilingHeight: 2.8 });
    ops = pushOperation(ops, { type: 'setRoomHeights', roomId: 'r-cuisine', floorOffset: -0.2 });
    expect(ops).toHaveLength(1);
    const label = applyOperations(demoBuilding(), ops).rooms.find((r) => r.id === 'r-cuisine')!;
    expect(label.ceilingHeight).toBe(2.8);
    expect(label.floorOffset).toBe(-0.2);
  });

  it('une pièce en contrebas abaisse le sol sous les pieds', async () => {
    const { walkWorld, groundAt } = await import('../../three/physics');
    const b = applyOperations(demoBuilding(), [{ type: 'setRoomHeights', roomId: 'r-cuisine', floorOffset: -0.15 }]);
    const room = detectRooms(b).find((r) => r.label.id === 'r-cuisine')!;
    const world = walkWorld(b, DEMO_CATALOG);
    expect(groundAt(world, room.label.at, 0)).toBeCloseTo(-0.15);
  });

  it('la hauteur d’un mur ajouté reste dans son opération', () => {
    let ops = pushOperation([], { type: 'addWall', wall: w('nw', 0, 0, 3, 0) });
    ops = pushOperation(ops, { type: 'setWallHeight', wallId: 'nw', height: 1.1 });
    expect(ops).toHaveLength(1);
    expect(applyOperations(empty(), ops).walls[0].height).toBe(1.1);
  });
});

describe('import de catalogue fournisseur', () => {
  it('lit le modèle CSV (séparateur ;, virgule décimale, dimensions en cm)', async () => {
    const { parseCatalogFile, CSV_TEMPLATE } = await import('../../catalogImport');
    const r = parseCatalogFile(CSV_TEMPLATE, 'modele.csv', 'Test');
    expect(r.errors).toEqual([]);
    expect(r.products).toHaveLength(4);
    const [sol, carrelage, canape] = r.products;
    expect(sol).toMatchObject({ category: 'sol', saleUnit: 'paquet', packSize: 2.22, price: 34.9, color: '#b88a55' });
    expect(sol.pattern).toMatchObject({ kind: 'planks', w: 0.19, h: 1.28 });
    expect(carrelage.pattern?.kind).toBe('tiles');
    expect(canape).toMatchObject({ subcategory: 'canape', saleUnit: 'piece', size: { w: 2.28, d: 0.95, h: 0.83 } });
  });

  it('signale les lignes incomplètes et accepte le JSON', async () => {
    const { parseCatalogFile } = await import('../../catalogImport');
    const r = parseCatalogFile(JSON.stringify([{ name: 'Lampe', category: 'luminaire', price: 20 }, { name: 'Chaise', category: 'furniture', subcategory: 'chair', price: '45,00' }]), 'x.json', 'B');
    expect(r.errors).toHaveLength(1);
    expect(r.products[0]).toMatchObject({ category: 'meuble', subcategory: 'chaise', price: 45, brand: 'B' });
  });
});

describe('connecteurs de catalogues', () => {
  it('reconnaît les résultats emballés et en tire des produits', async () => {
    const { findItems, toFound, foundToProducts, parseDimensions } = await import('../../connectors');
    expect(parseDimensions('Largeur: 80 cm, Profondeur: 28 cm, Hauteur: 202 cm')).toEqual({ w: 80, d: 28, h: 202 });
    expect(parseDimensions('BILLY 80x28x202 cm')).toEqual({ w: 80, d: 28, h: 202 });
    const ikea = [{ name: 'BILLY', typeName: 'Bibliothèque, blanc', price: { currentPrice: 59.99 }, measurements: '80x28x202 cm', url: 'https://example.test/billy', image: 'https://example.test/billy.jpg', id: '00263850' }];
    const found = toFound(findItems(ikea), 'IKEA', 'meuble');
    expect(found[0]).toMatchObject({ name: 'BILLY Bibliothèque, blanc', price: 59.99, brand: 'IKEA' });
    const { products, errors } = foundToProducts(found);
    expect(errors).toEqual([]);
    expect(products[0]).toMatchObject({ category: 'meuble', subcategory: 'rangement', color: '#f2f1ec', size: { w: 0.8, d: 0.28, h: 2.02 } });
    const brico = { success: true, data: { products: [{ title: 'Stratifié chêne naturel 8 mm', price: '24,95 €/m²', brand: 'Quick-Step', url: 'https://example.test/s' }] } };
    const sol = foundToProducts(toFound(findItems(brico), 'Brico', 'sol')).products[0];
    expect(sol).toMatchObject({ category: 'sol', brand: 'Quick-Step', saleUnit: 'paquet', packSize: 1, price: 24.95 });
  });

  it("n'appelle rien sans clé", async () => {
    const { searchConnector } = await import('../../connectors');
    await expect(searchConnector('ikea', 'billy', 10, 'meuble')).rejects.toThrow(/non configuré/);
    await expect(searchConnector('brico', 'parquet', 10, 'sol')).rejects.toThrow(/non configuré/);
  });
});

describe('pièces avec des coordonnées non arrondies', () => {
  it('ferme les pièces même quand les découpes laissent des écarts de l’ordre du dixième de millimètre', () => {
    const b = empty();
    // Coordonnées issues d'un retraçage (échelle quelconque) : les jonctions en T tombent à 0,1 mm près
    const pts: [number, number, number, number, number][] = [
      [1.16, 1.16, 1.16, 8.9, 0.3], [1.16, 5.52, 6.97, 5.52, 0.1], [6.97, 6, 10.84, 6, 0.1], [1.16, 8.9, 10.84, 8.9, 0.3],
      [6.97, 1.16, 6.97, 8.9, 0.15], [10.84, 1.16, 10.84, 8.9, 0.3], [1.16, 1.16, 10.84, 1.16, 0.3],
    ];
    pts.forEach(([ax, ay, bx, by, t], i) => insertWall(b, { ...w(`t${i}`, ax, ay, bx, by), thickness: t }));
    expect(detectRooms(b)).toHaveLength(4);
  });
});
