import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { roomNamesFromWords, type OcrWord, type RoomText } from './model/roomText';

/**
 * OCR local (Tesseract en WebAssembly, servi par l'application depuis /ocr/) : noms des pièces lus sur un plan,
 * sans IA ni service extérieur. Le texte d'un plan est souvent écrit de travers (plan en paysage sur une page
 * en portrait) : la page est lue droite et tournée d'un quart de tour dans les deux sens, par tuiles agrandies.
 */
const BASE = `${import.meta.env.BASE_URL}ocr/`;
let pool: Promise<Worker[]> | null = null;

function workers(): Promise<Worker[]> {
  if (!pool) {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    pool = Promise.all(
      Array.from({ length: n }, async () => {
        const w = await createWorker('fra', OEM.LSTM_ONLY, { workerPath: `${BASE}worker.min.js`, corePath: BASE, langPath: BASE, workerBlobURL: false });
        await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        return w;
      }),
    ).catch((e) => {
      pool = null;
      throw e;
    });
  }
  return pool;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image illisible'));
    img.src = src;
  });
}

/** Une tuile de la page tournée, et de quoi ramener ses coordonnées sur la page d'origine. */
interface Tile {
  canvas: HTMLCanvasElement;
  back: (x: number, y: number) => [number, number];
}

function tiles(src: HTMLImageElement, width: number, height: number): Tile[] {
  // Le scan est d'abord ramené à 1 600 pixels de côté puis agrandi : le lissage efface le grain du papier
  // et les bavures du lettrage, que Tesseract lit mieux ainsi.
  const k = Math.min(1, 1600 / Math.max(width, height));
  const img = document.createElement('canvas');
  img.width = Math.round(width * k);
  img.height = Math.round(height * k);
  const ig = img.getContext('2d')!;
  ig.imageSmoothingQuality = 'high';
  ig.drawImage(src, 0, 0, img.width, img.height);
  // Agrandissement : le lettrage doit faire une trentaine de pixels de haut
  const s = Math.min(3, Math.max(1, 4800 / Math.max(width, height)));
  const W = Math.round(width * s);
  const H = Math.round(height * s);
  const out: Tile[] = [];
  for (const rot of [0, 90, 270] as const) {
    const rw = rot === 0 ? W : H;
    const rh = rot === 0 ? H : W;
    const T = 1200;
    const O = 250;
    for (let ty = 0; ty < rh; ty += T - O)
      for (let tx = 0; tx < rw; tx += T - O) {
        const tw = Math.min(T, rw - tx);
        const th = Math.min(T, rh - ty);
        if (tw < 100 || th < 100) continue;
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        const g = c.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, tw, th);
        g.translate(-tx, -ty);
        // Repère de la page tournée : 90 = sens inverse des aiguilles d'une montre, 270 = sens des aiguilles
        if (rot === 90) {
          g.translate(0, W);
          g.rotate(-Math.PI / 2);
        } else if (rot === 270) {
          g.translate(H, 0);
          g.rotate(Math.PI / 2);
        }
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, W, H);
        // (x, y) de la tuile → page tournée → page agrandie → page d'origine
        const back = (x: number, y: number): [number, number] => {
          const X = x + tx;
          const Y = y + ty;
          const [px, py] = rot === 0 ? [X, Y] : rot === 90 ? [W - Y, X] : [Y, H - X];
          return [px / s, py / s];
        };
        out.push({ canvas: c, back });
      }
  }
  return out;
}

/**
 * Lit les noms des pièces d'un plan (image en data URL, de `width` × `height` pixels).
 * Renvoie les noms et leur position en pixels de l'image.
 */
export async function ocrRoomNames(dataUrl: string, width: number, height: number, progress?: (done: number, all: number) => void): Promise<RoomText[]> {
  const [img, ws] = await Promise.all([loadImage(dataUrl), workers()]);
  const list = tiles(img, width, height);
  const words: OcrWord[] = [];
  let line = 0;
  let next = 0;
  let done = 0;
  await Promise.all(
    ws.map(async (w) => {
      while (next < list.length) {
        const t = list[next++];
        const r = await w.recognize(t.canvas, {}, { blocks: true, text: false });
        for (const b of r.data.blocks ?? [])
          for (const p of b.paragraphs)
            for (const l of p.lines) {
              line++;
              for (const wd of l.words) {
                const [ax, ay] = t.back(wd.bbox.x0, wd.bbox.y0);
                const [bx, by] = t.back(wd.bbox.x1, wd.bbox.y1);
                words.push({ text: wd.text, conf: wd.confidence, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), line });
              }
            }
        progress?.(++done, list.length);
      }
    }),
  );
  // Deux lectures du même nom à moins de 4 % de la page l'une de l'autre n'en font qu'une
  return roomNamesFromWords(words, Math.max(width, height) * 0.04);
}
