import { create } from 'zustand';

/** Réglages d'administration, gardés dans ce navigateur uniquement. */
export interface AdminSettings {
  /** Active les fonctions d'IA (analyse de plans et de photos). Sans IA, tout reste disponible en mode assisté. */
  aiEnabled: boolean;
  /** Clé API Anthropic (Claude). Stockée localement, envoyée uniquement à api.anthropic.com. */
  apiKey: string;
  /**
   * Adresse de l'API (compatible avec celle d'Anthropic). Vide : api.anthropic.com. Un serveur de l'entreprise
   * qui garde la clé peut servir de relais : la clé devient alors facultative ici.
   */
  apiUrl: string;
  model: string;
}

export const AI_MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus précis)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (équilibré)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le moins cher)' },
];

const KEY = 'construprojet:admin';

function load(): AdminSettings {
  const d: AdminSettings = { aiEnabled: false, apiKey: '', apiUrl: '', model: 'claude-opus-5-5' };
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
    const { aiEnabled, apiKey, apiUrl, model } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ aiEnabled, apiKey, apiUrl, model }));
    } catch {
      /* ignore */
    }
  },
}));

/** Adresse de l'API valide (http ou https). */
export const validApiUrl = (url: string) => /^https?:\/\/[^\s/]+/i.test(url.trim());

/** L'API est configurée : une clé, ou l'adresse d'un relais qui garde la clé. */
export const apiConfigured = (s: AdminSettings = useSettings.getState()) => s.apiKey.trim().length > 20 || validApiUrl(s.apiUrl);

/** L'IA est utilisable : activée et API configurée. */
export const aiReady = (s: AdminSettings = useSettings.getState()) => s.aiEnabled && apiConfigured(s);
