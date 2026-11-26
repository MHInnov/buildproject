import type Anthropic from '@anthropic-ai/sdk';
import type { SectionFacts } from './model/sectionFacts';
import { useSettings } from './settings';

/**
 * Fonctions d'IA optionnelles (activées dans le panneau d'administration).
 * Le SDK n'est chargé qu'au premier appel : sans IA, l'application ne le télécharge jamais.
 */
async function client(): Promise<Anthropic> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // Application sans serveur : la clé est celle de l'utilisateur, saisie dans l'administration.
  // Une adresse d'API peut être donnée dans les paramètres (relais de l'entreprise qui garde la clé).
  const { apiKey, apiUrl } = useSettings.getState();
  const baseURL = apiUrl.trim().replace(/\/+$/, '') || undefined;
  return new Anthropic({ apiKey: apiKey.trim() || 'cle-gardee-par-le-relais', baseURL, dangerouslyAllowBrowser: true });
}

function splitDataUrl(dataUrl: string): { media: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('Image non prise en charge');
  return { media: m[1] as 'image/jpeg', data: m[2] };
}

async function askJson<T>(dataUrl: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const c = await client();
  const { model } = useSettings.getState();
  const img = splitDataUrl(dataUrl);
  const res = await c.messages.create({
    model,
    max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.media, data: img.data } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  if (res.stop_reason === 'refusal') throw new Error("L'IA a refusé d'analyser cette image.");
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return JSON.parse(text) as T;
}

export interface AiPlanResult {
  rooms: { name: string; x: number; y: number }[];
  openings: { kind: 'porte' | 'fenetre'; x: number; y: number; width_px: number }[];
}

/** Lit un plan : noms des pièces et position des portes et fenêtres (en pixels de l'image). */
export async function aiReadPlan(dataUrl: string, width: number, height: number): Promise<AiPlanResult> {
  return askJson<AiPlanResult>(
    dataUrl,
    `Voici un plan de maison (${width} × ${height} pixels, origine en haut à gauche). ` +
      'Liste chaque pièce avec son nom en français (Séjour, Cuisine, Chambre, Salle de bain, WC, Hall, Bureau…) et un point au centre de la pièce, en pixels. ' +
      'Liste aussi chaque porte et chaque fenêtre avec le centre de son ouverture dans le mur et sa largeur, en pixels. N\'invente rien que le plan ne montre pas.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['rooms', 'openings'],
      properties: {
        rooms: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['name', 'x', 'y'], properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
        },
        openings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'x', 'y', 'width_px'],
            properties: { kind: { type: 'string', enum: ['porte', 'fenetre'] }, x: { type: 'number' }, y: { type: 'number' }, width_px: { type: 'number' } },
          },
        },
      },
    },
  );
}

/**
 * Lit une coupe : les cotes écrites (hauteurs d'allège et de linteau des baies coupées dans les façades,
 * niveau du rez-de-chaussée au-dessus du terrain, pente et débord du toit). Les niveaux sont comptés depuis
 * le rez-de-chaussée (0).
 */
export async function aiReadSection(dataUrl: string): Promise<SectionFacts> {
  const num = { type: ['number', 'null'] };
  const res = await askJson<{ openings: SectionFacts['openings']; ground_to_floor_m: number | null; roof_pitch_deg: number | null; roof_overhang_m: number | null }>(
    dataUrl,
    "Voici une coupe verticale d'une maison (elle peut être tournée d'un quart de tour). " +
      "Pour chaque porte ou fenêtre coupée dans un mur de façade (mur extérieur, à gauche ou à droite de la coupe), donne le niveau qu'elle traverse " +
      "(0 = rez-de-chaussée, 1 = étage, -1 = cave), le bas de la baie (allège, 0 pour une porte) et le haut de la baie (sous le linteau), en mètres au-dessus du sol fini du niveau. " +
      "Donne aussi la hauteur du sol fini du rez-de-chaussée au-dessus du terrain naturel, la pente du toit en degrés et le débord du toit en mètres. " +
      "Lis d'abord les cotes écrites sur le dessin (en cm, ou les niveaux comme 49.00 et 48.20) ; à défaut, mesure à l'échelle. Mets null pour ce que la coupe ne montre pas, n'invente rien.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['openings', 'ground_to_floor_m', 'roof_pitch_deg', 'roof_overhang_m'],
      properties: {
        openings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['storey', 'kind', 'sill', 'head'],
            properties: { storey: { type: 'integer' }, kind: { type: 'string', enum: ['porte', 'fenetre'] }, sill: { type: 'number' }, head: { type: 'number' } },
          },
        },
        ground_to_floor_m: num,
        roof_pitch_deg: num,
        roof_overhang_m: num,
      },
    },
  );
  return { openings: res.openings, plinth: res.ground_to_floor_m, roof: { pitch: res.roof_pitch_deg, overhang: res.roof_overhang_m } };
}

export interface AiPhotoElement {
  kind: 'sol' | 'mur' | 'porte' | 'fenetre' | 'meuble';
  /** Position dans la photo, de 0 à 1 (0,0 = coin haut gauche). */
  x: number;
  y: number;
  /** Pour une porte ou fenêtre : largeur apparente, de 0 à 1. */
  width: number;
  description: string;
  /** Produit du catalogue le plus proche, ou chaîne vide. */
  productId: string;
  condition: 'bon' | 'moyen' | 'mauvais';
}

/** Repère sols, murs, portes, fenêtres et meubles sur une photo prise dans la maison. */
export async function aiReadPhoto(dataUrl: string, candidates: { id: string; name: string; kind: string }[]): Promise<AiPhotoElement[]> {
  const list = candidates.map((c) => `${c.id} | ${c.kind} | ${c.name}`).join('\n');
  const res = await askJson<{ elements: AiPhotoElement[] }>(
    dataUrl,
    "Cette photo a été prise à hauteur d'yeux dans une maison à rénover. Repère le sol, les murs visibles, les portes, les fenêtres et les meubles ou sanitaires. " +
      'Pour chacun, donne un point sur l\'élément (x, y de 0 à 1 depuis le coin haut gauche ; pour un meuble, le point où il touche le sol), ' +
      'la largeur apparente (0 à 1) pour les portes et fenêtres, une courte description en français, son état apparent, ' +
      'et l\'identifiant du produit le plus proche dans cette liste (chaîne vide si rien ne convient) :\n' +
      list,
    {
      type: 'object',
      additionalProperties: false,
      required: ['elements'],
      properties: {
        elements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'x', 'y', 'width', 'description', 'productId', 'condition'],
            properties: {
              kind: { type: 'string', enum: ['sol', 'mur', 'porte', 'fenetre', 'meuble'] },
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              description: { type: 'string' },
              productId: { type: 'string' },
              condition: { type: 'string', enum: ['bon', 'moyen', 'mauvais'] },
            },
          },
        },
      },
    },
  );
  return res.elements;
}

/** Vérifie la clé et l'accès au modèle choisi (appel gratuit). */
export async function aiCheck(): Promise<string> {
  const c = await client();
  const m = await c.models.retrieve(useSettings.getState().model);
  return m.display_name;
}
