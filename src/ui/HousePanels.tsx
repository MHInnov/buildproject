import { isFlat, setDwellingKind } from '../model/dwelling';
import { useMemo } from 'react';
import { NumberInput } from './NumberInput';
import { setCondition, setRoofCovering, setRoofInsulation } from '../actions';
import { productById } from '../model/catalog';
import { euro } from '../model/estimate';
import { detectRooms, newId } from '../model/geometry';
import { levelById, removeLevel } from '../model/levels';
import { areaAboveHeight, eaveForKnee, isSloped, kneeHeight, roofArea, roofFrame } from '../model/roof';
import { CONDITION_LABELS, ROOF_LABELS, type Building, type Condition, type Level, type RoofType } from '../model/types';
import { useBuilding, useStore } from '../store';
import { ProductPicker } from './ProductPicker';
import { APRONS, DEFAULT_APRON_WIDTH, DEFAULT_LAWN, LAWNS, TIMBERS } from '../data/exterior';

const m2 = (n: number) => `${n.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m²`;
const m = (n: number) => `${n.toLocaleString('fr-BE', { maximumFractionDigits: 2 })} m`;

/** Sélecteur d'état (bon, à rafraîchir, à remplacer) pour le relevé de l'existant. */
export function ConditionField({ value, onChange, label = 'État actuel' }: { value?: Condition; onChange: (c: Condition | undefined) => void; label?: string }) {
  return (
    <div className="condition">
      <span>{label}</span>
      <div className="segmented segmented--small">
        {(Object.keys(CONDITION_LABELS) as Condition[]).map((c) => (
          <button key={c} type="button" className={`${value === c ? 'is-active' : ''} cond--${c}`} onClick={() => onChange(value === c ? undefined : c)}>
            {CONDITION_LABELS[c]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Onglets des niveaux, au-dessus du plan. */
export function LevelTabs() {
  const levels = useStore((s) => s.project.existing.levels);
  const levelId = useStore((s) => s.levelId);
  const setLevel = useStore((s) => s.setLevel);
  const select = useStore((s) => s.select);
  const roof = useStore((s) => s.project.existing.roof);
  const flat = useStore((s) => isFlat(s.project.existing));
  const sorted = [...levels].sort((a, b) => b.elevation - a.elevation);
  return (
    <div className="levelbar no-print" role="tablist" aria-label="Niveaux">
      {roof && !flat && (
        <button className="levelbar__roof" onClick={() => select({ kind: 'roof', id: 'roof' })} title="Toiture">
          ⌂ Toit
        </button>
      )}
      {sorted.map((l) => (
        <button
          key={l.id}
          role="tab"
          aria-selected={l.id === levelId}
          className={l.id === levelId ? 'is-active' : ''}
          onClick={() => (l.id === levelId ? select({ kind: 'level', id: l.id }) : setLevel(l.id))}
          title={l.id === levelId ? 'Propriétés du niveau' : `Afficher ${l.name}`}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}

function nextLevel(b: Building, where: 'above' | 'below'): Level {
  const sorted = [...b.levels].sort((x, y) => x.elevation - y.elevation);
  if (where === 'above') {
    const top = sorted[sorted.length - 1];
    const n = sorted.filter((l) => l.elevation > 0).length + 1;
    return { id: newId('lv'), name: n === 1 ? '1er étage' : `${n}e étage`, elevation: Math.round((top.elevation + top.height + top.slab) * 100) / 100, height: 2.5, slab: 0.22 };
  }
  const bottom = sorted[0];
  return { id: newId('lv'), name: 'Cave', elevation: Math.round((bottom.elevation - 2.2 - 0.25) * 100) / 100, height: 2.2, slab: 0.25 };
}

/** Maison ou appartement, en tête du panneau de l'existant. */
export function DwellingField() {
  const b = useStore((s) => s.project.existing);
  const editExisting = useStore((s) => s.editExisting);
  const flat = isFlat(b);
  return (
    <>
      <h4>Type de logement</h4>
      <div className="segmented segmented--small" role="group" aria-label="Type de logement">
        <button className={!flat ? 'is-active' : ''} onClick={() => flat && editExisting((x) => setDwellingKind(x, 'maison'))}>
          Maison
        </button>
        <button className={flat ? 'is-active' : ''} onClick={() => !flat && editExisting((x) => setDwellingKind(x, 'appartement'))}>
          Appartement
        </button>
      </div>
      {flat && (
        <>
          <p className="muted small">Dans un immeuble : pas de toiture ni de jardin, le plafond du dernier niveau est la dalle de l'étage au-dessus.</p>
          <label className="field">
            <span>Étage dans l'immeuble</span>
            <select value={b.storey ?? 0} onChange={(e) => editExisting((x) => void (x.storey = Number(e.target.value)))}>
              {Array.from({ length: 21 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? 'Rez-de-chaussée' : i === 1 ? '1er étage' : `${i}e étage`}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </>
  );
}

/** Panneau « maison » : niveaux et toiture, quand rien n'est sélectionné à l'étape existant. */
export function HouseOverview() {
  const b = useStore((s) => s.project.existing);
  const editExisting = useStore((s) => s.editExisting);
  const setLevel = useStore((s) => s.setLevel);
  const select = useStore((s) => s.select);
  const addLevel = (where: 'above' | 'below') => {
    const l = nextLevel(b, where);
    editExisting((x) => {
      x.levels.push(l);
      // Les murs porteurs du niveau voisin sont repris : on part de la même enveloppe.
      const ref = [...x.levels].sort((p, q) => (where === 'above' ? q.elevation - p.elevation : p.elevation - q.elevation))[1];
      for (const w of x.walls.filter((w0) => w0.levelId === ref?.id && w0.kind === 'porteur')) {
        x.walls.push({ ...structuredClone(w), id: newId('w'), levelId: l.id, height: l.height, finish: { gauche: null, droite: null }, condition: undefined });
      }
    });
    setLevel(l.id);
  };
  const flat = isFlat(b);
  return (
    <>
      <h4>Niveaux</h4>
      <p className="muted small">Cliquez sur l'onglet du niveau affiché (en haut à droite du plan) pour régler sa hauteur sous plafond.</p>
      <div className="actions">
        <button className="btn" onClick={() => addLevel('above')}>{flat ? '+ Niveau au-dessus (duplex)' : '+ Étage ou combles'}</button>
        {!flat && <button className="btn" onClick={() => addLevel('below')}>+ Cave</button>}
      </div>
      {flat ? null : <h4>Toiture</h4>}
      {flat ? null : b.roof ? (
        <button className="btn" onClick={() => select({ kind: 'roof', id: 'roof' })}>
          {ROOF_LABELS[b.roof.type]} · {b.roof.pitch}° · {productById(useStore.getState().catalog, b.roof.coveringId)?.name ?? 'couverture ?'}
        </button>
      ) : (
        <button
          className="btn"
          onClick={() => {
            const top = [...b.levels].sort((p, q) => q.elevation - p.elevation)[0];
            editExisting((x) => void (x.roof = { type: 'deux-pans', levelId: top.id, pitch: 35, overhang: 0.3, ridge: 'x', coveringId: null, insulationId: null }));
            select({ kind: 'roof', id: 'roof' });
          }}
        >
          + Ajouter une toiture
        </button>
      )}
      {!flat && <OutdoorFields />}
      {!flat && b.site && (
        <>
          <h4>Jardin</h4>
          <p className="muted small">
            Parcelle de {Math.round(Math.abs(b.site.parcel.reduce((s, p, i) => s + p.x * b.site!.parcel[(i + 1) % b.site!.parcel.length].y - b.site!.parcel[(i + 1) % b.site!.parcel.length].x * p.y, 0)) / 2).toLocaleString('fr-FR')} m², lue sur le plan d'implantation.
          </p>
          <button className="btn" onClick={() => editExisting((x) => void delete x.site)}>
            Retirer le jardin
          </button>
        </>
      )}
    </>
  );
}

/** Extérieurs : sol du jardin et abords de la maison (rendu de la visite 3D). */
function OutdoorFields() {
  const o = useStore((s) => s.project.existing.outdoor);
  const editExisting = useStore((s) => s.editExisting);
  const edit = (fn: (x: NonNullable<Building['outdoor']>) => void) =>
    editExisting((b) => {
      b.outdoor ??= {};
      fn(b.outdoor);
    });
  return (
    <>
      <h4>Extérieurs</h4>
      <div className="fields">
        <label className="field">
          <span>Jardin</span>
          <select value={o?.lawn ?? DEFAULT_LAWN} onChange={(e) => edit((x) => void (x.lawn = e.target.value))}>
            {LAWNS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" title="Bande au pied des façades : terrasse, allée, gravier">
          <span>Abords de la maison</span>
          <select value={o?.apron ?? ''} onChange={(e) => edit((x) => void (x.apron = e.target.value || null))}>
            <option value="">Aucun (jardin jusqu'aux murs)</option>
            {APRONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {o?.apron && (
          <label className="field">
            <span>Largeur des abords (m)</span>
            <NumberInput min={0.3} max={8} value={o.apronWidth ?? DEFAULT_APRON_WIDTH} onChange={(v) => edit((x) => void (x.apronWidth = v))} />
          </label>
        )}
      </div>
    </>
  );
}

export function LevelPanel({ id }: { id: string }) {
  const b = useStore((s) => s.project.existing);
  const step = useStore((s) => s.step);
  const editExisting = useStore((s) => s.editExisting);
  const setLevel = useStore((s) => s.setLevel);
  const l = levelById(b, id);
  if (!l) return null;
  const ro = step !== 'existant';
  const edit = (fn: (x: Level, bb: Building) => void) =>
    editExisting((bb) => {
      const x = bb.levels.find((y) => y.id === id);
      if (x) fn(x, bb);
    });
  const rooms = detectRooms(b).filter((r) => r.label.levelId === id);
  return (
    <div className="panel">
      {ro ? <h3>{l.name}</h3> : <input className="title-input" value={l.name} onChange={(e) => edit((x) => void (x.name = e.target.value))} onKeyDown={(e) => e.stopPropagation()} />}
      <p className="muted">
        {rooms.length} pièce{rooms.length > 1 ? 's' : ''} · {m2(rooms.reduce((s, r) => s + r.area, 0))}
      </p>
      <div className="fields">
        <label className="field">
          <span>Hauteur sous plafond (m)</span>
          <NumberInput
            min={0.5}
            max={10}
            value={l.height}
            disabled={ro}
            onChange={(v) => {
              // Les murs du niveau suivent la nouvelle hauteur.
              edit((x, bb) => {
                for (const w of bb.walls) if (w.levelId === id && Math.abs(w.height - x.height) < 0.01) w.height = v;
                x.height = v;
              });
            }}
          />
        </label>
        <label className="field">
          <span>Altitude du sol (m)</span>
          <NumberInput value={l.elevation} disabled={ro} onChange={(v) => edit((x) => void (x.elevation = v))} />
        </label>
        <label className="field">
          <span>Épaisseur du plancher (m)</span>
          <NumberInput min={0.05} max={2} value={l.slab} disabled={ro} onChange={(v) => edit((x) => void (x.slab = v))} />
        </label>
      </div>
      <p className="muted small">Pour des combles, la hauteur sous plafond est celle des murs bas (jambettes) ; la toiture fait le reste.</p>
      {!ro && b.levels.length > 1 && (
        <div className="actions">
          <button
            className="btn btn--danger"
            onClick={() => {
              if (!confirm(`Supprimer « ${l.name} » et tout ce qu'il contient ?`)) return;
              editExisting((bb) => removeLevel(bb, id));
              setLevel(b.levels.find((x) => x.id !== id)!.id);
            }}
          >
            Supprimer ce niveau
          </button>
        </div>
      )}
    </div>
  );
}

export function RoofPanel() {
  const step = useStore((s) => s.step);
  const catalog = useStore((s) => s.catalog);
  const editExisting = useStore((s) => s.editExisting);
  const select = useStore((s) => s.select);
  const building = useBuilding();
  const existing = useStore((s) => s.project.existing);
  const roof = building.roof;
  const isExisting = step === 'existant';
  const info = useMemo(() => {
    if (!roof) return null;
    const f = roofFrame(building);
    const under = detectRooms(building).filter((r) => r.label.levelId === roof.levelId);
    const hab = under.reduce((s, r) => s + (areaAboveHeight(building, r) ?? 0), 0);
    return { f, area: roofArea(building), hab, under: under.reduce((s, r) => s + r.area, 0) };
  }, [building, roof]);
  if (!roof || !info) return null;
  const edit = (fn: (r: NonNullable<Building['roof']>) => void) => editExisting((b) => void (b.roof && fn(b.roof)));
  const covering = productById(catalog, roof.coveringId);
  const insulation = productById(catalog, roof.insulationId);
  return (
    <div className="panel">
      <h3>Toiture</h3>
      <p className="muted">
        {m2(info.area)} de couverture
        {info.f && roof.type !== 'plat' ? ` · faîte à ${m(info.f.base + info.f.rise)} du sol` : ''}
      </p>
      {roof.type !== 'plat' && info.under > 0 && (
        <p className="muted small">
          Sous la toiture : {m2(info.under)} au sol, dont {m2(info.hab)} avec plus de 1,80 m sous plafond.
        </p>
      )}
      {isExisting && (
        <>
          <div className="fields">
            <label className="field">
              <span>Forme</span>
              <select value={roof.type} onChange={(e) => edit((r) => void (r.type = e.target.value as RoofType))}>
                {(Object.keys(ROOF_LABELS) as RoofType[]).map((t) => (
                  <option key={t} value={t}>
                    {ROOF_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Repose sur</span>
              <select value={roof.levelId} onChange={(e) => edit((r) => void (r.levelId = e.target.value))}>
                {existing.levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {roof.type !== 'plat' && (
              <label className="field">
                <span>Pente (°)</span>
                <NumberInput
                  min={5}
                  max={70}
                  digits={0}
                  value={roof.pitch}
                  onChange={(v) =>
                    editExisting((b) => {
                      if (!b.roof) return;
                      // Étage sous combles : les murs extérieurs gardent leur hauteur sous la pente
                      const knee = kneeHeight(b, b.roof);
                      b.roof.pitch = v;
                      if (knee != null) b.roof.eave = eaveForKnee(b, b.roof, knee);
                    })
                  }
                />
              </label>
            )}
            <label className="field">
              <span>Débord (m)</span>
              <NumberInput min={0} max={3} value={roof.overhang} onChange={(v) => edit((r) => void (r.overhang = v))} />
            </label>
            {(roof.type === 'deux-pans' || roof.type === 'monopente') && (
              <label className="field">
                <span>Faîtage</span>
                <select value={roof.ridge} onChange={(e) => edit((r) => void (r.ridge = e.target.value as 'x' | 'y'))}>
                  <option value="x">Horizontal sur le plan</option>
                  <option value="y">Vertical sur le plan</option>
                </select>
              </label>
            )}
          </div>
          {isSloped(roof) && <AtticFields />}
          {isSloped(roof) && (
            <div className="fields">
              <label className="field" title="Bois des chevrons, pannes et faîtage, visibles dans la visite 3D">
                <span>Charpente</span>
                <select value={roof.timber ?? TIMBERS[0].id} onChange={(e) => edit((r) => void (r.timber = e.target.value))}>
                  {TIMBERS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {roof.eave != null && (
                <label className="toggle">
                  <input type="checkbox" checked={!!roof.exposedBeams} onChange={(e) => edit((r) => void (r.exposedBeams = e.target.checked || undefined))} /> Poutres apparentes
                </label>
              )}
            </div>
          )}
          <ConditionField value={roof.condition} onChange={(c) => setCondition({ kind: 'roof', id: 'roof' }, c)} />
        </>
      )}
      {isSloped(roof) && <RoofWindowsBlock />}
      <h4>
        {isExisting ? 'Couverture actuelle' : 'Nouvelle couverture'} {covering ? `: ${covering.name}` : ''}
      </h4>
      <ProductPicker compact categories={['toiture']} currentId={roof.coveringId} onPick={(p) => setRoofCovering(p.id)} placeholder="« ardoise », « tuiles anthracite »…" />
      <h4>
        {isExisting ? 'Isolation actuelle' : 'Isolation'} {insulation ? `: ${insulation.name}` : ''}
      </h4>
      <ProductPicker compact categories={['isolation']} currentId={roof.insulationId} onPick={(p) => setRoofInsulation(p.id)} />
      {!isExisting && covering && !covering.existingOnly && (
        <p className="muted small">
          Fourniture estimée : {euro(covering.price * info.area * (1 + (covering.waste ?? 0.08)))}
        </p>
      )}
      {isExisting && (
        <div className="actions">
          <button
            className="btn btn--danger"
            onClick={() => {
              editExisting((b) => void (b.roof = null));
              select(null);
            }}
          >
            Supprimer la toiture
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Étage sous combles (chambres mansardées) : le toit part plus bas que le haut des murs de l'étage, les murs
 * extérieurs côté égout sont en partie sous la pente et le rampant forme le plafond.
 */
function AtticFields() {
  const existing = useStore((s) => s.project.existing);
  const editExisting = useStore((s) => s.editExisting);
  const roof = existing.roof!;
  const knee = kneeHeight(existing, roof);
  const on = knee != null;
  const toggle = (v: boolean) =>
    editExisting((b) => {
      const r = b.roof;
      const l = r && levelById(b, r.levelId);
      if (!r || !l) return;
      if (!v) {
        delete r.eave;
        return;
      }
      let k = 1;
      // Ancienne saisie (niveau aussi haut que ses murs bas) : l'étage reprend une hauteur normale, ses murs bas deviennent la pente
      if (l.height < 1.8) {
        k = l.height;
        const old = l.height;
        l.height = 2.5;
        for (const w of b.walls) if (w.levelId === l.id && Math.abs(w.height - old) < 0.01) w.height = l.height;
      }
      r.eave = eaveForKnee(b, r, k);
    });
  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} /> Étage aménagé sous la pente (chambres mansardées)
      </label>
      {on && (
        <>
          <div className="fields">
            <label className="field" title="Hauteur, à l'intérieur, où la pente du toit rencontre les murs extérieurs côté gouttière">
              <span>Murs extérieurs sous la pente (m)</span>
              <NumberInput
                min={0}
                max={2.4}
                value={knee}
                onChange={(v) =>
                  editExisting((b) => {
                    if (b.roof) b.roof.eave = eaveForKnee(b, b.roof, v);
                  })
                }
              />
            </label>
          </div>
          <p className="muted small">
            Les murs extérieurs de l'étage côté gouttière s'arrêtent sous la pente, les pignons montent jusqu'au faîtage et le rampant fait le plafond. Les
            zones de moins de 1,80 m sont hachurées sur le plan. Pour la lumière, posez des fenêtres de toit.
          </p>
        </>
      )}
    </>
  );
}

/** Fenêtres de toit : nombre et bouton pour en poser (outil du plan, sur le niveau sous le toit). */
function RoofWindowsBlock() {
  const building = useBuilding();
  const setTool = useStore((s) => s.setTool);
  const setLevel = useStore((s) => s.setLevel);
  const select = useStore((s) => s.select);
  const roof = building.roof!;
  const n = roof.windows?.length ?? 0;
  return (
    <>
      <h4>Fenêtres de toit {n ? `(${n})` : ''}</h4>
      <div className="actions">
        <button
          className="btn"
          onClick={() => {
            setLevel(roof.levelId);
            select(null);
            setTool('roofWindow');
          }}
        >
          + Fenêtre de toit (Velux)
        </button>
        {(roof.windows ?? []).map((w, i) => (
          <button key={w.id} className="btn btn--small" onClick={() => select({ kind: 'roofWindow', id: w.id })}>
            n° {i + 1}
          </button>
        ))}
      </div>
    </>
  );
}
