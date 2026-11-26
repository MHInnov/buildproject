/** Coordonnées en mètres, repère du plan (x vers la droite, y vers le bas). */
export interface Point {
  x: number;
  y: number;
}

export type WallKind = 'porteur' | 'cloison';
export type WallSide = 'gauche' | 'droite';

/** État constaté d'un élément existant (rénovation). */
export type Condition = 'bon' | 'moyen' | 'mauvais';

export const CONDITION_LABELS: Record<Condition, string> = {
  bon: 'Bon état',
  moyen: 'À rafraîchir',
  mauvais: 'À remplacer',
};

/** Plan importé affiché sous le dessin d'un niveau, pour le décalquer. */
export interface Underlay {
  /** Identifiant de l'image dans le stockage des fichiers (voir assets.ts). */
  assetId: string;
  /** Position du coin haut gauche de l'image, en mètres. */
  x: number;
  y: number;
  /** Échelle : mètres par pixel de l'image. */
  scale: number;
  /** Dimensions de l'image en pixels. */
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  /** Échelle mesurée par l'utilisateur (sinon estimée). */
  calibrated?: boolean;
}

/** Un niveau de la maison (cave, rez-de-chaussée, étage, combles). */
export interface Level {
  id: string;
  name: string;
  /** Altitude du sol fini, en mètres (0 = rez-de-chaussée). */
  elevation: number;
  /** Hauteur sous plafond, en mètres (pour les combles : hauteur des murs bas). */
  height: number;
  /** Épaisseur du plancher au-dessus, en mètres. */
  slab: number;
  underlay?: Underlay;
  /** Calage sur le niveau du dessous : à vérifier après un import, validé par l'utilisateur. */
  alignment?: 'a-verifier' | 'valide';
}

export type RoofType = 'deux-pans' | 'quatre-pans' | 'monopente' | 'plat';

export const ROOF_LABELS: Record<RoofType, string> = {
  'deux-pans': 'Deux pans',
  'quatre-pans': 'Quatre pans',
  monopente: 'Monopente',
  plat: 'Toit plat',
};

export interface Roof {
  type: RoofType;
  /** Niveau sur lequel repose la toiture (haut de ses murs). */
  levelId: string;
  /** Pente en degrés. */
  pitch: number;
  /** Débord de toiture, en mètres. */
  overhang: number;
  /** Faîtage parallèle à l'axe x (horizontal sur le plan) ou y. */
  ridge: 'x' | 'y';
  coveringId: string | null;
  insulationId: string | null;
  condition?: Condition;
  /**
   * Hauteur de l'égout (dessus de la couverture au droit des façades), au-dessus du sol du niveau qui
   * porte le toit. Des combles aménagés ont leurs murs bas en retrait : le toit part plus bas.
   * Absent : le haut des murs de ce niveau.
   */
  eave?: number;
  /** Fenêtres de toit (type Velux). */
  windows?: RoofWindow[];
  /** Bois de la charpente (voir data/exterior.ts) ; absent : sapin. */
  timber?: string;
  /** Combles aménagés : pannes et faîtage laissés apparents sous le rampant. */
  exposedBeams?: boolean;
  /**
   * Emprise du toit (faces extérieures, avant débord), quand elle ne se déduit pas des murs : combles
   * importés d'un plan, dont les pignons fixent la largeur d'égout à égout.
   */
  bounds?: { x0: number; y0: number; x1: number; y1: number };
}

/** Fenêtre de toit, posée dans un pan. Position et dimensions en projection sur le plan. */
export interface RoofWindow {
  id: string;
  /** Centre, en mètres. */
  x: number;
  y: number;
  /** Largeur le long de l'égout (m). */
  width: number;
  /** Longueur dans le sens de la pente, mesurée sur le plan (projection horizontale, m). */
  length: number;
  productId: string | null;
  condition?: Condition;
}

export interface Wall {
  id: string;
  levelId: string;
  a: Point;
  b: Point;
  /** Épaisseur en mètres. */
  thickness: number;
  /** Hauteur en mètres. */
  height: number;
  kind: WallKind;
  /** Revêtement de chaque face (id produit catalogue), null = enduit brut. */
  finish: Record<WallSide, string | null>;
  condition?: Condition;
  /**
   * Composition d'un mur à plusieurs couches (mur creux : parement en brique, coulisse, bloc béton), de la face
   * gauche à la face droite. Absente pour un mur d'un seul matériau.
   */
  layers?: WallLayer[];
}

export type WallLayerKind = 'brique' | 'bloc' | 'beton' | 'isolant' | 'vide' | 'pierre' | 'bois' | 'platre';

export interface WallLayer {
  kind: WallLayerKind;
  /** Épaisseur en mètres. */
  thickness: number;
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
  condition?: Condition;
  /** Réglages d'un modèle générique (couleur, vantaux, variante). */
  options?: ItemOptions;
  /**
   * Sens d'ouverture d'une porte : charnière du côté de wall.a ou de wall.b, débattement vers la face gauche
   * ou droite du mur. Absent : charnière côté a, vers la pièce.
   */
  swing?: OpeningSwing;
}

export interface OpeningSwing {
  hinge: 'a' | 'b';
  side: WallSide;
}

/** Réglages d'un objet générique paramétrable (voir model/generic.ts). */
export interface ItemOptions {
  /** Couleur choisie (sinon celle du produit). */
  color?: string;
  /** Nombre de vantaux : porte simple ou double, fenêtre à 1, 2 ou 3 ouvrants. */
  leaves?: number;
  /** Variante du modèle (porte vitrée, fenêtre coulissante, porte de garage basculante…). */
  style?: string;
  /** Dimensions d'un meuble, en mètres (largeur, profondeur, hauteur). */
  size?: { w: number; d: number; h: number };
}

/**
 * Une pièce est détectée automatiquement à partir des murs fermés.
 * Ses informations (nom, sol) sont rattachées à un point repère situé à l'intérieur,
 * ce qui les garde stables quand les murs sont redécoupés.
 */
export interface RoomLabel {
  id: string;
  levelId: string;
  at: Point;
  name: string;
  floorProductId: string | null;
  floorCondition?: Condition;
  /** Hauteur sous plafond propre à la pièce (sinon celle du niveau), en mètres. */
  ceilingHeight?: number;
  /** Sol plus haut (+) ou plus bas (−) que le niveau : marche, estrade, pièce en contrebas, en mètres. */
  floorOffset?: number;
}

/**
 * Zone de sol : un revêtement posé sur une partie seulement d'une pièce
 * (tapis de carrelage devant l'évier, coin parquet…). Rectangle aligné sur le plan.
 */
export interface FloorZone {
  id: string;
  levelId: string;
  /** Coin haut gauche, en mètres. */
  x: number;
  y: number;
  /** Largeur (selon x) et profondeur (selon y), en mètres. */
  w: number;
  h: number;
  productId: string | null;
  condition?: Condition;
}

export interface FurnitureItem {
  id: string;
  levelId: string;
  productId: string;
  x: number;
  y: number;
  /** Rotation en degrés. */
  rotation: number;
  /** Réglages d'un meuble générique (couleur, dimensions, variante). */
  options?: ItemOptions;
}

/** Maison (toiture, jardin) ou appartement (dans un immeuble : ni toit ni terrain). */
export type DwellingKind = 'maison' | 'appartement';

export interface Building {
  /** Type de logement ; absent : maison (anciens projets). */
  kind?: DwellingKind;
  /** Appartement : étage dans l'immeuble (0 = rez-de-chaussée). */
  storey?: number;
  /** Niveaux, du plus bas au plus haut. */
  levels: Level[];
  walls: Wall[];
  openings: Opening[];
  rooms: RoomLabel[];
  furniture: FurnitureItem[];
  /** Sols posés sur une partie de pièce (absent dans les anciens projets). */
  floorZones?: FloorZone[];
  roof: Roof | null;
  /** Terrain autour de la maison, lu sur le plan d'implantation (absent sinon). */
  site?: Site;
  /** Sol du rez-de-chaussée au-dessus du terrain (soubassement), en mètres ; absent : de plain-pied. */
  plinth?: number;
  /** Revêtements extérieurs (pelouse, abords de la maison) ; absent : pelouse par défaut, sans abords. */
  outdoor?: Outdoor;
}

/** Revêtements extérieurs, voir data/exterior.ts. */
export interface Outdoor {
  /** Sol du jardin et du terrain autour. */
  lawn?: string;
  /** Abords : bande autour de la maison (terrasse, allée, gravier), absente si null. */
  apron?: string | null;
  /** Largeur des abords, en mètres. */
  apronWidth?: number;
}

/** Parcelle : contour en mètres, dans le repère du plan (la maison à sa place). */
export interface Site {
  parcel: Point[];
}

/**
 * Point de vue : une photo prise depuis un endroit précis de la maison.
 * Elle sert à relever les matériaux et à placer portes, fenêtres et meubles au bon endroit.
 */
export interface Viewpoint {
  id: string;
  levelId: string;
  x: number;
  y: number;
  /** Direction de la prise de vue en degrés (0 = vers la droite du plan, 90 = vers le bas). */
  direction: number;
  /** Angle de vue horizontal en degrés (environ 65° pour un smartphone). */
  fov: number;
  /** Hauteur de l'appareil, en mètres. */
  eye: number;
  assetId: string | null;
  caption: string;
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
  /** Pièces entièrement contenues (îlots), à exclure du sol. */
  holes?: Point[][];
}

/** Une modification du projet par rapport à l'existant. */
export type Operation =
  | { type: 'demolishWall'; wallId: string }
  | { type: 'addWall'; wall: Wall }
  | { type: 'addOpening'; opening: Opening }
  | { type: 'removeOpening'; openingId: string }
  | { type: 'replaceOpening'; openingId: string; productId: string; options?: ItemOptions }
  | { type: 'setFloor'; roomId: string; productId: string }
  | { type: 'addFloorZone'; zone: FloorZone }
  | { type: 'setFloorZone'; zoneId: string; productId: string }
  | { type: 'removeFloorZone'; zoneId: string }
  | { type: 'setWallHeight'; wallId: string; height: number }
  | { type: 'setRoomHeights'; roomId: string; ceilingHeight?: number; floorOffset?: number }
  | { type: 'setWallFinish'; wallId: string; side: WallSide; productId: string }
  | { type: 'addFurniture'; item: FurnitureItem }
  | { type: 'removeFurniture'; furnitureId: string }
  | { type: 'moveFurniture'; furnitureId: string; x: number; y: number; rotation: number }
  | { type: 'setFurnitureOptions'; furnitureId: string; options?: ItemOptions }
  | { type: 'setRoofCovering'; productId: string }
  | { type: 'setRoofInsulation'; productId: string }
  | { type: 'addRoofWindow'; window: RoofWindow }
  | { type: 'removeRoofWindow'; windowId: string }
  | { type: 'replaceRoofWindow'; windowId: string; productId: string };

export interface Project {
  version: 2;
  name: string;
  /** Code postal, utile pour les artisans et la TVA. */
  postalCode: string;
  /** Logement de plus de 10 ans : TVA réduite à 6 % (à vérifier selon le cas). */
  olderThan10Years: boolean;
  existing: Building;
  operations: Operation[];
  viewpoints: Viewpoint[];
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
  | 'toiture'
  | 'isolation'
  | 'escaliers'
  | 'sanitaire'
  | 'mobilier';

export const LOT_LABELS: Record<Lot, string> = {
  demolition: 'Démolition',
  'gros-oeuvre': 'Gros œuvre et cloisons',
  menuiserie: 'Menuiseries (portes et châssis)',
  sols: 'Revêtements de sol',
  peinture: 'Peinture',
  carrelage: 'Carrelage et faïence',
  toiture: 'Toiture',
  isolation: 'Isolation',
  escaliers: 'Escaliers',
  sanitaire: 'Sanitaires et plomberie',
  mobilier: 'Mobilier et équipement',
};

export const LOT_ORDER: Lot[] = [
  'demolition',
  'gros-oeuvre',
  'toiture',
  'isolation',
  'menuiserie',
  'escaliers',
  'sols',
  'carrelage',
  'peinture',
  'sanitaire',
  'mobilier',
];
