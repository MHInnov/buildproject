/**
 * Murs sous les rampants de combles aménagés : leur haut suit la pente du toit (murs mansardés,
 * pignons jusqu'au faîtage).
 */
import * as THREE from 'three';
import { ROOF_DEPTH, roofFrame } from '../model/roof';
import type { Building, Wall } from '../model/types';


export interface WallProfile {
  /** Hauteur visée avant la pente (le mur s'arrête plus bas s'il touche le rampant). */
  height: number;
  /** Hauteur du dessous du rampant à une distance x du début du mur (m, depuis le sol du niveau). */
  top: (x: number) => number;
  /** Abscisses où la pente change (passage sous le faîtage). */
  breaks: number[];
}

/**
 * Profil des murs du niveau qui porte un toit à pans quand ce sont des combles aménagés (égout renseigné).
 * Les pignons (murs épais perpendiculaires au faîtage, au bord du toit) montent jusqu'au rampant ; les
 * cloisons gardent leur hauteur, rabotée par la pente.
 */
export function atticProfiles(b: Building): ((w: Wall) => WallProfile | null) | null {
  const roof = b.roof;
  if (!roof || roof.eave == null || (roof.type !== 'deux-pans' && roof.type !== 'monopente')) return null;
  const f = roofFrame(b, roof);
  if (!f) return null;
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const drop = ROOF_DEPTH / Math.cos((roof.pitch * Math.PI) / 180);
  const eave = f.base - f.level.elevation;
  // Coordonnée en travers du faîtage : y pour un faîtage selon x
  const across = (p: { x: number; y: number }) => (roof.ridge === 'x' ? p.y : p.x);
  const lo = roof.ridge === 'x' ? f.minY : f.minX;
  const hi = roof.ridge === 'x' ? f.maxY : f.maxX;
  const under = (c: number) => {
    const d = roof.type === 'deux-pans' ? Math.min(c - lo, hi - c) : c - lo;
    return eave + Math.max(0, d) * t - drop;
  };
  const ridgeAt = (lo + hi) / 2;
  const ridgeTop = under(roof.type === 'deux-pans' ? ridgeAt : hi);
  return (w: Wall) => {
    if (w.levelId !== roof.levelId) return null;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const p = (x: number) => ({ x: w.a.x + ((w.b.x - w.a.x) * x) / L, y: w.a.y + ((w.b.y - w.a.y) * x) / L });
    const ca = across(w.a);
    const cb = across(w.b);
    const breaks: number[] = [];
    if (roof.type === 'deux-pans' && (ca - ridgeAt) * (cb - ridgeAt) < 0) breaks.push((L * (ridgeAt - ca)) / (cb - ca));
    // Pignon : mur épais, en travers du faîtage, au bord du toit
    const alongRidge = roof.ridge === 'x' ? Math.abs(w.a.y - w.b.y) < Math.abs(w.a.x - w.b.x) : Math.abs(w.a.x - w.b.x) < Math.abs(w.a.y - w.b.y);
    const end = roof.ridge === 'x' ? w.a.x : w.a.y;
    const e0 = roof.ridge === 'x' ? f.minX : f.minY;
    const e1 = roof.ridge === 'x' ? f.maxX : f.maxY;
    const gable = !alongRidge && w.thickness >= 0.15 && Math.min(Math.abs(end - e0), Math.abs(end - e1)) < 0.6;
    return { height: gable ? ridgeTop + 1 : w.height, top: (x: number) => under(across(p(x))), breaks };
  };
}

/**
 * Polygone vertical (dans le repère du mur : x le long, y vers le haut) épaissi de `th` de part et d'autre
 * de z = 0. Mêmes groupes de matériaux que les blocs de mur : chants en 0, face gauche (+z) en 4, droite en 5.
 */
export function prismGeometry(poly: [number, number][], th: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const g = new THREE.BufferGeometry();
  const z1 = th / 2;
  const z0 = -th / 2;
  const tri = THREE.ShapeUtils.triangulateShape(
    poly.map(([x, y]) => new THREE.Vector2(x, y)),
    [],
  );
  const ccw = THREE.ShapeUtils.isClockWise(poly.map(([x, y]) => new THREE.Vector2(x, y))) ? -1 : 1;
  let count = 0;
  // chants
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const quad: [number, number, number, number, number][] = ccw > 0
      ? [[ax, ay, z1, 0, 0], [ax, ay, z0, 0, th], [bx, by, z0, L, th], [ax, ay, z1, 0, 0], [bx, by, z0, L, th], [bx, by, z1, L, 0]]
      : [[ax, ay, z1, 0, 0], [bx, by, z0, L, th], [ax, ay, z0, 0, th], [ax, ay, z1, 0, 0], [bx, by, z1, L, 0], [bx, by, z0, L, th]];
    for (const [x, y, z, u, v] of quad) {
      pos.push(x, y, z);
      uv.push(u, v);
    }
  }
  g.addGroup(0, pos.length / 3, 0);
  count = pos.length / 3;
  // face gauche (+z), vue de +z : sens trigonométrique
  const start4 = count;
  const ccwTri = (i: number, j: number, k: number) => (poly[j][0] - poly[i][0]) * (poly[k][1] - poly[i][1]) - (poly[j][1] - poly[i][1]) * (poly[k][0] - poly[i][0]) > 0;
  for (const [i, j, k] of tri) {
    const order = ccwTri(i, j, k) ? [i, j, k] : [i, k, j];
    for (const n of order) {
      pos.push(poly[n][0], poly[n][1], z1);
      uv.push(poly[n][0], poly[n][1]);
    }
  }
  count = pos.length / 3;
  g.addGroup(start4, count - start4, 4);
  // face droite (-z), u inversé comme pour les blocs
  const start5 = count;
  for (const [i, j, k] of tri) {
    const order = ccwTri(i, j, k) ? [i, k, j] : [i, j, k];
    for (const n of order) {
      pos.push(poly[n][0], poly[n][1], z0);
      uv.push(-poly[n][0], poly[n][1]);
    }
  }
  count = pos.length / 3;
  g.addGroup(start5, count - start5, 5);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * Découpe un bloc de mur [x0, x1] × [y0, y1] sous le rampant : polygone dont le haut suit `top`.
 * Renvoie null si le bloc est entièrement sous la pente (bloc ordinaire) ou entièrement au-dessus (rien).
 */
export function clipUnderRoof(x0: number, x1: number, y0: number, y1: number, prof: WallProfile): [number, number][] | 'box' | 'none' {
  const xs = [x0, ...prof.breaks.filter((x) => x > x0 + 1e-4 && x < x1 - 1e-4), x1];
  const tops = xs.map((x) => prof.top(x));
  if (tops.every((t) => t >= y1)) return 'box';
  if (tops.every((t) => t <= y0)) return 'none';
  // haut du polygone : min(y1, rampant), avec les points où le rampant croise y1 ou y0
  const top: [number, number][] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i > 0) {
      const xa = xs[i - 1];
      const xb = xs[i];
      const ta = tops[i - 1];
      const tb = tops[i];
      for (const lvl of [y1, y0]) {
        if ((ta - lvl) * (tb - lvl) < 0) {
          const x = xa + ((lvl - ta) / (tb - ta)) * (xb - xa);
          top.push([x, lvl]);
        }
      }
      top.sort((m, n) => m[0] - n[0]);
    }
    top.push([xs[i], Math.max(y0, Math.min(y1, tops[i]))]);
  }
  top.sort((m, n) => m[0] - n[0]);
  // Polygone : bas de gauche à droite, puis le haut de droite à gauche ; on retire les bouts à hauteur nulle
  const upper = top.filter((p, i, arr) => i === 0 || Math.abs(p[0] - arr[i - 1][0]) > 1e-6 || Math.abs(p[1] - arr[i - 1][1]) > 1e-6);
  const firstUp = upper.findIndex((p) => p[1] > y0 + 1e-4);
  const lastUp = upper.length - 1 - [...upper].reverse().findIndex((p) => p[1] > y0 + 1e-4);
  if (firstUp < 0) return 'none';
  const a = Math.max(0, firstUp - 1);
  const b = Math.min(upper.length - 1, lastUp + 1);
  const seg = upper.slice(a, b + 1);
  const poly: [number, number][] = [[seg[0][0], y0], [seg[seg.length - 1][0], y0]];
  for (let i = seg.length - 1; i >= 0; i--) if (seg[i][1] > y0 + 1e-4 || i === 0 || i === seg.length - 1) poly.push(seg[i]);
  // retire les doublons consécutifs
  return poly.filter((p, i) => {
    const q = poly[(i + poly.length - 1) % poly.length];
    return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
  });
}
