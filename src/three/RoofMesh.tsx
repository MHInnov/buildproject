import { useMemo } from 'react';
import * as THREE from 'three';
import type { Catalog } from '../model/catalog';
import { productById } from '../model/catalog';
import { roofFrame, type RoofFrame } from '../model/roof';
import type { Building, Roof, RoofWindow } from '../model/types';
import { CEILING, FACADE, fromProduct, PLASTER, ROOF_UNDERSIDE, surfaceMaterial } from './materials';

type V = THREE.Vector3;
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function normalOf(poly: V[]): V {
  // Méthode de Newell
  const n = v3(0, 0, 0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.normalize();
}

/**
 * Plaque épaisse (pan de toiture) à partir d'un polygone convexe :
 * dessus (couverture, groupe 0), dessous (groupe 1), chants (groupe 2).
 * Coordonnées de texture en mètres : u le long de l'égout, v dans le sens de la pente.
 */
function slab(polyIn: V[], thickness: number): THREE.BufferGeometry {
  let poly = polyIn;
  let n = normalOf(poly);
  if (n.y < 0) {
    poly = [...poly].reverse();
    n = n.negate();
  }
  const nh = v3(n.x, 0, n.z);
  const e1 = nh.lengthSq() > 1e-6 ? v3(-nh.z, 0, nh.x).normalize() : v3(1, 0, 0);
  const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
  const o = poly[0];
  const bottom = poly.map((p) => p.clone().addScaledVector(n, -thickness));
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (p: V, u: number, w: number) => {
    pos.push(p.x, p.y, p.z);
    uv.push(u, w);
  };
  const proj = (p: V) => [p.clone().sub(o).dot(e1), p.clone().sub(o).dot(e2)] as const;
  const g = new THREE.BufferGeometry();
  let count = 0;
  // Dessus
  for (let i = 1; i < poly.length - 1; i++) for (const p of [poly[0], poly[i], poly[i + 1]]) push(p, ...proj(p));
  g.addGroup(0, (poly.length - 2) * 3, 0);
  count += (poly.length - 2) * 3;
  // Dessous (ordre inversé)
  for (let i = 1; i < bottom.length - 1; i++) for (const p of [bottom[0], bottom[i + 1], bottom[i]]) push(p, ...proj(p));
  g.addGroup(count, (poly.length - 2) * 3, 1);
  count += (poly.length - 2) * 3;
  // Chants
  const start = count;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = bottom[(i + 1) % poly.length];
    const d = bottom[i];
    const L = a.distanceTo(b);
    for (const [p, u, w] of [[a, 0, 0], [d, 0, thickness], [c, L, thickness], [a, 0, 0], [c, L, thickness], [b, L, 0]] as [V, number, number][]) push(p, u, w);
    count += 6;
  }
  g.addGroup(start, count - start, 2);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

interface Parts {
  slopes: V[][];
  /** Pignons et murs hauts sous toiture (polygones verticaux, épaissis vers l'intérieur). */
  gables: V[][];
}

/** Géométrie de la toiture, construite dans un repère où le faîtage suit l'axe x, puis remise en place. */
export function roofParts(f: RoofFrame, roof: Roof): Parts {
  const swap = roof.type === 'quatre-pans' ? f.maxY - f.minY > f.maxX - f.minX : roof.ridge === 'y';
  // Repère canonique : u le long du faîtage, w en travers
  const u0 = swap ? f.minY : f.minX;
  const u1 = swap ? f.maxY : f.maxX;
  const w0 = swap ? f.minX : f.minY;
  const w1 = swap ? f.maxX : f.maxY;
  const P = (u: number, h: number, w: number) => (swap ? v3(w, h, u) : v3(u, h, w));
  const ov = roof.overhang;
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const base = f.base;
  const hE = base - ov * t;
  const cw = (w0 + w1) / 2;
  const slopes: V[][] = [];
  const gables: V[][] = [];
  if (roof.type === 'deux-pans') {
    const hR = base + ((w1 - w0) / 2) * t;
    slopes.push([P(u0 - ov, hE, w0 - ov), P(u1 + ov, hE, w0 - ov), P(u1 + ov, hR, cw), P(u0 - ov, hR, cw)]);
    slopes.push([P(u0 - ov, hR, cw), P(u1 + ov, hR, cw), P(u1 + ov, hE, w1 + ov), P(u0 - ov, hE, w1 + ov)]);
    gables.push([P(u0, base, w0), P(u0, base, w1), P(u0, hR, cw)]);
    gables.push([P(u1, base, w0), P(u1, base, w1), P(u1, hR, cw)]);
  } else if (roof.type === 'quatre-pans') {
    const hw = (w1 - w0) / 2;
    const hR = base + hw * t;
    const r0 = Math.min(u0 + hw, (u0 + u1) / 2);
    const r1 = Math.max(u1 - hw, (u0 + u1) / 2);
    const a = P(u0 - ov, hE, w0 - ov);
    const b = P(u1 + ov, hE, w0 - ov);
    const c = P(u1 + ov, hE, w1 + ov);
    const d = P(u0 - ov, hE, w1 + ov);
    const R0 = P(r0, hR, cw);
    const R1 = P(r1, hR, cw);
    slopes.push(r1 - r0 > 0.01 ? [a, b, R1, R0] : [a, b, R0]);
    slopes.push(r1 - r0 > 0.01 ? [R0, R1, c, d] : [R0, c, d]);
    slopes.push([d, a, R0]);
    slopes.push([b, c, R1]);
  } else if (roof.type === 'monopente') {
    const hHigh = base + (w1 - w0 + ov) * t;
    const top = base + (w1 - w0) * t;
    slopes.push([P(u0 - ov, hE, w0 - ov), P(u1 + ov, hE, w0 - ov), P(u1 + ov, hHigh, w1 + ov), P(u0 - ov, hHigh, w1 + ov)]);
    gables.push([P(u0, base, w0), P(u0, base, w1), P(u0, top, w1)]);
    gables.push([P(u1, base, w0), P(u1, base, w1), P(u1, top, w1)]);
    gables.push([P(u0, base, w1), P(u1, base, w1), P(u1, top, w1), P(u0, top, w1)]);
  } else {
    const h = base + 0.3;
    slopes.push([P(u0 - ov, h, w0 - ov), P(u1 + ov, h, w0 - ov), P(u1 + ov, h, w1 + ov), P(u0 - ov, h, w1 + ov)]);
  }
  return { slopes, gables };
}

/** Pignon : polygone vertical épaissi vers l'intérieur de la maison. */
function gable(poly: V[], center: V, thickness: number): THREE.BufferGeometry {
  const n = normalOf(poly);
  const c = poly.reduce((s, p) => s.add(p), v3(0, 0, 0)).multiplyScalar(1 / poly.length);
  // On épaissit vers le centre de la maison.
  const dir = n.dot(center.clone().sub(c)) > 0 ? n : n.clone().negate();
  const outer = poly;
  const inner = poly.map((p) => p.clone().addScaledVector(dir, thickness));
  const pos: number[] = [];
  const uv: number[] = [];
  const hAxis = v3(-dir.z, 0, dir.x).normalize();
  const push = (p: V) => {
    pos.push(p.x, p.y, p.z);
    uv.push(p.dot(hAxis), p.y);
  };
  for (let i = 1; i < outer.length - 1; i++) {
    for (const p of [outer[0], outer[i], outer[i + 1]]) push(p);
    for (const p of [inner[0], inner[i + 1], inner[i]]) push(p);
  }
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    const c2 = inner[(i + 1) % outer.length];
    const d = inner[i];
    for (const p of [a, d, c2, a, c2, b]) push(p);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

export function RoofMesh({ building, catalog, selected, onClick }: { building: Building; catalog: Catalog; selected: boolean; onClick?: (e: { stopPropagation: () => void; delta: number }) => void }) {
  const roof = building.roof;
  const f = useMemo(() => roofFrame(building), [building]);
  const geo = useMemo(() => {
    if (!f || !roof) return null;
    const parts = roofParts(f, roof);
    const center = v3((f.minX + f.maxX) / 2, f.base, (f.minY + f.maxY) / 2);
    return {
      slopes: parts.slopes.map((p) => slab(p, roof.type === 'plat' ? 0.3 : 0.24)),
      // Combles aménagés : les pignons sont les murs de l'étage, montés jusqu'au rampant
      gables: roof.eave != null ? [] : parts.gables.map((p) => gable(p, center, 0.3)),
    };
  }, [f, roof]);
  if (!geo || !roof) return null;
  const covering = fromProduct(productById(catalog, roof.coveringId), { color: '#9c4f36', pattern: { kind: 'rooftiles', w: 0.22, h: 0.3 }, roughness: 0.85 });
  const top = surfaceMaterial(covering, selected);
  // Sous des combles aménagés, le rampant est plafonné
  const under = surfaceMaterial(roof.eave != null ? CEILING : ROOF_UNDERSIDE, selected);
  const edge = surfaceMaterial(PLASTER, selected);
  const ud = { sel: { kind: 'roof', id: 'roof' } };
  return (
    <group>
      {geo.slopes.map((g, i) => (
        <mesh key={i} geometry={g} material={[top, under, edge]} castShadow receiveShadow userData={ud} onClick={onClick} />
      ))}
      {geo.gables.map((g, i) => (
        <mesh key={`g${i}`} geometry={g} material={surfaceMaterial(FACADE, selected)} castShadow receiveShadow userData={ud} onClick={onClick} />
      ))}
      {f && (roof.windows ?? []).map((w) => <RoofWindowMesh key={w.id} win={w} roof={roof} f={f} selected={selected} onClick={onClick} />)}
    </group>
  );
}

const FRAME = new THREE.MeshStandardMaterial({ color: '#3d3f42', roughness: 0.5, metalness: 0.3 });
const PANE = new THREE.MeshStandardMaterial({ color: '#5f7d93', roughness: 0.08, metalness: 0.4, envMapIntensity: 1.6 });
const SKY = new THREE.MeshStandardMaterial({ color: '#cfe3f3', roughness: 0.3, emissive: '#9fc3e0', emissiveIntensity: 0.55 });

/** Fenêtre de toit : cadre et vitre posés dans le pan, et le jour vu de l'intérieur. */
function RoofWindowMesh({ win, roof, f, selected, onClick }: { win: RoofWindow; roof: Roof; f: RoofFrame; selected: boolean; onClick?: (e: { stopPropagation: () => void; delta: number }) => void }) {
  const place = useMemo(() => {
    if (roof.type !== 'deux-pans' && roof.type !== 'monopente') return null;
    const th = (roof.pitch * Math.PI) / 180;
    const t = Math.tan(th);
    const alongX = roof.ridge === 'x';
    const c = alongX ? win.y : win.x;
    const lo = alongX ? f.minY : f.minX;
    const hi = alongX ? f.maxY : f.maxX;
    const loSide = roof.type === 'monopente' || c < (lo + hi) / 2;
    const d = loSide ? c - lo : hi - c;
    const h = f.base + Math.max(0, d) * t;
    // Repère du pan : u le long du faîtage, s en montant la pente, n la normale vers le ciel
    const sgn = loSide ? 1 : -1;
    const u = alongX ? v3(1, 0, 0) : v3(0, 0, 1);
    const sUp = alongX ? v3(0, Math.sin(th), sgn * Math.cos(th)) : v3(sgn * Math.cos(th), Math.sin(th), 0);
    const n = new THREE.Vector3().crossVectors(sUp, u).normalize();
    if (n.y < 0) n.negate();
    const m = new THREE.Matrix4().makeBasis(u, n, sUp);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const center = v3(win.x, h, win.y);
    const L = win.length / Math.cos(th);
    return { q, center, n, L };
  }, [win, roof, f]);
  if (!place) return null;
  const { q, center, n, L } = place;
  const at = (k: number) => center.clone().addScaledVector(n, k).toArray() as [number, number, number];
  const ud = { sel: { kind: 'roof', id: 'roof' } };
  return (
    <group>
      <mesh position={at(0.03)} quaternion={q} material={selected ? surfaceMaterial({ color: '#3d3f42' }, true) : FRAME} userData={ud} onClick={onClick} castShadow>
        <boxGeometry args={[win.width, 0.07, L]} />
      </mesh>
      <mesh position={at(0.07)} quaternion={q} material={PANE} userData={ud} onClick={onClick}>
        <boxGeometry args={[win.width - 0.12, 0.02, L - 0.12]} />
      </mesh>
      {/* Côté intérieur : le jour du ciel dans l'épaisseur du toit */}
      <mesh position={at(-0.13)} quaternion={q} material={SKY} userData={ud} onClick={onClick}>
        <boxGeometry args={[win.width - 0.1, 0.3, L - 0.1]} />
      </mesh>
    </group>
  );
}
