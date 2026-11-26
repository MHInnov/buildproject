/**
 * Jardin : pelouse de la parcelle (lue sur le plan d'implantation) et haie basse sur son contour,
 * abords de la maison (terrasse, allée ou gravier tout autour).
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { APRONS, DEFAULT_APRON_WIDTH, DEFAULT_LAWN, LAWNS, outdoorById, type OutdoorMaterial } from '../data/exterior';
import { facadeOpeningsAt } from '../model/sectionFacts';
import type { Building, Site } from '../model/types';
import { groundLevel } from '../traceApply';
import { plain, surfaceMaterial, type Surface } from './materials';

const HEDGE = plain('#3e5b2c', 1);
const HEDGE_H = 1.1;
const HEDGE_W = 0.45;

/** Sol du jardin choisi (gazon par défaut). */
export const lawnSurface = (b: Building): Surface => (outdoorById(LAWNS, b.outdoor?.lawn) ?? outdoorById(LAWNS, DEFAULT_LAWN)!).surface;

export function Garden({ site, lawn }: { site: Site; lawn: Surface }) {
  const geo = useMemo(() => {
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
      <mesh geometry={geo} rotation-x={-Math.PI / 2} position-y={-0.012} material={surfaceMaterial(lawn)} receiveShadow />
      {hedges.map((h, i) => (
        <mesh key={i} position={[h.x, HEDGE_H / 2 - 0.02, h.z]} rotation-y={h.rot} material={HEDGE} castShadow receiveShadow>
          <boxGeometry args={[h.L + HEDGE_W, HEDGE_H, HEDGE_W]} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Abords : une bande le long de chaque façade du rez-de-chaussée, prolongée aux angles. Sous la maison
 * elle est cachée par les sols ; les coordonnées de texture sont celles du terrain, les bandes se
 * raccordent donc sans couture.
 */
export function Apron({ building }: { building: Building }) {
  const o = building.outdoor;
  const mat = outdoorById(APRONS, o?.apron);
  const width = o?.apronWidth ?? DEFAULT_APRON_WIDTH;
  const geo = useMemo(() => {
    if (!mat || !building.levels.length) return null;
    const level = groundLevel(building);
    const walls = building.walls.filter((w) => w.levelId === level.id && w.thickness >= 0.15);
    if (!walls.length) return null;
    const pos: number[] = [];
    for (const w of walls) {
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (L < 0.05) continue;
      const ux = (w.b.x - w.a.x) / L;
      const uy = (w.b.y - w.a.y) / L;
      const e = width + w.thickness / 2;
      // Rectangle centré sur le mur, débordant de la largeur des abords de chaque côté et aux extrémités
      const c = [
        [w.a.x - ux * e - uy * e, w.a.y - uy * e + ux * e],
        [w.b.x + ux * e - uy * e, w.b.y + uy * e + ux * e],
        [w.b.x + ux * e + uy * e, w.b.y + uy * e - ux * e],
        [w.a.x - ux * e + uy * e, w.a.y - uy * e - ux * e],
      ];
      for (const i of [0, 2, 1, 0, 3, 2]) pos.push(c[i][0], 0, c[i][1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const uv: number[] = [];
    for (let i = 0; i < pos.length; i += 3) uv.push(pos[i], -pos[i + 2]);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  }, [building, mat, width]);
  if (!geo || !mat) return null;
  return <mesh geometry={geo} position-y={-0.006} material={surfaceMaterial(mat.surface, false, { side: THREE.DoubleSide })} receiveShadow />;
}

/**
 * Accès devant les portes du rez-de-chaussée : allée de gravier devant une porte de garage, chemin dallé
 * devant une porte d'entrée, terrasse devant une porte-fenêtre (porte vitrée ou à deux vantaux).
 */
export function Paths({ building }: { building: Building }) {
  const parts = useMemo(() => {
    if (!building.levels.length || building.outdoor?.paths === false) return [];
    const level = groundLevel(building);
    const res: { id: string; mat: OutdoorMaterial; quad: number[][] }[] = [];
    for (const { opening: o, wall, center, u, out } of facadeOpeningsAt(building, level.id)) {
      if (o.kind !== 'porte') continue;
      const garage = o.productId === 'ex-porte-garage';
      const terrace = !garage && ((o.options?.leaves ?? 1) > 1 || o.width >= 1.3);
      const width = garage ? o.width + 0.6 : terrace ? o.width + 1 : 1.2;
      const depth = garage ? 5.5 : terrace ? 2.2 : 1.6;
      const id = garage ? 'gravier' : terrace ? 'dalles-pierre' : 'dalles-beton';
      const mat = outdoorById(APRONS, id)!;
      const s = wall.thickness / 2;
      const p = (a: number, d: number) => [center.x + u.x * a + out.x * (s + d), center.y + u.y * a + out.y * (s + d)];
      res.push({ id: o.id, mat, quad: [p(-width / 2, 0), p(width / 2, 0), p(width / 2, depth), p(-width / 2, depth)] });
    }
    return res.map((r) => {
      const pos: number[] = [];
      for (const i of [0, 1, 2, 0, 2, 3]) pos.push(r.quad[i][0], 0, r.quad[i][1]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const uv: number[] = [];
      for (let i = 0; i < pos.length; i += 3) uv.push(pos[i], -pos[i + 2]);
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      return { id: r.id, geo: g, mat: r.mat };
    });
  }, [building]);
  return (
    <>
      {parts.map((p) => (
        <mesh key={p.id} geometry={p.geo} position-y={-0.003} material={surfaceMaterial(p.mat.surface, false, { side: THREE.DoubleSide })} receiveShadow />
      ))}
    </>
  );
}
