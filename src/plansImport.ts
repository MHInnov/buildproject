/**
 * Import de tout un dossier de plans d'un coup : plans de chaque niveau et coupes.
 * Chaque plan est retracé avec une échelle commune, calé sur le rez-de-chaussée, puis
 * les coupes donnent les hauteurs des niveaux et la forme du toit.
 */
import { newId } from './model/geometry';
import { alignFacades, alignWalls, footprint, guessKind, readSection, storeysFromSection, type PlanKind, type SectionReading } from './model/plans';
import type { Building, Level } from './model/types';
import { autoVectorize, type AutoVectorizeResult, type Bitmap } from './model/vectorize';
import { applyStoreys, applyTrace, groundLevel } from './traceApply';

export interface PlanAnalysis {
  /** Retraçage d'essai (échelle estimée), null si aucun mur. */
  trace: AutoVectorizeResult | null;
  section: SectionReading | null;
  /** Ce que le nom du fichier ou les textes de la page indiquent. */
  hint: PlanKind | null;
  /** Proposition de classement. */
  kind: PlanKind;
}

/** Devine ce que montre une page : le nom du fichier prime, puis les textes de la page, puis le dessin lui-même. */
export function analysePlan(bmp: Bitmap, fileName: string, pageText = ''): PlanAnalysis {
  const byName = guessKind(fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_.]+/g, ' '));
  const byText = guessKind(pageText);
  const section = byName && byName !== 'coupe' ? null : readSection(bmp);
  const trace = byName === 'coupe' || byName === 'ignorer' ? null : autoVectorize(bmp);
  const rooms = trace?.rooms ?? 0;
  const pitched = !!section?.roof && section.roof.type !== 'plat';
  const storeyLike = !!section && looksLikeSection(section);
  let kind: PlanKind;
  if (byName) kind = byName;
  // Les textes d'une page de plan citent souvent les coupes (« voir coupe A-A ») : le dessin doit confirmer.
  else if (byText === 'coupe' && section) kind = 'coupe';
  else if (byText && byText !== 'coupe' && rooms >= 2) kind = byText;
  else if (storeyLike && (pitched || rooms < 5)) kind = 'coupe';
  else if (rooms >= 2) kind = 'rdc'; // niveau précisé ensuite, dans l'ordre des fichiers
  else if (storeyLike) kind = 'coupe';
  else kind = 'ignorer';
  return { trace, section, hint: byName ?? byText, kind };
}

/**
 * Une coupe montre des planchers presque aussi longs que le bâtiment, espacés d'une hauteur d'étage
 * (entre 12 et 50 % de la largeur). Sur un plan, les murs horizontaux sont plus irréguliers.
 */
export function looksLikeSection(sec: SectionReading): boolean {
  const longest = Math.max(...sec.slabs.map((s) => s.length));
  if (sec.slabs.some((s) => s.length < longest * 0.85)) return false;
  for (let i = 1; i < sec.slabs.length; i++) {
    const gap = (sec.slabs[i].top - sec.slabs[i - 1].bottom) / sec.widthPx;
    if (gap < 0.12 || gap > 0.5) return false;
  }
  return true;
}

const FLOOR_ORDER: PlanKind[] = ['rdc', 'etage1', 'etage2', 'etage3'];

/** Les plans sans indication de niveau sont pris dans l'ordre : rez-de-chaussée, puis 1er étage, etc. */
export function spreadFloors(kinds: { kind: PlanKind; hinted: boolean }[]): PlanKind[] {
  const taken = new Set(kinds.filter((x) => x.hinted).map((x) => x.kind));
  return kinds.map((x) => {
    if (x.hinted || x.kind !== 'rdc') return x.kind;
    const free = FLOOR_ORDER.find((k) => !taken.has(k)) ?? 'etage3';
    taken.add(free);
    return free;
  });
}

export interface PlanInput {
  kind: PlanKind;
  /** Image analysée (réduite) et facteur pour revenir aux pixels de l'image enregistrée. */
  bmp: Bitmap;
  k: number;
  /** Image enregistrée (affichée sous le plan). */
  assetId: string;
  width: number;
  height: number;
  name: string;
  /** Échelle connue d'après le PDF (format de page et échelle « 1/50 » du cartouche), en m par pixel de l'image. */
  knownScale?: number | null;
}

export interface ImportReport {
  lines: string[];
  warnings: string[];
  /** Niveau à afficher ensuite (rez-de-chaussée). */
  levelId: string | null;
}

const LEVEL_NAMES: Partial<Record<PlanKind, string>> = { cave: 'Cave', rdc: 'Rez-de-chaussée', etage1: '1er étage', etage2: '2e étage', etage3: '3e étage', combles: 'Combles' };

/** Trouve le niveau correspondant (ou le crée). Les altitudes sont recalculées à la fin. */
export function levelFor(b: Building, kind: PlanKind): Level {
  const sorted = () => [...b.levels].sort((m, n) => m.elevation - n.elevation);
  const g = groundLevel(b);
  if (kind === 'rdc') return g;
  const above = () => sorted().filter((l) => l.elevation > g.elevation);
  const make = (name: string, elevation: number, height: number): Level => {
    const l: Level = { id: newId('lv'), name, elevation, height, slab: 0.22 };
    b.levels.push(l);
    return l;
  };
  if (kind === 'cave') return sorted().find((l) => l.elevation < g.elevation) ?? make('Cave', g.elevation - 2.45, 2.2);
  if (kind === 'combles') {
    const named = b.levels.find((l) => /comble|grenier/i.test(l.name));
    if (named) return named;
    const top = sorted()[sorted().length - 1];
    return make('Combles', top.elevation + top.height + top.slab, 1.2);
  }
  const n = FLOOR_ORDER.indexOf(kind); // 1, 2 ou 3
  const ups = above().filter((l) => !/comble|grenier/i.test(l.name));
  while (ups.length < n) {
    const top = ups[ups.length - 1] ?? g;
    const elevation = Math.round((top.elevation + top.height + top.slab) * 100) / 100;
    // Les combles (ou tout niveau déjà au-dessus) montent d'un étage
    for (const l of b.levels) if (l.elevation >= elevation - 0.01) l.elevation = Math.round((l.elevation + 2.5 + 0.22) * 100) / 100;
    ups.push(make(LEVEL_NAMES[FLOOR_ORDER[ups.length + 1]]!, elevation, 2.5));
  }
  return ups[n - 1];
}

/** Empile les niveaux : le rez-de-chaussée reste à 0. */
function restack(b: Building) {
  applyStoreys(b, []);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((m, n) => m - n);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

/**
 * Retrace tous les plans et lit les coupes. Modifie `b` (à appeler dans editExisting).
 * Les plans au même format d'image partagent une échelle mesurée ou lue sur le PDF ; à défaut, chacun a
 * son estimation (mise en commun si elles concordent), et les étages se recalent en taille sur le
 * rez-de-chaussée.
 */
export function importPlans(b: Building, items: PlanInput[]): ImportReport {
  const lines: string[] = [];
  const warnings: string[] = [];
  const plans = items.filter((x) => x.kind !== 'coupe' && x.kind !== 'ignorer');
  const sections = items.filter((x) => x.kind === 'coupe');

  // Échelle par format d'image
  const sameSize = (a: { width: number; height: number }, c: { width: number; height: number }) =>
    Math.abs(a.width - c.width) / a.width < 0.02 && Math.abs(a.height - c.height) / a.height < 0.02;
  const calibrated = b.levels.map((l) => l.underlay).filter((u): u is NonNullable<typeof u> => !!u?.calibrated);
  const estimate = new Map<PlanInput, number>();
  for (const p of plans) {
    const t = autoVectorize(p.bmp);
    if (t) estimate.set(p, t.scale * p.k);
  }
  // Une échelle lue dans le PDF n'est retenue que si elle confirme à peu près l'épaisseur des murs
  // (un cartouche peut citer une autre échelle que celle du dessin).
  const trusted = (p: PlanInput) => {
    const e = estimate.get(p);
    return p.knownScale && (!e || Math.abs(p.knownScale / e - 1) < 0.35) ? p.knownScale : null;
  };
  const scaleOf = (p: PlanInput): number | null => {
    const cal = calibrated.find((u) => sameSize(u, p));
    if (cal) return cal.scale;
    if (trusted(p)) return trusted(p);
    const known = plans.filter((q) => sameSize(q, p) && trusted(q)).map((q) => trusted(q)!);
    if (known.length) return median(known);
    // Des feuilles de même format ne sont pas forcément à la même échelle (un plan scanné à 1/50, l'autre
    // à 1/100, ou une maison réduite pour tenir sur la page) : on ne met en commun que des estimations qui
    // se confirment entre elles.
    const e = estimate.get(p);
    if (e == null) return null;
    const group = plans.filter((q) => sameSize(q, p) && estimate.has(q)).map((q) => estimate.get(q)!);
    return group.every((x) => Math.abs(x / e - 1) < 0.15) ? median(group) : e;
  };
  /** Échelle sûre (mesurée ou lue sur le PDF) : le calage sur le rez-de-chaussée ne la corrige pas. */
  const sure = (p: PlanInput) => !!calibrated.find((u) => sameSize(u, p)) || !!trusted(p) || plans.some((q) => sameSize(q, p) && trusted(q));

  // Rez-de-chaussée d'abord (référence de calage), puis les autres du bas vers le haut
  const order: PlanKind[] = ['rdc', 'cave', 'etage1', 'etage2', 'etage3', 'combles'];
  const sorted = [...plans].sort((m, n) => order.indexOf(m.kind) - order.indexOf(n.kind));
  let groundId: string | null = null;
  let anchorId: string | null = null;
  const done = new Set<string>();
  for (const p of sorted) {
    const level = levelFor(b, p.kind);
    if (done.has(level.id)) {
      warnings.push(`${p.name} : ${level.name} a déjà un plan dans cet import, ignoré.`);
      continue;
    }
    const scale = scaleOf(p);
    let r = autoVectorize(p.bmp, { scale: scale ? scale / p.k : null });
    if (!r || !r.walls.length) {
      warnings.push(`${p.name} : aucun mur reconnu, plan seulement affiché sous ${level.name}.`);
      continue;
    }
    let s = scale ?? r.scale * p.k;
    // Référence : le rez-de-chaussée (tel qu'il vient d'être retracé, ou déjà dessiné), sinon les murs déjà là
    // Les plans importés remplacent ce qui était dessiné sur leur niveau (murs, pièces, mobilier, sols) :
    // on ne se cale donc jamais sur les anciens murs du niveau lui-même, seulement sur un niveau déjà
    // retracé dans cet import (le rez-de-chaussée d'abord).
    const g = groundLevel(b);
    const refLevel = done.has(g.id) ? g.id : anchorId;
    const target = refLevel && refLevel !== level.id ? b.walls.filter((w) => w.levelId === refLevel) : [];
    b.rooms = b.rooms.filter((x) => x.levelId !== level.id);
    b.furniture = b.furniture.filter((x) => x.levelId !== level.id);
    if (b.floorZones) b.floorZones = b.floorZones.filter((x) => x.levelId !== level.id);
    let dx: number;
    let dy: number;
    let k = 1;
    let note = '';
    if (target.length) {
      // Échelle seulement estimée : on la déduit du calage des façades sur le niveau de référence
      const fa = sure(p) ? null : alignFacades(r.walls, target);
      let al = fa && fa.fit >= 0.3 ? fa : alignWalls(r.walls, target, false);
      let rescaled = false;
      if (al.fit > 0.2 && al.k !== 1) {
        // Nouvelle échelle : on relit le plan à cette échelle (portes, épaisseurs, raccords en dépendent)
        const again = autoVectorize(p.bmp, { scale: (s * al.k) / p.k });
        if (again?.walls.length) {
          const fine = alignWalls(again.walls, target, false);
          if (fine.fit >= al.fit * 0.8) {
            r = again;
            s *= al.k;
            al = { ...fine, k: al.k };
            rescaled = true;
          }
        }
      }
      if (al.fit > 0.2) {
        dx = al.dx;
        dy = al.dy;
        k = rescaled ? 1 : al.k;
        note = ` calé sur ${b.levels.find((l) => l.id === refLevel)?.name ?? 'le rez-de-chaussée'} (${Math.round(al.fit * 100)} % des murs se superposent)${al.k !== 1 ? `, échelle ajustée de ${al.k > 1 ? '+' : ''}${Math.round((al.k - 1) * 100)} %` : ''}`;
      } else {
        // Rien ne correspond : on superpose au moins les emprises par leur centre
        const fb = footprint(r.walls)!;
        const rb = footprint(target)!;
        dx = (rb.x0 + rb.x1) / 2 - (fb.x0 + fb.x1) / 2;
        dy = (rb.y0 + rb.y1) / 2 - (fb.y0 + fb.y1) / 2;
        warnings.push(`${p.name} : ${level.name} ne se superpose pas bien à ${b.levels.find((l) => l.id === refLevel)?.name ?? 'au rez-de-chaussée'} ; centré dessus, à vérifier (case « Déplacer le plan »).`);
      }
    } else {
      const fb = footprint(r.walls)!;
      dx = -fb.x0;
      dy = -fb.y0;
    }
    const scaled = r;
    applyTrace(b, level.id, r, dx, dy, k);
    level.underlay = { assetId: p.assetId, x: dx, y: dy, scale: s * k, width: p.width, height: p.height, opacity: 0.35, visible: true, calibrated: !!calibrated.find((u) => sameSize(u, p)) };
    done.add(level.id);
    if (level.id === g.id) groundId = level.id;
    anchorId ??= level.id;
    const doors = scaled.openings.filter((o) => o.kind === 'porte').length;
    const windows = scaled.openings.filter((o) => o.kind === 'fenetre').length;
    lines.push(`${level.name} (${p.name}) : ${scaled.walls.length} murs, ${doors} portes, ${windows} fenêtres, ${scaled.rooms} pièces${note ? `,${note}` : ''}${trusted(p) ? ', échelle lue sur le PDF' : ''}.`);
  }
  restack(b);

  // Coupes : hauteurs sous plafond, planchers, toit
  const g = groundLevel(b);
  const gw = b.walls.filter((w) => w.levelId === g.id);
  const fp = footprint(gw);
  const fixedLevels = new Set<string>();
  let roofRead = false;
  for (const c of sections) {
    const sec = readSection(c.bmp);
    if (!sec) {
      warnings.push(`${c.name} : planchers non reconnus sur cette coupe.`);
      continue;
    }
    // La coupe traverse la maison dans sa longueur ou sa largeur (faces extérieures des murs)
    const sizes = fp ? [fp.x1 - fp.x0 + 0.3, fp.y1 - fp.y0 + 0.3] : [];
    const fallback = plans.find((p) => sameSize(p, c));
    const fs = c.knownScale ?? (fallback ? (scaleOf(fallback) ?? undefined) : undefined);
    if (!sizes.length && !fs) {
      warnings.push(`${c.name} : importez aussi le plan du rez-de-chaussée pour connaître l'échelle de la coupe.`);
      continue;
    }
    // Échelle lue sur le PDF de la coupe : prioritaire sur les dimensions des plans
    const { storeys } = storeysFromSection(sec, c.knownScale ? [] : sizes, fs ? fs / c.k : undefined);
    const levels = [...b.levels].sort((m, n) => m.elevation - n.elevation);
    // La coupe commence à la cave si elle a autant de niveaux que la maison, sinon au rez-de-chaussée
    const first = storeys.length >= levels.length ? levels[0] : g;
    // Plusieurs coupes : la première qui donne la hauteur d'un niveau fait foi (une coupe transversale lit
    // mal un niveau qu'elle ne traverse pas en entier)
    const kept = b.levels.filter((l) => fixedLevels.has(l.id)).map((l) => ({ l, height: l.height, slab: l.slab }));
    const changed = applyStoreys(b, storeys, first.id).filter((id) => !fixedLevels.has(id));
    for (const { l, height, slab } of kept) {
      for (const w of b.walls) if (w.levelId === l.id && Math.abs(w.height - l.height) < 0.01) w.height = height;
      l.height = height;
      l.slab = slab;
    }
    if (kept.length) restack(b);
    if (changed.length) {
      const names = changed.map((id) => {
        const l = b.levels.find((x) => x.id === id)!;
        return `${l.name} ${l.height.toFixed(2).replace('.', ',')} m`;
      });
      lines.push(`${c.name} : hauteurs sous plafond ${names.join(', ')}.`);
      for (const id of changed) fixedLevels.add(id);
    }
    if (sec.roof && !roofRead) {
      roofRead = true;
      const top = [...b.levels].sort((m, n) => n.elevation - m.elevation)[0];
      const ridge: 'x' | 'y' = fp && fp.x1 - fp.x0 >= fp.y1 - fp.y0 ? 'x' : 'y';
      if (b.roof) {
        b.roof.type = sec.roof.type;
        b.roof.pitch = sec.roof.type === 'plat' ? 0 : sec.roof.pitch;
      } else b.roof = { type: sec.roof.type, levelId: top.id, pitch: sec.roof.pitch, overhang: 0.3, ridge, coveringId: null, insulationId: null };
      lines.push(`Toiture : ${sec.roof.type === 'plat' ? 'toit plat' : `${sec.roof.type === 'deux-pans' ? 'deux pans' : 'monopente'}, pente ${sec.roof.pitch}°`}.`);
    }
  }
  return { lines, warnings, levelId: groundId ?? (done.size ? [...done][0] : null) };
}
