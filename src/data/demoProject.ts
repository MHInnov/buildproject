import { insertWall } from '../model/geometry';
import type { Building, Project, Wall, WallKind } from '../model/types';

const H = 2.6;

function wall(id: string, ax: number, ay: number, bx: number, by: number, kind: WallKind, thickness?: number): Wall {
  return {
    id,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    kind,
    thickness: thickness ?? (kind === 'porteur' ? 0.3 : 0.1),
    height: H,
    finish: { gauche: null, droite: null },
  };
}

/** Maison de démonstration : rez-de-chaussée de 10 × 8 m, 4 pièces. */
export function demoBuilding(): Building {
  const b: Building = { walls: [], openings: [], rooms: [], furniture: [] };
  // Façades (porteuses)
  insertWall(b, wall('w-n', 0, 0, 10, 0, 'porteur'));
  insertWall(b, wall('w-e', 10, 0, 10, 8, 'porteur'));
  insertWall(b, wall('w-s', 10, 8, 0, 8, 'porteur'));
  insertWall(b, wall('w-o', 0, 8, 0, 0, 'porteur'));
  // Mur de refend porteur entre séjour et cuisine
  insertWall(b, wall('w-refend', 6, 0, 6, 8, 'porteur', 0.2));
  // Cloisons : séparation salon / chambre et cuisine / salle de bain
  insertWall(b, wall('w-c1', 0, 4.5, 6, 4.5, 'cloison'));
  insertWall(b, wall('w-c2', 6, 5, 10, 5, 'cloison'));

  const wallAt = (id: string) => b.walls.find((w) => w.id === id || w.id.startsWith(`${id}.`))!.id;
  const find = (pred: (w: Wall) => boolean) => b.walls.find(pred)!.id;

  b.openings.push(
    // Porte d'entrée et fenêtres en façade nord (séjour + cuisine)
    { id: 'o-entree', wallId: find((w) => w.id.startsWith('w-n') && w.b.x <= 6.01), kind: 'porte', offset: 1.2, width: 1.0, height: 2.1, sill: 0, productId: null },
    { id: 'o-f-sejour', wallId: find((w) => w.id.startsWith('w-n') && w.b.x <= 6.01), kind: 'fenetre', offset: 3.8, width: 1.6, height: 1.4, sill: 0.9, productId: 'chassis-pvc-blanc' },
    { id: 'o-f-cuisine', wallId: find((w) => w.id.startsWith('w-n') && w.a.x >= 5.99), kind: 'fenetre', offset: 2.0, width: 1.2, height: 1.2, sill: 1.0, productId: 'chassis-pvc-blanc' },
    // Fenêtre chambre (façade sud) et salle de bain (façade est)
    { id: 'o-f-chambre', wallId: find((w) => w.id.startsWith('w-s') && w.a.x <= 6.01), kind: 'fenetre', offset: 3.0, width: 1.4, height: 1.3, sill: 0.95, productId: 'chassis-pvc-blanc' },
    { id: 'o-f-sdb', wallId: find((w) => w.id.startsWith('w-e') && w.a.y >= 4.99), kind: 'fenetre', offset: 1.5, width: 0.8, height: 0.8, sill: 1.4, productId: 'chassis-pvc-blanc' },
    // Portes intérieures
    { id: 'o-p-chambre', wallId: wallAt('w-c1'), kind: 'porte', offset: 4.8, width: 0.83, height: 2.01, sill: 0, productId: 'porte-int-blanche' },
    { id: 'o-p-cuisine', wallId: find((w) => w.id.startsWith('w-refend') && w.b.y <= 4.51), kind: 'porte', offset: 2.5, width: 0.83, height: 2.01, sill: 0, productId: 'porte-int-blanche' },
    { id: 'o-p-sdb', wallId: wallAt('w-c2'), kind: 'porte', offset: 1.0, width: 0.83, height: 2.01, sill: 0, productId: 'porte-int-blanche' },
  );

  b.rooms.push(
    { id: 'r-sejour', at: { x: 3, y: 2.2 }, name: 'Séjour', floorProductId: 'sol-strat-chene-naturel' },
    { id: 'r-chambre', at: { x: 3, y: 6.2 }, name: 'Chambre', floorProductId: 'sol-strat-chene-naturel' },
    { id: 'r-cuisine', at: { x: 8, y: 2.5 }, name: 'Cuisine', floorProductId: 'sol-carrelage-gris-60' },
    { id: 'r-sdb', at: { x: 8, y: 6.5 }, name: 'Salle de bain', floorProductId: 'sol-carrelage-gris-60' },
  );

  b.furniture.push(
    { id: 'f-canape', productId: 'canape-3p-gris', x: 2.2, y: 2.4, rotation: 180 },
    { id: 'f-table', productId: 'table-ronde-blanche', x: 4.6, y: 1.6, rotation: 0 },
    { id: 'f-tv', productId: 'meuble-tv-chene', x: 2.2, y: 4.2, rotation: 180 },
    { id: 'f-lit', productId: 'lit-140-bois', x: 2.0, y: 6.6, rotation: 0 },
    { id: 'f-armoire', productId: 'armoire-blanche', x: 5.2, y: 7.45, rotation: 0 },
    { id: 'f-cuisine', productId: 'cuisine-lineaire-blanche', x: 8.35, y: 0.5, rotation: 0 },
    { id: 'f-vasque', productId: 'meuble-vasque', x: 7.0, y: 7.6, rotation: 0 },
  );
  return b;
}

export function demoProject(): Project {
  return {
    version: 1,
    name: 'Ma maison',
    postalCode: '',
    olderThan10Years: true,
    existing: demoBuilding(),
    operations: [],
    artisans: [],
    assignments: {},
  };
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: 'Nouveau projet',
    postalCode: '',
    olderThan10Years: true,
    existing: { walls: [], openings: [], rooms: [], furniture: [] },
    operations: [],
    artisans: [],
    assignments: {},
  };
}
