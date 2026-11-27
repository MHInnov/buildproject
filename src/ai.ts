import type Anthropic from '@anthropic-ai/sdk';
import type { AiOpeningVerdict, AiStripOpening } from './model/aiReview';
import type { SectionFacts } from './model/sectionFacts';
import { aiIsLocal, DEFAULT_LOCAL_URL, fetchBundledAi, useSettings } from './settings';

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
  if (aiIsLocal()) return askLocal<T>(dataUrl, prompt, schema);
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

/** Adresse du serveur Ollama, sans barre finale. */
export function localBase(): string {
  return useSettings.getState().localUrl.trim().replace(/\/+$/, '') || DEFAULT_LOCAL_URL;
}

/** Erreur réseau ou HTTP d'Ollama, traduite en une phrase utile. */
async function localError(res: Response | null, e?: unknown): Promise<Error> {
  if (!res) {
    if ((e as Error)?.name === 'TimeoutError') return new Error("l'IA locale n'a pas répondu à temps (modèle trop lourd pour cette machine ?)");
    return new Error(`IA locale injoignable à ${localBase()} : utilisez l'image avec IA (« -ia », voir le README)`);
  }
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    /* réponse non JSON (relais nginx sans Ollama derrière) */
  }
  if (res.status === 502 || res.status === 504) return new Error('le service Ollama ne répond pas derrière le relais /ia-locale (est-il démarré ?)');
  if (res.status === 404 && /not found/i.test(detail)) {
    // Image tout-en-un : le modèle se télécharge peut-être encore (premier lancement)
    const b = await fetchBundledAi();
    if (b?.status === 'telechargement' || b?.status === 'demarrage') return new Error(`le modèle ${b.model} est en cours de téléchargement (premier lancement, quelques minutes) : l'import se fait sans IA en attendant`);
    if (b?.status === 'erreur') return new Error(`le téléchargement du modèle ${b.model} a échoué (connexion internet ?) : relancez le conteneur (docker restart construprojet) pour réessayer`);
    return new Error(`le modèle ${useSettings.getState().localModel} n'est pas installé : « Télécharger le modèle » dans l'administration`);
  }
  return new Error(`IA locale : ${detail || `erreur ${res.status}`}`);
}

/**
 * Appel à un modèle de vision servi par Ollama (API /api/chat), avec réponse au format JSON imposé par le
 * schéma. Tout reste sur la machine (ou le réseau) de l'utilisateur.
 */
async function askLocal<T>(dataUrl: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const { localModel } = useSettings.getState();
  const img = splitDataUrl(dataUrl);
  let res: Response | null = null;
  try {
    res = await fetch(`${localBase()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: localModel.trim(),
        stream: false,
        format: schema,
        keep_alive: '15m',
        // Réponses reproductibles ; contexte assez grand pour une image de plan et la consigne
        options: { temperature: 0, num_ctx: 8192 },
        messages: [{ role: 'user', content: prompt + '\nRéponds uniquement en JSON.', images: [img.data] }],
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (e) {
    throw await localError(null, e);
  }
  if (!res.ok) throw await localError(res);
  const body = (await res.json()) as { message?: { content?: string } };
  const text = body.message?.content ?? '';
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("l'IA locale a rendu une réponse illisible");
  }
}

/** Modèles installés sur le serveur Ollama. */
export async function localModels(): Promise<string[]> {
  let res: Response | null = null;
  try {
    res = await fetch(`${localBase()}/api/tags`, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw await localError(null, e);
  }
  if (!res.ok) throw await localError(res);
  const body = (await res.json()) as { models?: { name: string }[] };
  return (body.models ?? []).map((m) => m.name);
}

/** Télécharge un modèle sur le serveur Ollama, avec la progression (0 à 1). */
export async function localPull(model: string, onProgress: (status: string, part: number | null) => void): Promise<void> {
  let res: Response | null = null;
  try {
    res = await fetch(`${localBase()}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  } catch (e) {
    throw await localError(null, e);
  }
  if (!res.ok || !res.body) throw await localError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = JSON.parse(l) as { status?: string; total?: number; completed?: number; error?: string };
      if (m.error) throw new Error(`IA locale : ${m.error}`);
      onProgress(m.status ?? '', m.total ? (m.completed ?? 0) / m.total : null);
    }
  }
}

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || `${a}:latest` === b;

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
  const res = await askJson<{
    openings: SectionFacts['openings'];
    storeys: { storey: number; ceiling_height_m: number; floor_thickness_m: number | null }[];
    ground_to_floor_m: number | null;
    roof_pitch_deg: number | null;
    roof_overhang_m: number | null;
  }>(
    dataUrl,
    "Voici une coupe verticale d'une maison (elle peut être tournée d'un quart de tour). " +
      "Pour chaque porte ou fenêtre coupée dans un mur de façade (mur extérieur, à gauche ou à droite de la coupe), donne le niveau qu'elle traverse " +
      "(0 = rez-de-chaussée, 1 = étage, -1 = cave), le bas de la baie (allège, 0 pour une porte) et le haut de la baie (sous le linteau), en mètres au-dessus du sol fini du niveau. " +
      "Pour chaque niveau coupé, donne sa hauteur sous plafond (du sol fini au plafond) et l'épaisseur du plancher au-dessus, en mètres. " +
      "Donne aussi la hauteur du sol fini du rez-de-chaussée au-dessus du terrain naturel, la pente du toit en degrés et le débord du toit en mètres. " +
      "Lis d'abord les cotes écrites sur le dessin (en cm, ou les niveaux comme 49.00 et 48.20) ; à défaut, mesure à l'échelle. Mets null pour ce que la coupe ne montre pas, n'invente rien.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['openings', 'storeys', 'ground_to_floor_m', 'roof_pitch_deg', 'roof_overhang_m'],
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
        storeys: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['storey', 'ceiling_height_m', 'floor_thickness_m'],
            properties: { storey: { type: 'integer' }, ceiling_height_m: { type: 'number' }, floor_thickness_m: num },
          },
        },
        ground_to_floor_m: num,
        roof_pitch_deg: num,
        roof_overhang_m: num,
      },
    },
  );
  return {
    openings: res.openings ?? [],
    storeys: (res.storeys ?? []).map((x) => ({ storey: x.storey, height: x.ceiling_height_m, slab: x.floor_thickness_m })),
    plinth: res.ground_to_floor_m,
    roof: { pitch: res.roof_pitch_deg, overhang: res.roof_overhang_m },
  };
}

const OPENING_KINDS = ['porte', 'porte-fenetre', 'fenetre', 'porte-garage'];

/**
 * Relecture d'une ouverture trouvée par le retraçage, sur une vue rapprochée où le mur est horizontal.
 * Les consignes décrivent les conventions des plans d'architecte, que les petits modèles connaissent mal.
 */
export async function aiReviewOpening(dataUrl: string, ctx: { width: number; wallThickness: number; current: string }): Promise<AiOpeningVerdict> {
  return askJson<AiOpeningVerdict>(
    dataUrl,
    "Vue rapprochée d'un plan de maison (dessin d'architecte, parfois à la main). Le mur traverse l'image à l'horizontale, en son milieu " +
      `(épaisseur ${Math.round(ctx.wallThickness * 100)} cm). Au centre, le retraçage automatique a cru voir une ${ctx.current} de ${Math.round(ctx.width * 100)} cm. ` +
      'Dis ce qui se trouve réellement au centre, dans le mur :\n' +
      "- porte : le mur est interrompu et un arc de cercle (quart de cercle) part d'un des bords de l'ouverture, avec un trait droit pour le battant ;\n" +
      "- porte-fenetre : comme une fenêtre mais descendant jusqu'au sol, souvent avec deux petits arcs ou un seuil ;\n" +
      "- fenetre : le mur continue en traits fins parallèles (un, deux ou trois traits de vitrage) sans arc ;\n" +
      '- porte-garage : grande ouverture (2 m ou plus) sans arc, parfois un trait en pointillé ;\n' +
      "- rien : le mur est plein, ou ce n'est qu'un pointillé (poutre, faux plafond, rampant), une cote, un texte ou un meuble.\n" +
      "Pour une porte, dis de quel côté de l'image est la charnière (le bord d'où part le trait du battant, centre de l'arc) et si l'arc s'ouvre vers le haut ou le bas de l'image ; " +
      'leaves = 2 si deux arcs se rejoignent au milieu. Mets inconnu si ce n\'est pas lisible, et sure = false au moindre doute.',
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'hinge', 'opens', 'leaves', 'sure'],
      properties: {
        kind: { type: 'string', enum: [...OPENING_KINDS, 'rien'] },
        hinge: { type: 'string', enum: ['gauche', 'droite', 'inconnu'] },
        opens: { type: 'string', enum: ['haut', 'bas', 'inconnu'] },
        leaves: { type: 'integer', minimum: 1, maximum: 2 },
        sure: { type: 'boolean' },
      },
    },
  );
}

/** Baies d'un tronçon de façade (mur horizontal sur la vue), bords en pixels de la vue. */
export async function aiReadStrip(dataUrl: string, ctx: { width: number; height: number; lengthM: number }): Promise<AiStripOpening[]> {
  const res = await askJson<{ openings: AiStripOpening[] }>(
    dataUrl,
    `Morceau d'un plan de maison (${ctx.width} × ${ctx.height} pixels) : un mur de façade traverse l'image à l'horizontale, sur ${ctx.lengthM.toFixed(1).replace('.', ',')} m. ` +
      "Liste chaque baie percée dans ce mur : porte (mur interrompu, arc de cercle de débattement), porte-fenetre (vitrage jusqu'au sol), " +
      'fenetre (traits fins de vitrage dans l\'épaisseur du mur, sans arc) ou porte-garage (grande baie sans arc). ' +
      "Pour chacune, donne le bord gauche et le bord droit de la baie dans le mur, en pixels depuis le bord gauche de l'image. " +
      "Ignore les pointillés, les cotes, les textes, les meubles et ce qui n'est pas dans ce mur. Liste vide si le mur est plein. N'invente rien.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['openings'],
      properties: {
        openings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'x_start', 'x_end'],
            properties: { kind: { type: 'string', enum: OPENING_KINDS }, x_start: { type: 'number' }, x_end: { type: 'number' } },
          },
        },
      },
    },
  );
  return res.openings ?? [];
}

/** Nom d'une pièce, d'après le texte écrit dedans ou à défaut ses équipements. */
export async function aiNameRoom(dataUrl: string, areaM2: number): Promise<{ name: string; sure: boolean }> {
  return askJson<{ name: string; sure: boolean }>(
    dataUrl,
    `Une pièce d'un plan de maison (${Math.round(areaM2)} m²), au centre de l'image. Quel est son nom ? Lis d'abord le texte écrit dans la pièce ` +
      '(ex. « SEJOUR », « CH. 2 », « SdB », « Hall »), à défaut déduis-le des équipements dessinés (baignoire, WC, évier, lit). ' +
      'Réponds par un nom court en français avec une majuscule (Séjour, Cuisine, Chambre 2, Salle de bain, WC, Hall, Bureau, Garage, Grenier…). ' +
      "Chaîne vide et sure = false si rien ne permet de le dire.",
    {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sure'],
      properties: { name: { type: 'string', maxLength: 40 }, sure: { type: 'boolean' } },
    },
  );
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

/** Vérifie la clé et l'accès au modèle choisi (appel gratuit). Pour l'IA locale : serveur joignable et modèle installé. */
export async function aiCheck(): Promise<string> {
  if (aiIsLocal()) {
    const want = useSettings.getState().localModel.trim();
    const have = await localModels();
    if (!have.some((m) => sameModel(m, want))) throw new Error(`serveur joignable, mais le modèle ${want} n'est pas installé (${have.length ? `présents : ${have.join(', ')}` : 'aucun modèle'})`);
    return `${want} (IA locale)`;
  }
  const c = await client();
  const m = await c.models.retrieve(useSettings.getState().model);
  return m.display_name;
}
