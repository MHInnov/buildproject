import { detectRooms, insertWall, wallSideFacingRoom } from '../model/geometry';
import { defaultLevel } from '../model/levels';
import type { Building, DwellingKind, Project, Wall, WallKind } from '../model/types';

const H = 2.6;
const KNEE = 1.0;

function wall(id: string, ax: number, ay: number, bx: number, by: number, kind: WallKind, thickness?: number, levelId = 'rdc', height = H): Wall {
  return {
    id,
    levelId,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
    kind,
    thickness: thickness ?? (kind === 'porteur' ? 0.3 : 0.1),
    height,
    finish: { gauche: null, droite: null },
  };
}

/** Maison de démonstration à rénover : rez-de-chaussée de 10 × 8 m (4 pièces), combles sous toiture à deux pans. */
export function demoBuilding(): Building {
  const b: Building = {
    levels: [defaultLevel(), { id: 'combles', name: 'Combles', elevation: H + 0.22, height: KNEE, slab: 0.2 }],
    walls: [],
    openings: [],
    rooms: [],
    furniture: [],
    roof: { type: 'deux-pans', levelId: 'combles', pitch: 40, overhang: 0.35, ridge: 'x', coveringId: 'ex-toit-tuiles', insulationId: 'ex-isolation-aucune', condition: 'moyen' },
  };
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
  // Combles : murs bas (jambettes) sous la toiture
  insertWall(b, wall('k-n', 0, 0, 10, 0, 'porteur', 0.3, 'combles', KNEE));
  insertWall(b, wall('k-e', 10, 0, 10, 8, 'porteur', 0.3, 'combles', KNEE));
  insertWall(b, wall('k-s', 10, 8, 0, 8, 'porteur', 0.3, 'combles', KNEE));
  insertWall(b, wall('k-o', 0, 8, 0, 0, 'porteur', 0.3, 'combles', KNEE));

  const wallAt = (id: string) => b.walls.find((w) => w.id === id || w.id.startsWith(`${id}.`))!.id;
  const find = (pred: (w: Wall) => boolean) => b.walls.find(pred)!.id;

  b.openings.push(
    // Porte d'entrée et fenêtres en façade nord (séjour + cuisine)
    { id: 'o-entree', wallId: find((w) => w.id.startsWith('w-n') && w.b.x <= 6.01), kind: 'porte', offset: 2.0, width: 1.0, height: 2.1, sill: 0, productId: 'ex-porte-bois', condition: 'moyen' },
    { id: 'o-f-sejour', wallId: find((w) => w.id.startsWith('w-n') && w.b.x <= 6.01), kind: 'fenetre', offset: 4.2, width: 1.6, height: 1.4, sill: 0.9, productId: 'ex-fenetre-bois-simple', condition: 'mauvais' },
    { id: 'o-f-cuisine', wallId: find((w) => w.id.startsWith('w-n') && w.a.x >= 5.99), kind: 'fenetre', offset: 2.0, width: 1.2, height: 1.2, sill: 1.0, productId: 'ex-fenetre-bois-simple', condition: 'mauvais' },
    // Fenêtre chambre (façade sud) et salle de bain (façade est)
    { id: 'o-f-chambre', wallId: find((w) => w.id.startsWith('w-s') && w.a.x <= 6.01), kind: 'fenetre', offset: 3.0, width: 1.4, height: 1.3, sill: 0.95, productId: 'ex-fenetre-bois-simple', condition: 'mauvais' },
    { id: 'o-f-sdb', wallId: find((w) => w.id.startsWith('w-e') && w.a.y >= 4.99), kind: 'fenetre', offset: 1.5, width: 0.8, height: 0.8, sill: 1.4, productId: 'chassis-pvc-blanc', condition: 'bon' },
    // Portes intérieures
    { id: 'o-p-chambre', wallId: wallAt('w-c1'), kind: 'porte', offset: 4.8, width: 0.83, height: 2.01, sill: 0, productId: 'ex-porte-isoplane', condition: 'moyen' },
    { id: 'o-p-cuisine', wallId: find((w) => w.id.startsWith('w-refend') && w.b.y <= 4.51), kind: 'porte', offset: 2.5, width: 0.83, height: 2.01, sill: 0, productId: 'ex-porte-isoplane', condition: 'moyen' },
    { id: 'o-p-sdb', wallId: wallAt('w-c2'), kind: 'porte', offset: 1.0, width: 0.83, height: 2.01, sill: 0, productId: 'ex-porte-isoplane', condition: 'moyen' },
    // Petite fenêtre dans le pignon des combles
    { id: 'o-f-combles', wallId: find((w) => w.id.startsWith('k-e')), kind: 'fenetre', offset: 4.0, width: 0.6, height: 0.6, sill: 0.3, productId: 'ex-fenetre-bois-simple', condition: 'mauvais' },
  );

  b.rooms.push(
    { id: 'r-sejour', levelId: 'rdc', at: { x: 3, y: 2.2 }, name: 'Séjour', floorProductId: 'ex-sol-plancher', floorCondition: 'moyen' },
    { id: 'r-chambre', levelId: 'rdc', at: { x: 3, y: 6.2 }, name: 'Chambre', floorProductId: 'ex-sol-moquette', floorCondition: 'mauvais' },
    { id: 'r-cuisine', levelId: 'rdc', at: { x: 8, y: 2.5 }, name: 'Cuisine', floorProductId: 'ex-sol-carrelage-ancien', floorCondition: 'moyen' },
    { id: 'r-sdb', levelId: 'rdc', at: { x: 8, y: 6.5 }, name: 'Salle de bain', floorProductId: 'ex-sol-carrelage-ancien', floorCondition: 'moyen' },
    { id: 'r-grenier', levelId: 'combles', at: { x: 5, y: 4 }, name: 'Grenier', floorProductId: 'ex-sol-plancher', floorCondition: 'bon' },
  );

  b.furniture.push(
    { id: 'f-escalier', levelId: 'rdc', productId: 'escalier-droit-sapin', x: 0.6, y: 2.65, rotation: 0 },
    { id: 'f-canape', levelId: 'rdc', productId: 'canape-3p-gris', x: 3.0, y: 2.4, rotation: 180 },
    { id: 'f-table', levelId: 'rdc', productId: 'table-ronde-blanche', x: 4.8, y: 1.4, rotation: 0 },
    { id: 'f-tv', levelId: 'rdc', productId: 'meuble-tv-chene', x: 3.0, y: 4.2, rotation: 180 },
    { id: 'f-lit', levelId: 'rdc', productId: 'lit-140-bois', x: 2.0, y: 6.6, rotation: 0 },
    { id: 'f-armoire', levelId: 'rdc', productId: 'armoire-blanche', x: 5.2, y: 7.45, rotation: 0 },
    { id: 'f-cuisine', levelId: 'rdc', productId: 'cuisine-lineaire-blanche', x: 8.35, y: 0.5, rotation: 0 },
    { id: 'f-vasque', levelId: 'rdc', productId: 'meuble-vasque', x: 7.0, y: 7.6, rotation: 0 },
    { id: 'f-wc', levelId: 'rdc', productId: 'wc-sol', x: 9.5, y: 6.3, rotation: 90 },
    { id: 'f-radiateur', levelId: 'rdc', productId: 'radiateur-acier', x: 4.2, y: 0.22, rotation: 0 },
  );

  // Revêtements muraux actuels : papier peint dans le séjour et la chambre, faïence dans la salle de bain.
  const finishes: Record<string, string> = { 'r-sejour': 'ex-mur-papier-peint', 'r-chambre': 'ex-mur-papier-peint', 'r-cuisine': 'peint-blanc-casse', 'r-sdb': 'ex-mur-faience', 'r-grenier': 'ex-mur-brique' };
  for (const room of detectRooms(b)) {
    const pid = finishes[room.label.id];
    if (!pid) continue;
    for (const id of room.wallIds) {
      const w = b.walls.find((x) => x.id === id);
      const side = w && wallSideFacingRoom(w, room);
      if (w && side) w.finish[side] = pid;
    }
  }
  return b;
}

export function demoProject(): Project {
  return {
    version: 2,
    name: 'Ma maison',
    postalCode: '',
    olderThan10Years: true,
    existing: demoBuilding(),
    operations: [],
    viewpoints: [],
    artisans: [],
    assignments: {},
  };
}

export function emptyProject(kind: DwellingKind = 'maison'): Project {
  return {
    version: 2,
    name: kind === 'appartement' ? 'Mon appartement' : 'Nouveau projet',
    postalCode: '',
    olderThan10Years: true,
    existing: { ...(kind === 'appartement' ? { kind, storey: 0 } : {}), levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null },
    operations: [],
    viewpoints: [],
    artisans: [],
    assignments: {},
  };
}
