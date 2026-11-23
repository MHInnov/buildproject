/** Coordonnées en mètres, repère du plan (x vers la droite, y vers le bas). */
export interface Point {
  x: number;
  y: number;
}

export type WallKind = 'porteur' | 'cloison';
export type WallSide = 'gauche' | 'droite';

export interface Wall {
  id: string;
  a: Point;
  b: Point;
  /** Épaisseur en mètres. */
  thickness: number;
  /** Hauteur en mètres. */
  height: number;
  kind: WallKind;
  /** Revêtement de chaque face (id produit catalogue), null = enduit brut. */
  finish: Record<WallSide, string | null>;
}

export type OpeningKind = 'porte' | 'fenetre';

export interface Opening {
  id: string;
  wallId: string;
  kind: OpeningKind;
  /** Position du centre de l'ouverture le long du mur, en mètres depuis wall.a. */
  offset: number;
  width: number;
  height: number;
  /** Hauteur d'allège (bas de l'ouverture) en mètres. */
  sill: number;
  productId: string | null;
}

/**
 * Une pièce est détectée automatiquement à partir des murs fermés.
 * Ses informations (nom, sol) sont rattachées à un point repère situé à l'intérieur,
 * ce qui les garde stables quand les murs sont redécoupés.
 */
export interface RoomLabel {
  id: string;
  at: Point;
  name: string;
  floorProductId: string | null;
}

export interface FurnitureItem {
  id: string;
  productId: string;
  x: number;
  y: number;
  /** Rotation en degrés. */
  rotation: number;
}

export interface Building {
  walls: Wall[];
  openings: Opening[];
  rooms: RoomLabel[];
  furniture: FurnitureItem[];
}

/** Pièce calculée : polygone fermé + informations. */
export interface Room {
  label: RoomLabel;
  polygon: Point[];
  /** Surface au sol en m². */
  area: number;
  /** Périmètre en m. */
  perimeter: number;
  wallIds: string[];
}

/** Une modification du projet par rapport à l'existant. */
export type Operation =
  | { type: 'demolishWall'; wallId: string }
  | { type: 'addWall'; wall: Wall }
  | { type: 'addOpening'; opening: Opening }
  | { type: 'removeOpening'; openingId: string }
  | { type: 'replaceOpening'; openingId: string; productId: string }
  | { type: 'setFloor'; roomId: string; productId: string }
  | { type: 'setWallFinish'; wallId: string; side: WallSide; productId: string }
  | { type: 'addFurniture'; item: FurnitureItem }
  | { type: 'removeFurniture'; furnitureId: string }
  | { type: 'moveFurniture'; furnitureId: string; x: number; y: number; rotation: number };

export interface Project {
  version: 1;
  name: string;
  /** Code postal, utile pour les artisans et la TVA. */
  postalCode: string;
  /** Logement de plus de 10 ans : TVA réduite à 6 % (à vérifier selon le cas). */
  olderThan10Years: boolean;
  existing: Building;
  operations: Operation[];
  artisans: Artisan[];
  /** Artisan retenu par poste : lot -> id artisan. */
  assignments: Partial<Record<Lot, string>>;
}

export interface Artisan {
  id: string;
  name: string;
  lots: Lot[];
  city: string;
  phone: string;
  email: string;
  notes: string;
}

/** Postes de travail (corps de métier). */
export type Lot =
  | 'demolition'
  | 'gros-oeuvre'
  | 'menuiserie'
  | 'sols'
  | 'peinture'
  | 'carrelage'
  | 'mobilier';

export const LOT_LABELS: Record<Lot, string> = {
  demolition: 'Démolition',
  'gros-oeuvre': 'Gros œuvre et cloisons',
  menuiserie: 'Menuiseries (portes et châssis)',
  sols: 'Revêtements de sol',
  peinture: 'Peinture',
  carrelage: 'Carrelage et faïence',
  mobilier: 'Mobilier et équipement',
};

export const LOT_ORDER: Lot[] = [
  'demolition',
  'gros-oeuvre',
  'menuiserie',
  'sols',
  'carrelage',
  'peinture',
  'mobilier',
];
