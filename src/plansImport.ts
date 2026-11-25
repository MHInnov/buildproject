/**
 * Import de tout un dossier de plans d'un coup : plans de chaque niveau et coupes.
 * Chaque plan est retracé avec une échelle commune, calé sur le rez-de-chaussée, puis
 * les coupes donnent les hauteurs des niveaux et la forme du toit.
 */
import { fitImportedAttic, type Placement } from './atticImport';
import { newId } from './model/geometry';
import { removeLevel } from './model/levels';
import { levelOutline } from './model/footprint';
import { fitSite, readSitePlan } from './model/site';
import { alignFacades, alignWalls, footprint, guessKind, isFloorKind, looksLikeSection, planSimilarity, readSection, storeysFromSection, type PlanKind, type SectionReading } from './model/plans';
import { eaveForKnee } from './model/roof';
import type { Building, Level } from './model/types';
import { autoVectorize, type AutoVectorizeResult, type Bitmap, type TracedWall } from './model/vectorize';
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
  // Plan d'implantation : la maison en noir plein au milieu d'une parcelle bordée de longs traits
  const site = byName === 'implantation' || (!byName && byText !== 'coupe') ? readSitePlan(bmp) : null;
  if (byName === 'implantation' || (!byName && site?.parcel)) return { trace: null, section: null, hint: byName ?? byText, kind: 'implantation' };
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
  // Deux longs chevrons symétriques au-dessus des planchers : une coupe, même tournée sur la page
  else if (section?.roof?.type === 'deux-pans' && section.roof.pitch >= 20 && rooms < 5) kind = 'coupe';
  else if (rooms >= 2) kind = 'rdc'; // niveau précisé ensuite, dans l'ordre des fichiers
  else if (storeyLike) kind = 'coupe';
  else kind = 'ignorer';
  return { trace, section, hint: byName ?? byText, kind };
}

export { looksLikeSection };


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

export interface PageInfo {
  kind: PlanKind;
  /** Le nom du fichier, la page ou l'utilisateur ont indiqué le contenu. */
  hinted: boolean;
  name: string;
  walls: TracedWall[];
  rooms: number;
  /** Portes reconnues (arcs de débattement) : un plan d'étage en a, une coupe presque pas. */
  doors?: number;
  section: SectionReading | null;
}

/** Nombre de niveaux qu'une coupe laisse attendre : un par étage entre planchers, plus des combles sous un toit en pente. */
export function storeysOnSection(sec: SectionReading): number {
  return sec.slabs.length - 1 + (sec.roof && sec.roof.type !== 'plat' && sec.roof.pitch >= 20 ? 1 : 0);
}

/** Étages d'une coupe de hauteurs comparables (du simple au double au plus) : lecture vraisemblable. */
export function evenStoreys(sec: SectionReading): boolean {
  const up = [...sec.slabs].reverse();
  const gaps = up.slice(0, -1).map((low, i) => low.top - up[i + 1].bottom);
  return gaps.length < 2 || Math.max(...gaps) <= 2 * Math.min(...gaps);
}

/**
 * Classement de l'ensemble des pages : les plans sans indication prennent les niveaux libres dans l'ordre,
 * sauf une page qui montre le même niveau qu'une autre (le même plan dans deux documents) et les plans en
 * trop par rapport aux niveaux que montrent les coupes. Renvoie le classement et, s'il y a lieu, pourquoi
 * une page est écartée.
 */
/** Vraisemblance d'un plan d'étage : pièces fermées et portes reconnues. */
const plausible = (p: PageInfo) => p.rooms + (p.doors ?? 0) / 2;

export function classifyPages(pages: PageInfo[]): { kind: PlanKind; note?: string }[] {
  const out: { kind: PlanKind; note?: string }[] = pages.map((p) => ({ kind: p.kind }));
  const isPlan = isFloorKind;
  // Doublons : comparés aux pages indiquées d'abord, puis aux précédentes
  const order = pages.map((_, i) => i).sort((i, j) => Number(pages[j].hinted) - Number(pages[i].hinted) || i - j);
  const kept: number[] = [];
  for (const i of order) {
    const p = pages[i];
    if (!isPlan(out[i].kind) || p.walls.length < 4) {
      if (isPlan(out[i].kind)) kept.push(i);
      continue;
    }
    const twin = p.hinted ? undefined : kept.find((j) => planSimilarity(p.walls, pages[j].walls).similarity >= 0.5);
    if (twin !== undefined) out[i] = { kind: 'ignorer', note: `même plan que ${pages[twin].name}` };
    else kept.push(i);
  }
  // Niveaux attendus d'après les coupes : les plans non indiqués en trop sont écartés (les plus pauvres d'abord)
  // (une coupe dont les étages ont des hauteurs trop inégales est mal lue : on s'en méfie)
  const secs = pages.filter((p, i) => out[i].kind === 'coupe' && p.section).map((p) => p.section!);
  const sure = secs.filter(evenStoreys);
  const expected = sure.length ? Math.max(...sure.map(storeysOnSection)) : secs.length ? Math.min(...secs.map(storeysOnSection)) : 0;
  const plans = pages.map((_, i) => i).filter((i) => isPlan(out[i].kind));
  if (expected > 0 && plans.length > expected) {
    const loose = plans.filter((i) => !pages[i].hinted).sort((i, j) => plausible(pages[i]) - plausible(pages[j]));
    for (const i of loose.slice(0, plans.length - expected)) out[i] = { kind: 'ignorer', note: `en trop : les coupes montrent ${expected} niveau${expected > 1 ? 'x' : ''}` };
  }
  // Un seul plan d'implantation : le premier
  const sites = out.map((x, i) => (x.kind === 'implantation' ? i : -1)).filter((i) => i >= 0);
  for (const i of sites.slice(1)) out[i] = { kind: 'ignorer', note: `déjà un plan d'implantation (${pages[sites[0]].name})` };
  const kinds = spreadFloors(out.map((x, i) => ({ kind: x.kind, hinted: pages[i].hinted || !isPlan(x.kind) })));
  return out.map((x, i) => ({ ...x, kind: kinds[i] }));
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

const polygonArea = (p: { x: number; y: number }[]) => Math.abs(p.reduce((s, a, i) => s + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0)) / 2;

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
  const plans = items.filter((x) => isFloorKind(x.kind));
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
  /** Image et passage pixels → mètres de chaque niveau retracé (pour relire le plan ensuite). */
  const placedOn = new Map<string, Placement>();
  /** Échelle retenue pour chaque niveau retracé, et son plan. */
  const scaleUsed = new Map<string, { s: number; p: PlanInput }>();
  /** Niveaux dont les façades ont été reprises du niveau de référence (plan illisible). */
  const fromRef = new Set<string>();
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
      // Échelle seulement estimée et plan qui se superpose mal : l'estimation a pu se tromper nettement (plan
      // de combles fait surtout de pignons et de murs bas, page réduite). On relit le plan à d'autres échelles,
      // dont celle du niveau de référence, et on garde celle qui se superpose le mieux.
      // Emprise plausible : un étage couvre une bonne part du niveau de référence (des combles toute sa
      // longueur), jamais une petite fraction ni le double. Une lecture à la mauvaise échelle donne un étage
      // minuscule où le personnage paraît géant.
      const rb = footprint(target)!;
      const cover = (walls: NonNullable<typeof r>["walls"], kk: number) => {
        const fb = footprint(walls);
        return fb ? ((fb.x1 - fb.x0) * (fb.y1 - fb.y0) * kk * kk) / Math.max(1, (rb.x1 - rb.x0) * (rb.y1 - rb.y0)) : 0;
      };
      const implausible = (walls: NonNullable<typeof r>["walls"], kk: number) => {
        const c = cover(walls, kk);
        return c < 0.35 || c > 2.2;
      };
      if (!sure(p) && (al.fit < 0.35 || implausible(r.walls, al.k))) {
        const ref = refLevel ? scaleUsed.get(refLevel) : undefined;
        const tries = [s * 0.62, s * 1.6, ...(ref && sameSize(ref.p, p) ? [ref.s] : [])];
        // Échelle qui donnerait la même emprise que le niveau de référence
        const c0 = cover(r.walls, 1);
        if (c0 > 0 && implausible(r.walls, al.k)) tries.push(s * Math.sqrt(c0));
        // à superposition égale, on préfère la lecture qui n'a pas besoin d'être remise à l'échelle et dont
        // l'emprise est plausible
        const q = (x: { fit: number; k: number }, walls: NonNullable<typeof r>["walls"]) => x.fit - 0.15 * Math.abs(Math.log(x.k)) - (implausible(walls, x.k) ? 0.5 : 0);
        let qBest = q(al, r.walls);
        for (const sc of tries) {
          const alt = autoVectorize(p.bmp, { scale: sc / p.k });
          if (!alt?.walls.length) continue;
          const fa2 = alignFacades(alt.walls, target);
          const al2 = fa2 && fa2.fit >= 0.3 ? fa2 : alignWalls(alt.walls, target, false);
          const q2 = q(al2, alt.walls);
          if (al2.fit > 0.15 && q2 > Math.max(qBest, -0.3) + 0.03) {
            r = alt;
            s = sc;
            al = al2;
            qBest = q2;
          }
        }
      }
      let rescaled = false;
      if (al.fit > 0.2 && al.k !== 1) {
        // Nouvelle échelle : on relit le plan à cette échelle (portes, épaisseurs, raccords en dépendent)
        const again = autoVectorize(p.bmp, { scale: (s * al.k) / p.k, style: r.style });
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
    scaleUsed.set(level.id, { s: s * k, p });
    // Étage lu beaucoup plus petit que le niveau de référence (page réduite, trait trop chargé) : plutôt qu'un
    // étage minuscule où le personnage paraît géant, on reprend les façades du niveau de référence ; le plan
    // reste affiché dessous pour tracer les cloisons.
    const fbr = footprint(r.walls);
    const rbr = target.length ? footprint(target) : null;
    const coverRef = fbr && rbr ? ((fbr.x1 - fbr.x0) * (fbr.y1 - fbr.y0) * k * k) / Math.max(1, (rbr.x1 - rbr.x0) * (rbr.y1 - rbr.y0)) : 1;
    if (target.length && coverRef < 0.5 && target.some((w) => w.thickness >= 0.2)) {
      const old = new Set(b.walls.filter((w) => w.levelId === level.id).map((w) => w.id));
      b.walls = b.walls.filter((w) => !old.has(w.id));
      b.openings = b.openings.filter((o) => !old.has(o.wallId));
      for (const w of target.filter((x) => x.thickness >= 0.2)) {
        b.walls.push({ ...structuredClone(w), id: newId('w'), levelId: level.id, height: level.height, finish: { gauche: null, droite: null }, condition: undefined });
      }
      fromRef.add(level.id);
      warnings.push(`${p.name} : ${level.name} mal lu (${Math.round(coverRef * 100)} % de l'emprise du niveau du dessous) ; façades reprises du rez-de-chaussée, cloisons à tracer sur le plan affiché dessous (ou importez le plan de l'étage seul).`);
    } else {
      applyTrace(b, level.id, r, dx, dy, k);
      placedOn.set(level.id, { bmp: p.bmp, scale: r.scale, k, dx, dy });
    }
    level.underlay = { assetId: p.assetId, x: dx, y: dy, scale: s * k, width: p.width, height: p.height, opacity: 0.35, visible: true, calibrated: !!calibrated.find((u) => sameSize(u, p)) };
    done.add(level.id);
    if (level.id === g.id) groundId = level.id;
    anchorId ??= level.id;
    const doors = scaled.openings.filter((o) => o.kind === 'porte').length;
    const windows = scaled.openings.filter((o) => o.kind === 'fenetre').length;
    lines.push(`${level.name} (${p.name}) : ${scaled.walls.length} murs, ${doors} portes, ${windows} fenêtres, ${scaled.rooms} pièces${note ? `,${note}` : ''}${trusted(p) ? ', échelle lue sur le PDF' : ''}.`);
  }
  // Un import qui comprend le rez-de-chaussée décrit toute la maison : les niveaux au-dessus du dernier plan
  // retracé (combles d'un ancien dessin, étages de l'exemple) disparaissent.
  if (groundId) {
    const topImported = Math.max(...[...done].map((id) => b.levels.find((l) => l.id === id)!.elevation));
    const extra = b.levels.filter((l) => !done.has(l.id) && l.elevation > topImported);
    for (const l of extra) {
      removeLevel(b, l.id);
      lines.push(`${l.name} : retiré (aucun plan pour ce niveau).`);
    }
  }
  restack(b);

  // Coupes : hauteurs sous plafond, planchers, toit
  const g = groundLevel(b);
  const gw = b.walls.filter((w) => w.levelId === g.id);
  const fp = footprint(gw);
  const fixedLevels = new Set<string>();
  const roofs: (NonNullable<SectionReading['roof']> & { eave: number | null })[] = [];
  let roofEave: number | null = null;
  /** Bas de la mansarde lu sur une coupe : hauteur, depuis le plancher des combles, où le toit rencontre les murs. */
  let sectionKnee: number | null = null;
  // Les coupes les plus simples d'abord (moins de planchers) : une coupe en demi-niveaux se lit moins bien
  const readings = sections.map((c) => ({ c, sec: readSection(c.bmp) })).sort((m, n) => (m.sec?.slabs.length ?? 99) - (n.sec?.slabs.length ?? 99));
  for (const { c, sec } of readings) {
    if (!sec) {
      warnings.push(`${c.name} : planchers non reconnus sur cette coupe.`);
      continue;
    }
    // La coupe traverse la maison dans sa longueur ou sa largeur (faces extérieures des murs)
    const sizes = fp ? [fp.x1 - fp.x0 + 0.3, fp.y1 - fp.y0 + 0.3] : [];
    // À défaut d'échelle lue sur la coupe : celle retenue pour un plan de même format, le rez-de-chaussée d'abord
    const fallback = plans.filter((p) => sameSize(p, c)).sort((m, n) => Number(n.kind === 'rdc') - Number(m.kind === 'rdc'))[0];
    const used = fallback && [...scaleUsed.values()].find((u) => u.p === fallback);
    const fs = c.knownScale ?? used?.s ?? (fallback ? (scaleOf(fallback) ?? undefined) : undefined);
    if (!sizes.length && !fs) {
      warnings.push(`${c.name} : importez aussi le plan du rez-de-chaussée pour connaître l'échelle de la coupe.`);
      continue;
    }
    // Échelle lue sur le PDF de la coupe : prioritaire sur les dimensions des plans
    const read = storeysFromSection(sec, c.knownScale ? [] : sizes, fs ? fs / c.k : undefined);
    const { scale } = read;
    let storeys = read.storeys;
    const notes: string[] = [];
    // Un dernier « étage » très bas sous un toit en pente : c'est le bas de la mansarde (la pièce est en pente
    // côté extérieur, sous le toit), pas un étage mal lu.
    const top = storeys[storeys.length - 1];
    if (storeys.length >= 2 && sec.roof && sec.roof.type !== 'plat' && top.height >= 0.4 && top.height < 2) {
      sectionKnee ??= top.height;
      notes.push(`bas de la mansarde à ${top.height.toFixed(2).replace('.', ',')} m sous la pente`);
      storeys = storeys.slice(0, -1);
    }
    // Un premier niveau très bas : vide sanitaire ou demi-niveau, pas une pièce
    while (storeys.length >= 2 && storeys[0].height < 1.8) {
      notes.push(`vide sanitaire ou demi-niveau de ${storeys[0].height.toFixed(2).replace('.', ',')} m ignoré`);
      storeys = storeys.slice(1);
    }
    if (notes.length) lines.push(`${c.name} : ${notes.join(', ')}.`);
    // Hauteurs invraisemblables : la coupe est mal lue (ou ne passe pas où l'on croit)
    if (storeys.some((x) => x.height < 2 || x.height > 4.2)) {
      warnings.push(`${c.name} : hauteurs d'étage non reconnues (${storeys.map((x) => x.height.toFixed(2).replace('.', ',')).join(', ')} m), non retenues : réglez-les dans l'onglet du niveau.`);
      if (sec.roof) roofs.push({ ...sec.roof, eave: null });
      continue;
    }
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
    if (sec.roof) roofs.push({ ...sec.roof, eave: sec.roof.eavePx != null ? sec.roof.eavePx * scale : null });
  }

  // Toit : la lecture la plus nette (deux pans d'abord), l'égout le plus bas des coupes qui en donnent un
  if (roofs.length) {
    const kind = roofs.some((x) => x.type === 'deux-pans') ? 'deux-pans' : roofs[0].type;
    const same = roofs.filter((x) => x.type === kind);
    const pitch = kind === 'plat' ? 0 : Math.round(median(same.map((x) => x.pitch)));
    const eaves = same.map((x) => x.eave).filter((x): x is number => x != null);
    const top = [...b.levels].sort((m, n) => n.elevation - m.elevation)[0];
    const ridge: 'x' | 'y' = fp && fp.x1 - fp.x0 >= fp.y1 - fp.y0 ? 'x' : 'y';
    if (b.roof) {
      b.roof.type = kind;
      b.roof.pitch = pitch;
      b.roof.levelId = top.id;
    } else b.roof = { type: kind, levelId: top.id, pitch, overhang: 0.3, ridge, coveringId: null, insulationId: null };
    delete b.roof.eave;
    delete b.roof.bounds;
    roofEave = eaves.length ? Math.min(...eaves) : null;
    lines.push(`Toiture : ${kind === 'plat' ? 'toit plat' : `${kind === 'deux-pans' ? 'deux pans' : 'monopente'}, pente ${pitch}°`}.`);
  }

  // Combles aménagés : le dernier niveau retracé n'a de murs que sur deux côtés opposés (les pignons)
  const atticLine = fitImportedAttic(b, placedOn, roofEave, !roofs.length);
  if (atticLine) lines.push(atticLine);
  // Bas de mansarde lu sur une coupe alors que le plan n'a pas suffi : le dernier niveau devient un étage
  // sous la pente, ses murs extérieurs s'arrêtant sous le toit à cette hauteur.
  if (sectionKnee != null && b.roof && b.roof.type !== 'plat' && b.roof.eave == null) {
    const top = [...b.levels].sort((m, n) => n.elevation - m.elevation)[0];
    if (top.id !== groundLevel(b).id && b.roof.levelId === top.id) {
      b.roof.eave = eaveForKnee(b, b.roof, sectionKnee);
      lines.push(`${top.name} : étage sous la pente, murs extérieurs à ${sectionKnee.toFixed(2).replace('.', ',')} m sous le toit (lu sur la coupe).`);
    }
  }
  // Dernier niveau repris des façades sous un toit en pente : étage sous combles (murs bas de 1 m par défaut)
  if (b.roof && b.roof.type !== 'plat' && b.roof.eave == null) {
    const top = [...b.levels].sort((m, n) => n.elevation - m.elevation)[0];
    if (fromRef.has(top.id) && b.roof.levelId === top.id) {
      b.roof.eave = eaveForKnee(b, b.roof, 1);
      if (top.name === '1er étage') top.name = 'Étage sous combles';
      lines.push(`${top.name} : étage sous la pente, murs extérieurs à 1 m sous le toit (à ajuster dans Toiture).`);
    }
  }

  // Jardin : parcelle du plan d'implantation, calée sur l'emprise du rez-de-chaussée
  for (const it of items.filter((x) => x.kind === 'implantation').slice(0, 1)) {
    const reading = readSitePlan(it.bmp);
    const g = groundLevel(b);
    const fit = reading && fitSite(reading, levelOutline(b.walls.filter((w) => w.levelId === g.id)));
    if (!reading) warnings.push(`${it.name} : maison en noir introuvable, jardin non tracé.`);
    else if (!fit) warnings.push(`${it.name} : la maison dessinée ne correspond pas au rez-de-chaussée, jardin non tracé.`);
    else if (!reading.parcel) warnings.push(`${it.name} : contour de la parcelle illisible, jardin non tracé.`);
    else {
      const parcel = reading.parcel.map(fit.toPlan).map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
      b.site = { parcel };
      lines.push(`${it.name} : jardin tracé, parcelle de ${Math.round(polygonArea(parcel)).toLocaleString('fr-FR')} m² autour de la maison.`);
    }
  }
  return { lines, warnings, levelId: groundId ?? (done.size ? [...done][0] : null) };
}
