/**
 * Ce que les coupes disent des façades : hauteur d'allège et de linteau des baies coupées, niveau du
 * rez-de-chaussée au-dessus du terrain (soubassement), pente et débord du toit. Lu sur le dessin (murs de
 * façade coupés) ou, avec l'IA, sur les cotes écrites. Appliqué aux portes et fenêtres des murs extérieurs.
 */
import { levelOutline } from './footprint';
import type { Building, Level, Opening, Point, Wall } from './types';

export interface SectionOpening {
  /** Niveau, compté depuis le rez-de-chaussée (0), négatif pour une cave. */
  storey: number;
  kind: 'fenetre' | 'porte';
  /** Bas de la baie au-dessus du sol fini (0 pour une porte), en mètres. */
  sill: number;
  /** Haut de la baie (sous le linteau) au-dessus du sol fini, en mètres. */
  head: number;
}

export interface SectionFacts {
  openings: SectionOpening[];
  /** Hauteur sous plafond et épaisseur du plancher de chaque niveau (lues par l'IA sur les cotes). */
  storeys?: { storey: number; height: number; slab: number | null }[];
  /** Sol du rez-de-chaussée au-dessus du terrain, en mètres. */
  plinth?: number | null;
  /** Toit : pente en degrés, débord en mètres. */
  roof?: { pitch?: number | null; overhang?: number | null } | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((m, n) => m - n);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function inside(p: Point, poly: Point[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

export interface FacadeOpening {
  opening: Opening;
  wall: Wall;
  /** Milieu de la baie, sur l'axe du mur. */
  center: Point;
  /** Direction du mur (de a vers b) et normale vers l'extérieur. */
  u: Point;
  out: Point;
}

/** Ouvertures d'un niveau percées dans un mur de façade (un côté du mur donne dehors), avec le côté extérieur. */
export function facadeOpeningsAt(b: Building, levelId: string): FacadeOpening[] {
  const walls = b.walls.filter((w) => w.levelId === levelId);
  const outline = levelOutline(walls);
  if (!outline.length) return [];
  const byId = new Map<string, Wall>(walls.map((w) => [w.id, w]));
  const res: FacadeOpening[] = [];
  for (const o of b.openings) {
    const w = byId.get(o.wallId);
    if (!w) continue;
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    const center = { x: w.a.x + u.x * o.offset, y: w.a.y + u.y * o.offset };
    const d = w.thickness / 2 + 0.25;
    for (const s of [1, -1]) {
      const n = { x: -u.y * s, y: u.x * s };
      if (!outline.some((poly) => inside({ x: center.x + n.x * d, y: center.y + n.y * d }, poly))) {
        res.push({ opening: o, wall: w, center, u, out: n });
        break;
      }
    }
  }
  return res;
}

export const facadeOpenings = (b: Building, levelId: string): Opening[] => facadeOpeningsAt(b, levelId).map((f) => f.opening);

/**
 * Applique les hauteurs lues sur les coupes aux baies des façades, niveau par niveau (médiane des baies
 * coupées : les fenêtres d'une façade sont presque toujours alignées), puis le soubassement et le toit.
 * Rend une ligne de compte rendu par changement.
 */
export function applySectionFacts(b: Building, facts: SectionFacts): string[] {
  const notes: string[] = [];
  const sorted = [...b.levels].sort((m, n) => m.elevation - n.elevation);
  const ground = [...b.levels].sort((m, n) => Math.abs(m.elevation) - Math.abs(n.elevation))[0];
  const gi = sorted.indexOf(ground);
  const fmt = (n: number) => n.toFixed(2).replace('.', ',');
  const ok = (o: SectionOpening, l: Level) => o.head > o.sill + 0.3 && o.head <= l.height + 0.05 && o.sill >= 0 && o.head >= 1.2;
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i];
    const here = facts.openings.filter((o) => o.storey === i - gi && ok(o, l));
    if (!here.length) continue;
    const wins = here.filter((o) => o.kind === 'fenetre' && o.sill >= 0.2);
    const doors = here.filter((o) => o.kind === 'porte' || o.sill < 0.2);
    const ext = facadeOpenings(b, l.id);
    const said: string[] = [];
    if (wins.length) {
      const sill = r2(median(wins.map((o) => o.sill)));
      const head = r2(median(wins.map((o) => o.head)));
      let n = 0;
      for (const o of ext) {
        if (o.kind !== 'fenetre') continue;
        o.sill = sill;
        o.height = r2(head - sill);
        n++;
      }
      if (n) said.push(`${n} fenêtres à ${fmt(sill)} m du sol, linteau à ${fmt(head)} m`);
    }
    // Portes de façade : hauteur lue, ou à défaut le linteau des fenêtres (alignés sur une même façade)
    const doorHead = doors.length ? r2(median(doors.map((o) => o.head))) : wins.length ? r2(median(wins.map((o) => o.head))) : NaN;
    if (doorHead >= 1.9 && doorHead <= 2.6) {
      let n = 0;
      for (const o of ext) {
        if (o.kind !== 'porte' || o.productId === 'ex-porte-garage') continue;
        o.height = doorHead;
        o.sill = 0;
        n++;
      }
      if (n) said.push(`${n} portes de ${fmt(doorHead)} m`);
    }
    if (said.length) notes.push(`${l.name} : ${said.join(', ')}.`);
  }
  if (facts.plinth != null && facts.plinth >= 0.05 && facts.plinth <= 1.5) {
    b.plinth = r2(facts.plinth);
    notes.push(`Rez-de-chaussée à ${fmt(b.plinth)} m au-dessus du terrain (soubassement).`);
  }
  if (b.roof && facts.roof) {
    const { pitch, overhang } = facts.roof;
    if (pitch != null && pitch >= 5 && pitch <= 65 && b.roof.type !== 'plat') b.roof.pitch = Math.round(pitch);
    if (overhang != null && overhang >= 0 && overhang <= 1.5) b.roof.overhang = r2(overhang);
  }
  return notes;
}
