import { describe, expect, it } from 'vitest';
import { alignWalls, guessKind, parseDrawingScale, pdfScale, readSection, storeysFromSection } from '../plans';
import { defaultLevel } from '../levels';
import type { Building } from '../types';
import { autoVectorize, type Bitmap } from '../vectorize';
import { analysePlan, importPlans, spreadFloors } from '../../plansImport';

const PPM = 60;

/** Page blanche de W × H mètres, avec un pinceau de rectangles en mètres décalés de la marge. */
function canvas(wm: number, hm: number, margin: number) {
  const W = Math.round(wm * PPM);
  const H = Math.round(hm * PPM);
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const rect = (x0: number, y0: number, x1: number, y1: number, v = 0) => {
    for (let y = Math.max(0, Math.round((y0 + margin) * PPM)); y < Math.min(H, Math.round((y1 + margin) * PPM)); y++)
      for (let x = Math.max(0, Math.round((x0 + margin) * PPM)); x < Math.min(W, Math.round((x1 + margin) * PPM)); x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
  };
  return { bmp: { width: W, height: H, data } as Bitmap, rect };
}

/** Plan d'un niveau de 10 × 8 m (axes), murs extérieurs 30 cm, marges différentes selon la page. */
function floor(margin: number, partitions: [number, number, number, number][], windows: [number, number, number, number][]): Bitmap {
  const { bmp, rect } = canvas(10 + 2 * margin, 8 + 2 * margin, margin);
  const wall = (ax: number, ay: number, bx: number, by: number, t: number) => rect(Math.min(ax, bx) - t / 2, Math.min(ay, by) - t / 2, Math.max(ax, bx) + t / 2, Math.max(ay, by) + t / 2);
  wall(0, 0, 10, 0, 0.3);
  wall(10, 0, 10, 8, 0.3);
  wall(0, 8, 10, 8, 0.3);
  wall(0, 0, 0, 8, 0.3);
  for (const [ax, ay, bx, by] of partitions) wall(ax, ay, bx, by, 0.1);
  for (const [x0, y0, x1, y1] of windows) {
    rect(x0, y0, x1, y1, 255);
    if (x1 - x0 > y1 - y0) rect(x0, (y0 + y1) / 2 - 0.01, x1, (y0 + y1) / 2 + 0.02);
    else rect((x0 + x1) / 2 - 0.01, y0, (x0 + x1) / 2 + 0.02, y1);
  }
  return bmp;
}

const rdc = () => floor(1, [[5, 0, 5, 8], [0, 4, 5, 4]], [[2, -0.15, 3.2, 0.15], [7, 7.85, 8.2, 8.15]]);
const etage = () => floor(2, [[4, 0, 4, 8], [4, 4, 10, 4]], [[2, -0.15, 3.2, 0.15], [6.5, 7.85, 7.7, 8.15]]);

/** Coupe : dalles en 0, 2,80 et 5,40 m (dessus), murs, toit deux pans à 35°. */
function coupe(): Bitmap {
  const margin = 1.5;
  const H = 11;
  const { bmp, rect } = canvas(10.3 + 2 * margin, H + 2 * margin, margin);
  const Y = (z: number) => H - z;
  const cut = (x0: number, z0: number, x1: number, z1: number) => rect(x0 + 0.15, Y(z1), x1 + 0.15, Y(z0));
  cut(-0.15, -0.3, 10.15, 0);
  cut(-0.15, 2.55, 10.15, 2.8);
  cut(-0.15, 5.18, 10.15, 5.4);
  cut(-0.15, 0, 0.15, 2.55);
  cut(9.85, 0, 10.15, 2.55);
  cut(-0.15, 2.8, 0.15, 5.18);
  cut(9.85, 2.8, 10.15, 5.18);
  // Toit : deux traits de 4 cm, pente 35°
  const tan = Math.tan((35 * Math.PI) / 180);
  for (let x = -0.4; x <= 10.4; x += 0.01) {
    const z = 5.4 + (5 - Math.abs(x - 5)) * tan;
    rect(x + 0.15, Y(z), x + 0.17, Y(z) + 0.05);
  }
  return bmp;
}

describe('plans de plusieurs niveaux', () => {
  it('cale le 1er étage sur le rez-de-chaussée malgré des marges différentes', () => {
    const a = autoVectorize(rdc(), { scale: 1 / PPM })!;
    const e = autoVectorize(etage(), { scale: 1 / PPM })!;
    const al = alignWalls(e.walls, a.walls);
    // L'étage a 1 m de marge en plus : il doit être décalé de -1 m
    expect(al.dx).toBeCloseTo(-1, 1);
    expect(al.dy).toBeCloseTo(-1, 1);
    expect(al.fit).toBeGreaterThan(0.5);
  });

  it('lit les planchers et le toit sur une coupe', () => {
    const sec = readSection(coupe())!;
    expect(sec.slabs).toHaveLength(3);
    expect(sec.roof?.type).toBe('deux-pans');
    expect(Math.abs(sec.roof!.pitch - 35)).toBeLessThan(4);
    const { storeys } = storeysFromSection(sec, [10.3, 8.3]);
    expect(storeys).toHaveLength(2);
    expect(storeys[0].height).toBeCloseTo(2.55, 1);
    expect(storeys[1].height).toBeCloseTo(2.38, 1);
  });

  it('reconnaît le contenu d’après le nom du fichier', () => {
    expect(guessKind('Plan RDC')).toBe('rdc');
    expect(guessKind('plan 1er étage')).toBe('etage1');
    expect(guessKind('R+2')).toBe('etage2');
    expect(guessKind('Coupe AA')).toBe('coupe');
    expect(guessKind('façade avant')).toBe('ignorer');
    expect(guessKind('sous-sol')).toBe('cave');
    expect(guessKind('maison')).toBeNull();
  });

  it('lit l’échelle du dessin dans le cartouche d’un PDF', () => {
    expect(parseDrawingScale('PLAN DU REZ-DE-CHAUSSÉE   Échelle 1/50   Format A1')).toBe(50);
    expect(parseDrawingScale('éch. 1:100 — détail 1/20 — 1:100')).toBe(100);
    expect(parseDrawingScale('Date 12/05/2024, indice 1/3')).toBeNull();
    // A1 au 1/50 rendu à 1 px par point : 1 px = 0,3528 mm sur le papier = 1,76 cm en vrai
    expect(pdfScale(1, 50)).toBeCloseTo(0.01764, 4);
  });

  it('distingue une coupe d’un plan par le dessin', () => {
    expect(analysePlan(coupe(), 'scan1.png').kind).toBe('coupe');
    expect(analysePlan(rdc(), 'scan2.png').kind).toBe('rdc');
    expect(spreadFloors([{ kind: 'rdc', hinted: false }, { kind: 'rdc', hinted: false }, { kind: 'coupe', hinted: false }])).toEqual(['rdc', 'etage1', 'coupe']);
    expect(spreadFloors([{ kind: 'rdc', hinted: false }, { kind: 'rdc', hinted: true }])).toEqual(['etage1', 'rdc']);
  });

  it('importe tout le dossier : deux niveaux superposés, hauteurs et toit', () => {
    const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], floorZones: [], roof: null };
    const item = (kind: 'rdc' | 'etage1' | 'coupe', bmp: Bitmap, name: string) => ({ kind, bmp, k: 1, assetId: name, width: bmp.width, height: bmp.height, name });
    const rep = importPlans(b, [item('etage1', etage(), 'etage.png'), item('coupe', coupe(), 'coupe.png'), item('rdc', rdc(), 'rdc.png')]);
    expect(b.levels).toHaveLength(2);
    const [g, up] = [...b.levels].sort((m, n) => m.elevation - n.elevation);
    const box = (id: string) => {
      const ws = b.walls.filter((w) => w.levelId === id);
      const xs = ws.flatMap((w) => [w.a.x, w.b.x]);
      const ys = ws.flatMap((w) => [w.a.y, w.b.y]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // Mêmes murs extérieurs aux deux niveaux, à quelques centimètres près
    const bg = box(g.id);
    const bu = box(up.id);
    for (let i = 0; i < 4; i++) expect(Math.abs(bg[i] - bu[i])).toBeLessThan(0.08);
    expect(bg[2] - bg[0]).toBeGreaterThan(9);
    expect(bg[2] - bg[0]).toBeLessThan(11);
    // Fenêtres seulement dans les murs extérieurs, à leur place
    const windows = b.openings.filter((o) => o.kind === 'fenetre');
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const o of windows) expect(b.walls.find((w) => w.id === o.wallId)!.kind).toBe('porteur');
    // Hauteurs lues sur la coupe, toit posé
    expect(g.height).toBeGreaterThan(2.3);
    expect(g.height).toBeLessThan(2.8);
    expect(up.elevation).toBeCloseTo(g.height + g.slab, 2);
    expect(b.roof?.type).toBe('deux-pans');
    expect(up.underlay?.assetId).toBe('etage.png');
    expect(rep.levelId).toBe(g.id);
    expect(rep.warnings).toEqual([]);
  });
});

describe('niveaux créés par l’import', () => {
  it('insère le 1er étage sous des combles existantes', async () => {
    const { levelFor } = await import('../../plansImport');
    const b: Building = { levels: [defaultLevel(), { id: 'c', name: 'Combles', elevation: 2.82, height: 1.2, slab: 0.2 }], walls: [], openings: [], rooms: [], furniture: [], floorZones: [], roof: null };
    const e1 = levelFor(b, 'etage1');
    expect(e1.elevation).toBeCloseTo(2.82, 2);
    expect(b.levels.find((l) => l.id === 'c')!.elevation).toBeGreaterThan(e1.elevation + 2);
    expect(levelFor(b, 'combles').id).toBe('c');
    expect(levelFor(b, 'etage1').id).toBe(e1.id);
  });
});
