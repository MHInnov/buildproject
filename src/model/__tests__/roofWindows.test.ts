import { describe, expect, it } from 'vitest';
import { demoBuilding } from '../../data/demoProject';
import { computeEstimate } from '../estimate';
import { applyOperations, pushOperation } from '../operations';
import { eaveForKnee, kneeHeight, placeRoofWindow, roofFrame, roofWindowLength } from '../roof';
import type { Operation, RoofWindow } from '../types';
import { DEMO_CATALOG } from '../../data/catalog';

describe('fenêtres de toit et combles', () => {
  it('place une fenêtre dans un seul pan, entre égout et faîtage', () => {
    const b = demoBuilding();
    const f = roofFrame(b)!;
    const L = roofWindowLength(b.roof!, 1.18);
    // clic sur le faîtage : la fenêtre est ramenée dans le pan nord, à 20 cm du faîtage
    const mid = (f.minY + f.maxY) / 2;
    const p = placeRoofWindow(b, { x: 3, y: mid - 0.01 }, 0.78, L)!;
    expect(p.y + L / 2).toBeLessThanOrEqual(mid - 0.19);
    expect(p.x).toBe(3);
    // clic au bord du toit : gardée à l'intérieur
    const q = placeRoofWindow(b, { x: f.maxX + 0.2, y: f.maxY }, 0.78, L)!;
    expect(q.x + 0.39).toBeLessThanOrEqual(f.maxX - 0.19);
    expect(q.y + L / 2).toBeLessThanOrEqual(f.maxY - 0.19);
    expect(q.y - L / 2).toBeGreaterThanOrEqual(mid + 0.19);
    // loin du toit : rien
    expect(placeRoofWindow(b, { x: 40, y: 40 }, 0.78, L)).toBeNull();
  });

  it('hauteur des murs extérieurs sous la pente <-> égout', () => {
    const b = demoBuilding();
    const r = b.roof!;
    expect(kneeHeight(b, r)).toBeNull();
    r.eave = eaveForKnee(b, r, 1.1);
    expect(kneeHeight(b, r)).toBeCloseTo(1.1, 1);
  });

  it('projet : ajout, remplacement et suppression, chiffrés', () => {
    const b = demoBuilding();
    const win: RoofWindow = { id: 'rw1', x: 3, y: 2, width: 0.78, length: 0.9, productId: 'velux-rotation-78x118' };
    let ops: Operation[] = pushOperation([], { type: 'addRoofWindow', window: win });
    ops = pushOperation(ops, { type: 'replaceRoofWindow', windowId: 'rw1', productId: 'velux-rotation-114x118' });
    expect(ops).toHaveLength(1);
    expect(applyOperations(b, ops).roof!.windows![0].productId).toBe('velux-rotation-114x118');
    const est = computeEstimate({ existing: b, operations: ops, viewpoints: [] } as never, DEMO_CATALOG);
    expect(JSON.stringify(est)).toContain('Nouvelle fenêtre de toit');
    // supprimer une fenêtre ajoutée dans le projet annule simplement son ajout
    expect(pushOperation(ops, { type: 'removeRoofWindow', windowId: 'rw1' })).toHaveLength(0);
  });
});
