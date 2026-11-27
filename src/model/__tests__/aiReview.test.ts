import { describe, expect, it } from 'vitest';
import { applyStrip, applyVerdict, facadeWalls, openingView, stripViews, verdictSwing, viewTransform } from '../aiReview';
import { insertWall } from '../geometry';
import type { Building, Opening, Wall } from '../types';

const wall = (id: string, a: [number, number], c: [number, number], t = 0.3): Wall => ({
  id,
  levelId: 'r',
  a: { x: a[0], y: a[1] },
  b: { x: c[0], y: c[1] },
  thickness: t,
  height: 2.5,
  kind: t >= 0.2 ? 'porteur' : 'cloison',
  finish: { gauche: null, droite: null },
});

/** Maison de 10 × 8 m, une cloison au milieu, une porte dans la façade nord et une dans la cloison. */
function house(): Building {
  const b: Building = { levels: [{ id: 'r', name: 'Rez-de-chaussée', elevation: 0, height: 2.5, slab: 0.25 }], walls: [], openings: [], rooms: [], furniture: [], roof: null };
  insertWall(b, wall('n', [0, 0], [10, 0]));
  insertWall(b, wall('e', [10, 0], [10, 8]));
  insertWall(b, wall('s', [10, 8], [0, 8]));
  insertWall(b, wall('o', [0, 8], [0, 0]));
  insertWall(b, wall('c', [5, 0], [5, 8], 0.1));
  const on = (x: number, y: number) => b.walls.find((w) => Math.min(w.a.x, w.b.x) <= x && Math.max(w.a.x, w.b.x) >= x && Math.min(w.a.y, w.b.y) <= y && Math.max(w.a.y, w.b.y) >= y)!;
  const nw = on(2, 0);
  const cw = on(5, 4);
  const o = (id: string, w: Wall, offset: number): Opening => ({ id, wallId: w.id, kind: 'porte', offset, width: 0.9, height: 2.05, sill: 0, productId: 'ex-porte-isoplane' });
  b.openings.push(o('p-nord', nw, 2), o('p-cloison', cw, 2));
  return b;
}

describe("relecture par l'IA", () => {
  it('ne relit que les façades pour chercher les baies oubliées', () => {
    const b = house();
    const f = facadeWalls(b, 'r');
    expect(f.length).toBeGreaterThanOrEqual(4);
    expect(f.every((w) => w.thickness >= 0.2)).toBe(true);
  });

  it('cadre la vue sur la baie, mur horizontal de a vers b', () => {
    const b = house();
    const o = b.openings[0];
    const w = b.walls.find((x) => x.id === o.wallId)!;
    const v = openingView(w, o);
    const ul = { x: -1, y: -1, scale: 0.01 };
    const [a, bb, c, d, e, f] = viewTransform(v, ul);
    const px = (wx: number, wy: number) => {
      const ix = (wx - ul.x) / ul.scale;
      const iy = (wy - ul.y) / ul.scale;
      return { x: a * ix + c * iy + e, y: bb * ix + d * iy + f };
    };
    const ctr = px(v.center.x, v.center.y);
    expect(ctr.x).toBeCloseTo(v.width / 2, 3);
    expect(ctr.y).toBeCloseTo(v.height / 2, 3);
    // Un pas vers b va à droite ; la face gauche du mur est en bas de la vue
    const right = px(v.center.x + v.u.x * 0.5, v.center.y + v.u.y * 0.5);
    expect(right.x).toBeGreaterThan(ctr.x);
    const down = px(v.center.x + v.n.x * 0.5, v.center.y + v.n.y * 0.5);
    expect(down.y).toBeGreaterThan(ctr.y);
    expect(v.width % 28).toBe(0);
    expect(v.height % 28).toBe(0);
  });

  it('traduit charnière et débattement de la vue en sens du mur', () => {
    expect(verdictSwing({ hinge: 'gauche', opens: 'bas' })).toEqual({ hinge: 'a', side: 'gauche' });
    expect(verdictSwing({ hinge: 'droite', opens: 'haut' })).toEqual({ hinge: 'b', side: 'droite' });
    expect(verdictSwing({ hinge: 'inconnu', opens: 'haut' })).toEqual(null);
    // Vue retournée (mur tracé de droite à gauche) : la gauche de la vue est le côté b
    expect(verdictSwing({ hinge: 'gauche', opens: 'bas' }, true)).toEqual({ hinge: 'b', side: 'droite' });
  });

  it('garde les textes à l’endroit : un mur tracé de droite à gauche est vu retourné', () => {
    const w = wall('x', [6, 2], [1, 2]);
    const o: Opening = { id: 'f', wallId: 'x', kind: 'fenetre', offset: 1.5, width: 1, height: 1.25, sill: 0.9, productId: null };
    const v = openingView(w, o);
    expect(v.flipped).toBe(true);
    expect(v.u.x).toBeGreaterThan(0);
    expect(v.center.x).toBeCloseTo(4.5);
    // Une baie vue à droite de la vue est près de a (offset faible)
    const b: Building = { levels: [{ id: 'r', name: 'R', elevation: 0, height: 2.5, slab: 0.2 }], walls: [w], openings: [], rooms: [], furniture: [], roof: null };
    const [s] = stripViews(w);
    const px = (x: number) => ((x - s.view.center.x) / s.view.length + 0.5) * s.view.width;
    applyStrip(b, 'x', s.view, s.from, s.to, [{ kind: 'fenetre', x_start: px(4.5), x_end: px(5.5) }]);
    expect(b.openings[0].offset).toBeCloseTo(1, 1);
  });

  it('retire une fausse porte seulement si l’IA en est sûre', () => {
    const b = house();
    const out = applyVerdict(b, 'p-nord', { kind: 'rien', hinge: 'inconnu', opens: 'inconnu', leaves: 1, sure: false });
    expect(b.openings.find((o) => o.id === 'p-nord')?.ai?.status).toBe('a-verifier');
    expect(out.doubtful).toBe(1);
    applyVerdict(b, 'p-nord', { kind: 'rien', hinge: 'inconnu', opens: 'inconnu', leaves: 1, sure: true }, out);
    expect(b.openings.find((o) => o.id === 'p-nord')).toBeUndefined();
    expect(out.removed).toBe(1);
  });

  it('corrige une porte en fenêtre en façade, jamais dans une cloison', () => {
    const b = house();
    applyVerdict(b, 'p-nord', { kind: 'fenetre', hinge: 'inconnu', opens: 'inconnu', leaves: 1, sure: true });
    const n = b.openings.find((o) => o.id === 'p-nord')!;
    expect(n.kind).toBe('fenetre');
    expect(n.sill).toBeCloseTo(0.9);
    expect(n.ai?.status).toBe('corrige');
    applyVerdict(b, 'p-cloison', { kind: 'fenetre', hinge: 'gauche', opens: 'bas', leaves: 1, sure: true });
    const c = b.openings.find((o) => o.id === 'p-cloison')!;
    expect(c.kind).toBe('porte');
    expect(c.swing).toEqual({ hinge: 'a', side: 'gauche' });
  });

  it('confirme une porte bien lue', () => {
    const b = house();
    b.openings[0].swing = { hinge: 'b', side: 'droite' };
    const out = applyVerdict(b, 'p-nord', { kind: 'porte', hinge: 'droite', opens: 'haut', leaves: 1, sure: true });
    expect(out.confirmed).toBe(1);
    expect(b.openings[0].ai?.status).toBe('confirme');
  });

  it('ajoute une fenêtre oubliée vue sur un tronçon de façade, à sa place', () => {
    const b = house();
    const w = b.walls.find((x) => x.id === b.openings[0].wallId)!;
    const s = stripViews(w).find((x) => x.from <= 3.5 && x.to > 3.5)!;
    // Fenêtre de 1,2 m centrée à 3,5 m du début du mur ; la porte existante (2 m) n'est pas redoublée
    const px = (m: number) => ((m - s.from - (s.to - s.from) / 2) / s.view.length + 0.5) * s.view.width;
    const out = applyStrip(b, w.id, s.view, s.from, s.to, [
      { kind: 'fenetre', x_start: px(2.9), x_end: px(4.1) },
    ]);
    // La porte existante (centrée à 2 m), vue sur le tronçon voisin, n'est pas redoublée
    const s0 = stripViews(w).find((x) => x.from <= 2 && x.to > 2)!;
    const px0 = (m: number) => ((m - s0.from - (s0.to - s0.from) / 2) / s0.view.length + 0.5) * s0.view.width;
    applyStrip(b, w.id, s0.view, s0.from, s0.to, [{ kind: 'porte', x_start: px0(1.55), x_end: px0(2.45) }], out);
    expect(out.added).toBe(1);
    const added = b.openings.find((o) => o.ai?.status === 'a-verifier')!;
    expect(added.kind).toBe('fenetre');
    expect(added.offset).toBeCloseTo(3.5, 1);
    expect(added.width).toBeCloseTo(1.2, 1);
  });
});
