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
  /**
   * Où tourne l'IA : « claude » (API d'Anthropic, payante, les images sont envoyées) ou « locale » (modèle de
   * vision open source servi par Ollama sur la machine ou le réseau de l'utilisateur, rien ne sort).
   */
  aiProvider: AiProvider;
  /** Adresse du serveur Ollama. Par défaut le relais /ia-locale de l'application (docker compose --profile ia). */
  localUrl: string;
  /** Modèle de vision Ollama (ex. qwen2.5vl:7b). */
  localModel: string;
}

export type AiProvider = 'claude' | 'locale';

/** Modèles de vision open source conseillés (Ollama), du plus léger au plus lourd. */
export const LOCAL_MODELS: { id: string; label: string; vram: string }[] = [
  { id: 'qwen2.5vl:3b', label: 'Qwen2.5-VL 3B (léger)', vram: '≈ 3 Go à télécharger, 6 Go de mémoire graphique' },
  { id: 'qwen2.5vl:7b', label: 'Qwen2.5-VL 7B (conseillé)', vram: '≈ 6 Go à télécharger, 8 Go de mémoire graphique' },
  { id: 'qwen3-vl:8b', label: 'Qwen3-VL 8B', vram: '≈ 6 Go à télécharger, 8 à 10 Go de mémoire graphique' },
  { id: 'llama3.2-vision:11b', label: 'Llama 3.2 Vision 11B', vram: '≈ 8 Go à télécharger, 12 Go de mémoire graphique' },
  { id: 'qwen2.5vl:32b', label: 'Qwen2.5-VL 32B (le plus précis)', vram: '≈ 21 Go à télécharger, 24 Go de mémoire graphique' },
];

/** Relais vers Ollama servi par l'application elle-même (nginx en production, Vite en développement). */
export const DEFAULT_LOCAL_URL = '/ia-locale';

export const AI_MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (le plus précis)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (équilibré)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le moins cher)' },
];

const KEY = 'construprojet:admin';

function load(): AdminSettings {
  const d: AdminSettings = { aiEnabled: false, apiKey: '', apiUrl: '', model: 'claude-opus-5-5', aiProvider: 'claude', localUrl: DEFAULT_LOCAL_URL, localModel: 'qwen2.5vl:7b' };
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
    const { aiEnabled, apiKey, apiUrl, model, aiProvider, localUrl, localModel } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ aiEnabled, apiKey, apiUrl, model, aiProvider, localUrl, localModel }));
    } catch {
      /* ignore */
    }
  },
}));

/** Adresse de l'API valide (http ou https). */
export const validApiUrl = (url: string) => /^https?:\/\/[^\s/]+/i.test(url.trim());

/** Adresse d'Ollama valide : le relais de l'application (/…) ou une adresse http(s). */
export const validLocalUrl = (url: string) => /^\/[\w-]/.test(url.trim()) || validApiUrl(url);

/**
 * L'IA est configurée : pour Claude, une clé ou l'adresse d'un relais qui garde la clé ; pour l'IA locale,
 * une adresse et un modèle (sa présence se vérifie avec « Tester »).
 */
export const apiConfigured = (s: AdminSettings = useSettings.getState()) =>
  s.aiProvider === 'locale' ? validLocalUrl(s.localUrl) && s.localModel.trim() !== '' : s.apiKey.trim().length > 20 || validApiUrl(s.apiUrl);

/** L'IA tourne sur la machine de l'utilisateur (rien n'est envoyé dehors). */
export const aiIsLocal = (s: AdminSettings = useSettings.getState()) => s.aiProvider === 'locale';

/** L'IA est utilisable : activée et API configurée. */
export const aiReady = (s: AdminSettings = useSettings.getState()) => s.aiEnabled && apiConfigured(s);
