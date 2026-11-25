/**
 * Jardin lu sur le plan d'implantation : pelouse de la parcelle et haie basse sur son contour.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import type { Site } from '../model/types';
import { plain, surfaceMaterial, type Surface } from './materials';

const LAWN: Surface = { color: '#6f9a45', pattern: { kind: 'carpet', photo: 'grass' }, roughness: 1 };
const HEDGE = plain('#3e5b2c', 1);
const HEDGE_H = 1.1;
const HEDGE_W = 0.45;

export function Garden({ site }: { site: Site }) {
  const lawn = useMemo(() => {
    // (x, -y) puis rotation -90° autour de X : le point du plan (x, y) arrive en (x, 0, y)
    const g = new THREE.ShapeGeometry(new THREE.Shape(site.parcel.map((p) => new THREE.Vector2(p.x, -p.y))));
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getY(i));
    return g;
  }, [site]);
  const hedges = useMemo(
    () =>
      site.parcel.map((a, i) => {
        const b = site.parcel[(i + 1) % site.parcel.length];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        return { x: (a.x + b.x) / 2, z: (a.y + b.y) / 2, L, rot: -Math.atan2(b.y - a.y, b.x - a.x) };
      }),
    [site],
  );
  return (
    <group>
      <mesh geometry={lawn} rotation-x={-Math.PI / 2} position-y={-0.012} material={surfaceMaterial(LAWN)} receiveShadow />
      {hedges.map((h, i) => (
        <mesh key={i} position={[h.x, HEDGE_H / 2 - 0.02, h.z]} rotation-y={h.rot} material={HEDGE} castShadow receiveShadow>
          <boxGeometry args={[h.L + HEDGE_W, HEDGE_H, HEDGE_W]} />
        </mesh>
      ))}
    </group>
  );
}
