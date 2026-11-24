import { describe, expect, it } from 'vitest';
import { detectRooms, insertWall } from '../geometry';
import { defaultLevel } from '../levels';
import type { Building } from '../types';
import { vectorize, type Bitmap } from '../vectorize';

/** Dessine un plan synthétique : 10 × 8 m à 50 px/m, murs extérieurs 30 cm, une cloison 10 cm avec porte, une fenêtre. */
function plan(): Bitmap {
  const ppm = 50;
  const W = 12 * ppm;
  const H = 10 * ppm;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const rect = (x0: number, y0: number, x1: number, y1: number, v = 0) => {
    for (let y = Math.round(y0 * ppm); y < Math.round(y1 * ppm); y++)
      for (let x = Math.round(x0 * ppm); x < Math.round(x1 * ppm); x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
  };
  // Murs extérieurs (axes en 1..11 × 1..9)
  rect(0.85, 0.85, 11.15, 1.15);
  rect(0.85, 8.85, 11.15, 9.15);
  rect(0.85, 0.85, 1.15, 9.15);
  rect(10.85, 0.85, 11.15, 9.15);
  // Fenêtre dans le mur nord : on efface 1,2 m et on dessine deux traits fins
  rect(4, 0.85, 5.2, 1.15, 255);
  rect(4, 0.95, 5.2, 0.97);
  rect(4, 1.03, 5.2, 1.05);
  // Cloison verticale en x = 6 avec une porte de 0,9 m
  rect(5.95, 1, 6.05, 9);
  rect(5.95, 3, 6.05, 3.9, 255);
  // Texte et cotes (fins) : doivent disparaître
  rect(2, 5, 4, 5.02);
  rect(2.5, 6, 2.52, 6.5);
  return { width: W, height: H, data };
}

describe('retraçage automatique', () => {
  it('retrouve les murs, la porte et la fenêtre, et ferme les pièces', () => {
    const r = vectorize(plan(), { scale: 0.02 });
    const thick = r.walls.filter((w) => w.thickness >= 0.25);
    const thin = r.walls.filter((w) => w.thickness < 0.2);
    expect(thick).toHaveLength(4);
    expect(thin).toHaveLength(1);
    expect(r.openings.map((o) => o.kind).sort()).toEqual(['fenetre', 'porte']);
    const door = r.openings.find((o) => o.kind === 'porte')!;
    expect(door.width).toBeCloseTo(0.9, 1);
    const b: Building = { levels: [defaultLevel()], walls: [], openings: [], rooms: [], furniture: [], roof: null };
    r.walls.forEach((w, i) => insertWall(b, { id: `t${i}`, levelId: 'rdc', a: w.a, b: w.b, thickness: w.thickness, height: 2.6, kind: 'cloison', finish: { gauche: null, droite: null } }));
    const areas = detectRooms(b).map((x) => Math.round(x.area)).sort((m, n) => m - n);
    expect(areas).toHaveLength(2);
    expect(areas[0] + areas[1]).toBeGreaterThan(70);
  });
});
