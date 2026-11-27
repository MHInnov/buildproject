import { describe, expect, it } from 'vitest';
import { levelOutline } from '../footprint';

const w = (ax: number, ay: number, bx: number, by: number, thickness = 0.2) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, thickness });
const area = (p: { x: number; y: number }[]) => Math.abs(p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0)) / 2;

describe('levelOutline', () => {
  it('suit les faces extérieures d’un rectangle', () => {
    const o = levelOutline([w(0, 0, 10, 0), w(10, 0, 10, 8), w(10, 8, 0, 8), w(0, 8, 0, 0), w(4, 0, 4, 8, 0.1)]);
    expect(o).toHaveLength(1);
    expect(o[0]).toHaveLength(4);
    expect(area(o[0])).toBeCloseTo(10.2 * 8.2, 0);
  });
  it('suit une maison en L et referme une porte laissée ouverte', () => {
    const o = levelOutline([w(0, 0, 10, 0), w(10, 0, 10, 5), w(10, 5, 6, 5), w(6, 5, 6, 9), w(6, 9, 0, 9), w(0, 9, 0, 5), w(0, 4, 0, 0)]);
    expect(o).toHaveLength(1);
    expect(o[0]).toHaveLength(6);
    expect(area(o[0])).toBeCloseTo(10.2 * 5.2 + 6.2 * 4, 0);
  });
});
