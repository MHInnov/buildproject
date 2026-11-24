import { create } from 'zustand';
import type { Point } from './model/types';

/** État d'interface éphémère partagé entre le plan et les panneaux (non sauvegardé). */
interface UiState {
  /** Glisser le plan importé au lieu de déplacer la vue. */
  moveUnderlay: boolean;
  /** Points cliqués pour l'étalonnage du plan importé. */
  calibration: Point[];
  /** Aperçu du retraçage (masque) affiché sur le plan. */
  tracePreview: string | null;
  /** Point de vue à reproduire dans la visite 3D (comparaison photo / maquette). */
  viewFrom: string | null;
  /** Visite 3D : portes et fenêtres dont l'état a été inversé (portes ouvertes par défaut, fenêtres fermées). */
  toggled: Record<string, boolean>;
  /** Visite 3D : lumières allumées, par pièce. */
  lights: Record<string, boolean>;
  toggle: (id: string) => void;
  toggleLight: (roomId: string) => void;
  set: (p: Partial<Omit<UiState, 'set'>>) => void;
}

export const useUi = create<UiState>((set) => ({
  moveUnderlay: false,
  calibration: [],
  tracePreview: null,
  viewFrom: null,
  toggled: {},
  lights: {},
  toggle: (id) => set((s) => ({ toggled: { ...s.toggled, [id]: !s.toggled[id] } })),
  toggleLight: (id) => set((s) => ({ lights: { ...s.lights, [id]: !s.lights[id] } })),
  set: (p) => set(p),
}));
