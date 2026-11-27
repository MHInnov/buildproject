import { describe, expect, it } from 'vitest';
import { fitSite, readSitePlan } from '../site';
import type { Bitmap } from '../vectorize';

/** Page blanche 700 × 1000 avec une maison noire, une parcelle (quadrilatère) et un quadrillage de cotes. */
function sitePage(): Bitmap {
  const w = 700;
  const h = 1000;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const dot = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const i = (yi * w + xi) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };
  const line = (ax: number, ay: number, bx: number, by: number, th = 2) => {
    const L = Math.hypot(bx - ax, by - ay);
    for (let t = 0; t <= L; t += 0.5) for (let k = 0; k < th; k++) dot(ax + ((bx - ax) * t) / L + k * 0.7, ay + ((by - ay) * t) / L);
  };
  // Maison : 10 × 16 m à 15 px/m, en L (aile de 3 m en bas à droite)
  for (let y = 400; y < 640; y++) for (let x = 300; x < (y > 520 ? 420 : 450); x++) dot(x, y);
  // Parcelle
  const P = [
    [180, 860],
    [330, 140],
    [590, 190],
    [480, 860],
  ];
  for (let i = 0; i < 4; i++) line(P[i][0], P[i][1], P[(i + 1) % 4][0], P[(i + 1) % 4][1]);
  // Quadrillage et cotes, qui s'arrêtent avant les bords ou les dépassent
  for (const x of [260, 360, 470]) line(x, 300, x, 820, 1);
  line(150, 330, 620, 330, 1);
  line(120, 720, 520, 720, 1);
  return { width: w, height: h, data };
}

describe('plan d’implantation', () => {
  it('trouve la maison noire et le contour de la parcelle', () => {
    const r = readSitePlan(sitePage())!;
    expect(r).not.toBeNull();
    expect(r.houseBox.x0).toBeGreaterThan(290);
    expect(r.houseBox.x1).toBeLessThan(460);
    expect(r.parcel).not.toBeNull();
    const near = (x: number, y: number) => r.parcel!.some((p) => Math.hypot(p.x - x, p.y - y) < 8);
    expect(r.parcel).toHaveLength(4);
    expect(near(180, 860) && near(330, 140) && near(590, 190) && near(480, 860)).toBe(true);
  });

  it('cale la maison sur l’emprise du rez-de-chaussée (échelle, orientation)', () => {
    const r = readSitePlan(sitePage())!;
    // Rez-de-chaussée en L, tourné d'un quart de tour par rapport à la page
    const outline = [[
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 2 },
      { x: 16, y: 2 },
      { x: 16, y: 10 },
      { x: 0, y: 10 },
    ]];
    const f = fitSite(r, outline)!;
    expect(f).not.toBeNull();
    expect(f.scale).toBeCloseTo(1 / 15, 2);
    expect(f.overlap).toBeGreaterThan(0.75);
  });

  it('ne voit pas de jardin sur une page sans maison noire', () => {
    const page = sitePage();
    for (let y = 400; y < 640; y++) for (let x = 300; x < 450; x++) page.data.fill(255, (y * page.width + x) * 4, (y * page.width + x) * 4 + 3);
    expect(readSitePlan(page)).toBeNull();
  });
});
