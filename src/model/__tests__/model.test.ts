import { describe, expect, it } from 'vitest';
import { DEMO_CATALOG } from '../../data/catalog';
import { demoBuilding, demoProject } from '../../data/demoProject';
import { computeEstimate, packMaterial, paintMaterial } from '../estimate';
import { detectRooms, insertWall } from '../geometry';
import { applyOperations, pushOperation } from '../operations';
import { parseQuery, searchCatalog } from '../search';
import type { Building, Wall } from '../types';

const w = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({
  id, a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness: 0, height: 2.5, kind: 'cloison', finish: { gauche: null, droite: null },
});
const empty = (): Building => ({ walls: [], openings: [], rooms: [], furniture: [] });

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

  it('la maison de démo a 4 pièces étiquetées', () => {
    const rooms = detectRooms(demoBuilding());
    expect(rooms.map((r) => r.label.name).sort()).toEqual(['Chambre', 'Cuisine', 'Salle de bain', 'Séjour']);
  });
});

describe('opérations', () => {
  it('démolir la cloison fusionne séjour et chambre', () => {
    const b = demoBuilding();
    const ops = pushOperation([], { type: 'demolishWall', wallId: 'w-c1' });
    const rooms = detectRooms(applyOperations(b, ops));
    expect(rooms).toHaveLength(3);
    expect(b.walls.some((x) => x.id === 'w-c1')).toBe(true); // l'existant n'est pas modifié
  });

  it('une modification de la même cible remplace la précédente', () => {
    let ops = pushOperation([], { type: 'setFloor', roomId: 'r-sejour', productId: 'sol-strat-gris' });
    ops = pushOperation(ops, { type: 'setFloor', roomId: 'r-sejour', productId: 'sol-parquet-chene' });
    expect(ops).toHaveLength(1);
  });

  it('retirer un meuble ajouté annule son ajout', () => {
    let ops = pushOperation([], { type: 'addFurniture', item: { id: 'x', productId: 'chaise-bois', x: 1, y: 1, rotation: 0 } });
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
      { type: 'addFurniture', item: { id: 'n', productId: 'canape-angle-beige', x: 3, y: 2, rotation: 0 } },
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
    expect(results[0].product.id).toBe('canape-angle-beige');
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
