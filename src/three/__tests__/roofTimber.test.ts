import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RoofFrame } from '../../model/roof';
import type { Roof } from '../../model/types';
import { roofTimber } from '../RoofMesh';

const frame: RoofFrame = { minX: 0, maxX: 10, minY: 0, maxY: 8, base: 5, rise: 4, level: { id: 'l', name: 'É', elevation: 2.7, height: 2.5, slab: 0.2 } };
const roof = (r: Partial<Roof>): Roof => ({ type: 'deux-pans', levelId: 'l', pitch: 45, overhang: 0.4, ridge: 'x', coveringId: null, insulationId: null, ...r });
// Dessus de la couverture (pente 45°, faîtage en y = 4)
const top = (z: number) => 5 + Math.min(z, 8 - z);

function points(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute;
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
}

describe('charpente', () => {
  it('combles perdus : chevrons, pannes et faîtage sous la couverture', () => {
    const g = roofTimber(frame, roof({}))!;
    const pts = points(g);
    // Tout est sous le dessus de la couverture, sans dépasser les débords
    for (const p of pts) {
      expect(p.y).toBeLessThan(top(p.z) - 0.2);
      expect(p.z).toBeGreaterThan(-0.45);
      expect(p.z).toBeLessThan(8.45);
    }
    // Les chevrons descendent jusque sous le débord, des deux côtés
    expect(Math.min(...pts.map((p) => p.z))).toBeLessThan(-0.3);
    expect(Math.max(...pts.map((p) => p.z))).toBeGreaterThan(8.3);
  });

  it('combles aménagés : chevrons seulement sous le débord, poutres apparentes sur demande', () => {
    const hidden = points(roofTimber(frame, roof({ eave: 0.5 }))!);
    expect(hidden.every((p) => p.z < 0.05 || p.z > 7.95)).toBe(true);
    const shown = points(roofTimber(frame, roof({ eave: 0.5, exposedBeams: true }))!);
    // Faîtage et pannes à l'intérieur, sous le rampant
    const inside = shown.filter((p) => p.z > 0.5 && p.z < 7.5);
    expect(inside.length).toBeGreaterThan(0);
    for (const p of inside) expect(p.y).toBeLessThan(top(p.z) - 0.2);
    expect(Math.max(...inside.map((p) => p.y))).toBeGreaterThan(8.3);
  });
});
