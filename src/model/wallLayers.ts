import type { Wall, WallLayer, WallLayerKind } from './types';

/** Matériaux possibles d'une couche de mur, avec leur nom et leur couleur sur le plan. */
export const LAYER_KINDS: { kind: WallLayerKind; label: string; color: string }[] = [
  { kind: 'brique', label: 'Brique de parement', color: '#b45b43' },
  { kind: 'bloc', label: 'Bloc béton', color: '#6f7379' },
  { kind: 'beton', label: 'Béton', color: '#8a8d91' },
  { kind: 'pierre', label: 'Pierre', color: '#a08d6c' },
  { kind: 'isolant', label: 'Isolant', color: '#e8d36f' },
  { kind: 'vide', label: "Coulisse (lame d'air)", color: '#f3efe6' },
  { kind: 'bois', label: 'Ossature bois', color: '#a9784b' },
  { kind: 'platre', label: 'Plâtre, doublage', color: '#dcdad5' },
];

export const layerInfo = (k: WallLayerKind) => LAYER_KINDS.find((x) => x.kind === k) ?? LAYER_KINDS[1];

/** Mur creux courant : parement en brique, coulisse isolée, bloc béton, à l'épaisseur du mur. */
export function cavityWall(thickness: number): WallLayer[] {
  const base: WallLayer[] = [
    { kind: 'brique', thickness: 0.09 },
    { kind: 'isolant', thickness: 0.06 },
    { kind: 'bloc', thickness: 0.19 },
  ];
  return fitLayers(base, thickness);
}

/**
 * Façade d'une maison récente : parement brique 9 cm, isolant 6 cm, bloc béton 18 cm, enduit plâtre 1,5 cm
 * (de l'extérieur vers l'intérieur), à l'épaisseur du mur.
 */
export function facadeLayers(thickness: number): WallLayer[] {
  return fitLayers(
    [
      { kind: 'brique', thickness: 0.09 },
      { kind: 'isolant', thickness: 0.06 },
      { kind: 'bloc', thickness: 0.18 },
      { kind: 'platre', thickness: 0.015 },
    ],
    thickness,
  );
}

/** Couches remises à l'épaisseur totale du mur (au centimètre). */
export function fitLayers(layers: WallLayer[], thickness: number): WallLayer[] {
  const sum = layers.reduce((s, l) => s + l.thickness, 0) || 1;
  const k = thickness / sum;
  const out = layers.map((l) => ({ ...l, thickness: Math.max(0.01, Math.round(l.thickness * k * 100) / 100) }));
  // l'arrondi tombe sur la plus épaisse
  const diff = Math.round((thickness - out.reduce((s, l) => s + l.thickness, 0)) * 100) / 100;
  if (diff) {
    const i = out.reduce((m, l, j) => (l.thickness > out[m].thickness ? j : m), 0);
    out[i].thickness = Math.round((out[i].thickness + diff) * 100) / 100;
  }
  return out;
}

/** Bandes de chaque couche, en décalage depuis l'axe du mur vers sa face gauche (centre, épaisseur), en mètres. */
export function layerBands(w: Wall): { layer: WallLayer; offset: number; thickness: number }[] {
  if (!w.layers?.length) return [];
  const sum = w.layers.reduce((s, l) => s + l.thickness, 0) || 1;
  const k = w.thickness / sum;
  let at = w.thickness / 2;
  return w.layers.map((layer) => {
    const t = layer.thickness * k;
    const band = { layer, offset: at - t / 2, thickness: t };
    at -= t;
    return band;
  });
}

/** Description courte : « brique 9 cm + isolant 6 cm + bloc béton 19 cm ». */
export function describeLayers(layers: WallLayer[]): string {
  return layers.map((l) => `${layerInfo(l.kind).label.toLowerCase()} ${Math.round(l.thickness * 100)} cm`).join(' + ');
}
