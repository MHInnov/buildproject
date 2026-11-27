import { create } from 'zustand';
import { newId } from './model/geometry';

/**
 * Images du projet (plans importés, photos des points de vue).
 * Elles sont gardées à part, dans IndexedDB : le projet ne contient que leur identifiant,
 * ce qui garde l'historique d'annulation et la sauvegarde rapides.
 */
interface AssetState {
  assets: Record<string, string>;
  ready: boolean;
}

export const useAssets = create<AssetState>(() => ({ assets: {}, ready: false }));

const DB = 'construprojet';
const STORE = 'assets';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadAssets(): Promise<void> {
  try {
    const db = await open();
    const all: Record<string, string> = {};
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        all[String(c.key)] = c.value as string;
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    useAssets.setState({ assets: all, ready: true });
  } catch {
    useAssets.setState({ ready: true });
  }
}

export async function putAsset(dataUrl: string, id = newId('img')): Promise<string> {
  useAssets.setState((s) => ({ assets: { ...s.assets, [id]: dataUrl } }));
  try {
    await tx('readwrite', (s) => s.put(dataUrl, id));
  } catch {
    /* stockage indisponible : l'image reste en mémoire pour la session */
  }
  return id;
}

export async function deleteAsset(id: string): Promise<void> {
  useAssets.setState((s) => {
    const next = { ...s.assets };
    delete next[id];
    return { assets: next };
  });
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

export const useAsset = (id: string | null | undefined) => useAssets((s) => (id ? s.assets[id] : undefined));

/** Réduit une image (fichier ou canvas) et la renvoie en JPEG compressé. */
export async function shrinkImage(src: Blob | HTMLCanvasElement, maxSide = 1600, quality = 0.82): Promise<{ dataUrl: string; width: number; height: number }> {
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  if (src instanceof HTMLCanvasElement) {
    source = src;
    w = src.width;
    h = src.height;
  } else {
    const bmp = await createImageBitmap(src);
    source = bmp;
    w = bmp.width;
    h = bmp.height;
  }
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height };
}
