import { create } from 'zustand';

/** Réglages d'administration, gardés dans ce navigateur uniquement. */
export interface AdminSettings {
  /** Active les fonctions d'IA (analyse de plans et de photos). Sans IA, tout reste disponible en mode assisté. */
  aiEnabled: boolean;
  /** Clé API Anthropic (Claude). Stockée localement, envoyée uniquement à api.anthropic.com. */
  apiKey: string;
  model: string;
}

export const AI_MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus précis)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (équilibré)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le moins cher)' },
];

const KEY = 'construprojet:admin';

function load(): AdminSettings {
  const d: AdminSettings = { aiEnabled: false, apiKey: '', model: 'claude-opus-5-5' };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AdminSettings>) };
  } catch {
    return d;
  }
}

export const useSettings = create<AdminSettings & { update: (p: Partial<AdminSettings>) => void }>((set, get) => ({
  ...load(),
  update: (p) => {
    set(p);
    const { aiEnabled, apiKey, model } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ aiEnabled, apiKey, model }));
    } catch {
      /* ignore */
    }
  },
}));

/** L'IA est utilisable : activée et clé renseignée. */
export const aiReady = (s: AdminSettings = useSettings.getState()) => s.aiEnabled && s.apiKey.trim().length > 20;
