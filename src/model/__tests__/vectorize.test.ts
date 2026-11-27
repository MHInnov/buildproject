import { describe, expect, it } from 'vitest';
import { detectRooms, insertWall } from '../geometry';
import { defaultLevel } from '../levels';
import type { Building } from '../types';
import { autoVectorize, vectorize, type Bitmap } from '../vectorize';

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

/** Même plan, avec d'autres façons de dessiner les murs. */
function styled(style: 'contour' | 'hachures' | 'gris' | 'couleur'): Bitmap {
  const ppm = 50;
  const W = 12 * ppm;
  const H = 10 * ppm;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x: number, y: number, rgb: [number, number, number]) => {
    const i = (y * W + x) * 4;
    [data[i], data[i + 1], data[i + 2]] = rgb;
  };
  const fill = style === 'gris' ? [150, 150, 150] : style === 'couleur' ? [220, 120, 110] : null;
  const wall = (x0: number, y0: number, x1: number, y1: number) => {
    const [X0, Y0, X1, Y1] = [x0, y0, x1, y1].map((v) => Math.round(v * ppm));
    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++) {
        const edge = x < X0 + 2 || x >= X1 - 2 || y < Y0 + 2 || y >= Y1 - 2;
        if (fill) px(x, y, fill as [number, number, number]);
        else if (edge || (style === 'hachures' && (x + y) % 6 === 0)) px(x, y, [0, 0, 0]);
      }
  };
  const erase = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.round(y0 * ppm); y < Math.round(y1 * ppm); y++) for (let x = Math.round(x0 * ppm); x < Math.round(x1 * ppm); x++) px(x, y, [255, 255, 255]);
  };
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.round(y0 * ppm); y <= Math.round(y1 * ppm); y++) for (let x = Math.round(x0 * ppm); x <= Math.round(x1 * ppm); x++) px(x, y, [0, 0, 0]);
  };
  // Murs extérieurs de 30 cm
  wall(0.85, 0.85, 11.15, 1.15);
  wall(0.85, 8.85, 11.15, 9.15);
  wall(0.85, 0.85, 1.15, 9.15);
  wall(10.85, 0.85, 11.15, 9.15);
  // Cloison de 16 cm en x = 6 avec une porte de 0,9 m (tableaux fermés)
  wall(5.92, 1.15, 6.08, 8.85);
  erase(5.9, 3, 6.1, 3.9);
  if (!fill) {
    line(5.92, 2.98, 6.08, 3);
    line(5.92, 3.9, 6.08, 3.92);
  }
  // Textes et mobilier en traits fins
  line(2, 5, 4, 5);
  line(2.5, 6, 2.5, 6.5);
  line(7, 4, 9, 4);
  line(7, 6, 9, 6);
  line(7, 4, 7, 6);
  line(9, 4, 9, 6);
  return { width: W, height: H, data };
}

describe('retraçage sans réglage', () => {
  it('reconnaît seul les murs pleins, l’échelle et les ouvertures', () => {
    const r = autoVectorize(plan())!;
    expect(r.style).not.toBe('contour');
    expect(r.scale).toBeGreaterThan(0.016);
    expect(r.scale).toBeLessThan(0.024);
    expect(r.rooms).toBe(2);
    expect(r.openings.map((o) => o.kind).sort()).toEqual(['fenetre', 'porte']);
  });

  for (const style of ['contour', 'hachures', 'gris', 'couleur'] as const) {
    it(`reconnaît des murs dessinés ${style === 'contour' ? 'en double trait' : style === 'hachures' ? 'hachurés' : style === 'gris' ? 'en gris' : 'en couleur'}`, () => {
      const r = autoVectorize(styled(style))!;
      expect(r).not.toBeNull();
      expect(r.rooms).toBe(2);
      expect(r.walls.filter((w) => w.thickness >= 0.2)).toHaveLength(4);
      expect(r.openings.some((o) => o.kind === 'porte')).toBe(true);
    });
  }
});
