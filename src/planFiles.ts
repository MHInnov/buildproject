/** Lecture des fichiers de plans dans le navigateur : pages de PDF, images, et passage en bitmap pour l'analyse. */
import type { Bitmap } from './model/vectorize';

export interface PlanPage {
  canvas: HTMLCanvasElement;
  /** Textes de la page (cartouche, légendes), vides pour une image. */
  text: string;
  /** Pixels du canvas par point PDF (1/72 pouce), pour retrouver l'échelle du dessin. */
  pxPerPt: number | null;
  label: string;
}

async function pdfjs() {
  const lib = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

/** Rend les pages d'un PDF (pdf.js n'est chargé qu'à ce moment-là), au plus `maxPages`. */
export async function pdfPages(file: File, maxSide = 2400, maxPages = 12): Promise<PlanPage[]> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: PlanPage[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const s = maxSide / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
    } catch {
      /* pas de texte */
    }
    out.push({ canvas, text, pxPerPt: s, label: doc.numPages > 1 ? `${file.name} · page ${n}` : file.name });
  }
  return out;
}

/** Première page d'un PDF. */
export async function pdfToCanvas(file: File): Promise<HTMLCanvasElement> {
  return (await pdfPages(file, 2400, 1))[0].canvas;
}

export const isPdf = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

/** Image réduite à `maxSide` pour l'analyse ; `k` = pixels analysés par pixel de l'image. */
export async function decode(dataUrl: string, maxSide: number): Promise<{ bmp: Bitmap; k: number }> {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { bmp: { width: d.width, height: d.height, data: d.data }, k };
}

export function maskToDataUrl(mask: Uint8Array, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = 31;
    img.data[i * 4 + 1] = 111;
    img.data[i * 4 + 2] = 235;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Laisse le navigateur afficher un message avant un calcul qui l'occupe une à deux secondes. */
export const nextFrame = () => new Promise((r) => setTimeout(r, 30));
