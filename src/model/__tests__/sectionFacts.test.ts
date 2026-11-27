import { describe, expect, it } from 'vitest';
import { readSection, storeysFromSection } from '../plans';
import { applySectionFacts, facadeOpenings } from '../sectionFacts';
import { insertWall } from '../geometry';
import type { Building, Wall } from '../types';
import type { Bitmap } from '../vectorize';

const PPM = 60;

/** Coupe de 10 m de large, deux niveaux, une fenêtre coupée dans chaque façade. */
function coupe(): Bitmap {
  const margin = 1.5;
  const H = 11;
  const W = Math.round((10.3 + 2 * margin) * PPM);
  const Hp = Math.round((H + 2 * margin) * PPM);
  const data = new Uint8ClampedArray(W * Hp * 4).fill(255);
  const Y = (z: number) => H - z;
  const cut = (x0: number, z0: number, x1: number, z1: number) => {
    for (let y = Math.round((Y(z1) + margin) * PPM); y < Math.round((Y(z0) + margin) * PPM); y++)
      for (let x = Math.round((x0 + 0.15 + margin) * PPM); x < Math.round((x1 + 0.15 + margin) * PPM); x++) {
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  };
  cut(-0.15, -0.3, 10.15, 0);
  cut(-0.15, 2.55, 10.15, 2.8);
  cut(-0.15, 5.18, 10.15, 5.4);
  // Rez : fenêtre à gauche (allège 0,9 m, linteau 2,15 m), mur plein à droite
  cut(-0.15, 0, 0.15, 0.9);
  cut(-0.15, 2.15, 0.15, 2.55);
  cut(9.85, 0, 10.15, 2.55);
  // Étage : mur plein à gauche, fenêtre à droite (allège 1 m, linteau 2,1 m)
  cut(-0.15, 2.8, 0.15, 5.18);
  cut(9.85, 2.8, 10.15, 3.8);
  cut(9.85, 4.9, 10.15, 5.18);
  return { width: W, height: Hp, data };
}

function box(): Building {
  const b: Building = {
    levels: [
      { id: 'r', name: 'Rez-de-chaussée', elevation: 0, height: 2.55, slab: 0.25 },
      { id: 'e', name: '1er étage', elevation: 2.8, height: 2.38, slab: 0.22 },
    ],
    walls: [],
    openings: [],
    rooms: [],
    furniture: [],
    roof: null,
  };
  const wall = (id: string, levelId: string, a: [number, number], c: [number, number], t = 0.3): Wall => ({
    id,
    levelId,
    a: { x: a[0], y: a[1] },
    b: { x: c[0], y: c[1] },
    thickness: t,
    height: 2.5,
    kind: t >= 0.2 ? 'porteur' : 'cloison',
    finish: { gauche: null, droite: null },
  });
  for (const l of ['r', 'e']) {
    insertWall(b, wall(`${l}1`, l, [0, 0], [10, 0]));
    insertWall(b, wall(`${l}2`, l, [10, 0], [10, 8]));
    insertWall(b, wall(`${l}3`, l, [10, 8], [0, 8]));
    insertWall(b, wall(`${l}4`, l, [0, 8], [0, 0]));
    insertWall(b, wall(`${l}5`, l, [5, 0], [5, 8], 0.1));
  }
  const find = (l: string, x: number, y: number) => b.walls.find((w) => w.levelId === l && Math.min(w.a.x, w.b.x) <= x && Math.max(w.a.x, w.b.x) >= x && Math.min(w.a.y, w.b.y) <= y && Math.max(w.a.y, w.b.y) >= y)!;
  const add = (id: string, l: string, x: number, y: number, kind: 'porte' | 'fenetre') => {
    const w = find(l, x, y);
    b.openings.push({ id, wallId: w.id, kind, offset: Math.hypot(x - w.a.x, y - w.a.y), width: 0.9, height: kind === 'porte' ? 2.05 : 1.25, sill: kind === 'porte' ? 0 : 0.9, productId: 'x' });
  };
  add('f1', 'r', 2, 0, 'fenetre');
  add('d1', 'r', 7, 8, 'porte');
  add('d2', 'r', 5, 4, 'porte'); // porte intérieure
  add('f2', 'e', 10, 3, 'fenetre');
  return b;
}

describe('façades lues sur les coupes', () => {
  it('lit allège et linteau des baies coupées dans les façades', () => {
    const sec = readSection(coupe())!;
    const { scale, storeys } = storeysFromSection(sec, [10.3, 8.3]);
    expect(storeys).toHaveLength(2);
    const f = (sec.facades ?? []).map((x) => ({ side: x.side, storey: x.storey, sill: x.sill * scale, head: x.head * scale }));
    const rdc = f.find((x) => x.storey === 0)!;
    const et = f.find((x) => x.storey === 1)!;
    expect(rdc.side).toBe('L');
    expect(rdc.sill).toBeCloseTo(0.9, 1);
    expect(rdc.head).toBeCloseTo(2.15, 1);
    expect(et.side).toBe('R');
    expect(et.sill).toBeCloseTo(1.0, 1);
    expect(et.head).toBeCloseTo(2.1, 1);
    expect(f).toHaveLength(2);
  });

  it('applique les hauteurs aux baies des façades seulement', () => {
    const b = box();
    expect(facadeOpenings(b, 'r').map((o) => o.id).sort()).toEqual(['d1', 'f1']);
    const notes = applySectionFacts(b, {
      openings: [
        { storey: 0, kind: 'fenetre', sill: 0.95, head: 2.15 },
        { storey: 1, kind: 'fenetre', sill: 1.1, head: 2.2 },
      ],
      plinth: 0.6,
    });
    const o = (id: string) => b.openings.find((x) => x.id === id)!;
    expect(o('f1').sill).toBe(0.95);
    expect(o('f1').height).toBe(1.2);
    expect(o('d1').height).toBe(2.15); // porte de façade alignée sur le linteau des fenêtres
    expect(o('d2').height).toBe(2.05); // porte intérieure inchangée
    expect(o('f2').sill).toBe(1.1);
    expect(b.plinth).toBe(0.6);
    expect(notes.length).toBe(3);
  });
});
