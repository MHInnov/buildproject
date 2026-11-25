import { create } from 'zustand';
import { DEMO_CATALOG } from './data/catalog';
import { loadImported, mergeCatalogs } from './catalogImport';
import { demoProject, emptyProject } from './data/demoProject';
import type { Catalog } from './model/catalog';
import { migrateProject } from './model/levels';
import { applyOperations, pushOperation } from './model/operations';
import type { Building, Operation, Project, WallSide } from './model/types';

export type Step = 'existant' | 'projet' | 'visite' | 'artisans' | 'resume';
export type Tool = 'select' | 'wall' | 'room' | 'zone' | 'door' | 'window' | 'furniture' | 'viewpoint' | 'calibrate';

export type Selection =
  | { kind: 'wall'; id: string; side?: WallSide }
  | { kind: 'viewpoint'; id: string }
  | { kind: 'roof'; id: 'roof' }
  | { kind: 'level'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'furniture'; id: string }
  | { kind: 'zone'; id: string }
  | null;

interface State {
  project: Project;
  catalog: Catalog;
  step: Step;
  tool: Tool;
  /** Niveau affiché dans le plan. */
  levelId: string;
  /** Produit à placer avec l'outil meuble. */
  pendingProductId: string | null;
  selection: Selection;
  past: Project[];
  future: Project[];

  setStep: (s: Step) => void;
  setLevel: (id: string) => void;
  setTool: (t: Tool, productId?: string | null) => void;
  select: (s: Selection) => void;
  /** Modifie l'existant (étape 1). */
  editExisting: (fn: (b: Building) => void) => void;
  /** Ajoute une opération au projet (étape 2 et visite 3D). */
  addOperation: (op: Operation) => void;
  removeOperation: (index: number) => void;
  updateProject: (fn: (p: Project) => void) => void;
  undo: () => void;
  redo: () => void;
  loadProject: (p: Project) => void;
  resetDemo: () => void;
  resetEmpty: () => void;
}

const STORAGE_KEY = 'construprojet:v1';
const UI_KEY = 'construprojet:ui';

function loadInitial(): Project {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = migrateProject(JSON.parse(raw));
      if (p) return p;
    }
  } catch {
    /* stockage indisponible : on repart de la démo */
  }
  return demoProject();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(p: Project) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* quota ou mode privé : on ignore */
    }
  }, 200);
}

const HISTORY = 100;

export const useStore = create<State>((set, get) => {
  const validLevel = (p: Project) => (p.existing.levels.some((l) => l.id === get().levelId) ? get().levelId : (p.existing.levels[0]?.id ?? 'rdc'));
  const commit = (next: Project) => {
    const { project, past } = get();
    save(next);
    set({ project: next, past: [...past.slice(-HISTORY + 1), project], future: [], levelId: validLevel(next) });
  };

  const project = loadInitial();
  let levelId = project.existing.levels[0]?.id ?? 'rdc';
  try {
    const ui = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as { levelId?: string };
    if (ui.levelId && project.existing.levels.some((l) => l.id === ui.levelId)) levelId = ui.levelId;
  } catch {
    /* ignore */
  }
  return {
    project,
    catalog: mergeCatalogs(DEMO_CATALOG, loadImported()),
    step: 'existant',
    tool: 'select',
    levelId,
    pendingProductId: null,
    selection: null,
    past: [],
    future: [],

    setStep: (step) => set({ step, selection: null, tool: 'select' }),
    setLevel: (levelId) => {
      try {
        localStorage.setItem(UI_KEY, JSON.stringify({ levelId }));
      } catch {
        /* ignore */
      }
      set({ levelId, selection: null, tool: 'select' });
    },
    setTool: (tool, productId = null) => set({ tool, pendingProductId: productId, selection: null }),
    select: (selection) => set({ selection }),
    editExisting: (fn) => {
      const next = structuredClone(get().project);
      fn(next.existing);
      commit(next);
    },
    addOperation: (op) => {
      const p = get().project;
      commit({ ...p, operations: pushOperation(p.operations, op) });
    },
    removeOperation: (index) => {
      const p = get().project;
      commit({ ...p, operations: p.operations.filter((_, i) => i !== index) });
    },
    updateProject: (fn) => {
      const next = structuredClone(get().project);
      fn(next);
      commit(next);
    },
    undo: () => {
      const { past, project, future } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      save(prev);
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future], selection: null, levelId: validLevel(prev) });
    },
    redo: () => {
      const { past, project, future } = get();
      if (!future.length) return;
      const next = future[0];
      save(next);
      set({ project: next, past: [...past, project], future: future.slice(1), selection: null, levelId: validLevel(next) });
    },
    loadProject: (p) => commit(p),
    resetDemo: () => commit(demoProject()),
    resetEmpty: () => commit(emptyProject()),
  };
});

/** Bâtiment affiché selon l'étape : l'existant à l'étape 1, le projet ensuite. */
let cache: { project: Project | null; building: Building | null } = { project: null, building: null };
export function useBuilding(mode?: 'existant' | 'projet'): Building {
  const project = useStore((s) => s.project);
  const step = useStore((s) => s.step);
  const m = mode ?? (step === 'existant' ? 'existant' : 'projet');
  if (m === 'existant') return project.existing;
  if (cache.project !== project) cache = { project, building: applyOperations(project.existing, project.operations) };
  return cache.building!;
}

/** Bâtiment projeté (avec les opérations), mis en cache. */
export function projectedBuilding(project: Project): Building {
  if (cache.project !== project) cache = { project, building: applyOperations(project.existing, project.operations) };
  return cache.building!;
}
