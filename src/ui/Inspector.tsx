import { isFlat } from '../model/dwelling';
import { LevelAlignPanel } from './LevelAlignPanel';
import { useMemo, useState } from 'react';
import {
  addFloorZone,
  canEditZone,
  editFloorZone,
  removeFloorZone,
  setFloorZoneProduct,
  setRoomHeights,
  setWallHeight,
  finishRoomWalls,
  moveFurniture,
  removeFurniture,
  removeOpening,
  removeWall,
  renameRoom,
  replaceOpening,
  removeRoofWindow,
  replaceRoofWindow,
  editRoofWindow,
  setCondition,
  setRoomFloor,
  setWallFinish,
  swapFurniture,
  editOpening,
  isAddedOpening,
  setFurnitureOptions,
  setOpeningOptions,
} from '../actions';
import { itemPrice, itemProduct } from '../model/generic';
import { GenericOptions } from './GenericOptions';
import { productById } from '../model/catalog';
import { euro } from '../model/estimate';
import { detectRooms, inRoom, newId, wallLength, wallSideFacingRoom } from '../model/geometry';
import { levelById } from '../model/levels';
import { areaAboveHeight, placeRoofWindow, ROOF_DEPTH, roofFrame, roofWindowHeight, roofWindowLength } from '../model/roof';
import type { FloorZone, Room, Wall, WallLayer, WallLayerKind, WallSide } from '../model/types';
import { cavityWall, describeLayers, layerInfo, LAYER_KINDS } from '../model/wallLayers';
import { useBuilding, useStore } from '../store';
import { useUi } from '../uiState';
import { ConditionField, DwellingField, HouseOverview, LevelPanel, RoofPanel } from './HousePanels';
import { ProductPicker } from './ProductPicker';
import { NumberInput } from './NumberInput';
import { UnderlayPanel } from './UnderlayPanel';
import { ViewpointPanel } from './ViewpointPanel';

const n2 = (n: number) => Math.round(n * 100) / 100;

function NumberField({ label, value, onChange, min = 0, max, disabled, title }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean; title?: string }) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      <NumberInput value={value} min={min} max={max} disabled={disabled} onChange={onChange} />
    </label>
  );
}

/** Panneau de droite : propriétés et catalogue de l'élément sélectionné. */
export function Inspector() {
  const selection = useStore((s) => s.selection);
  const step = useStore((s) => s.step);
  const building = useBuilding();
  const rooms = useMemo(() => detectRooms(building), [building]);
  const isExisting = step === 'existant';

  if (!selection) return <NoSelection />;
  if (selection.kind === 'viewpoint') return <ViewpointPanel key={selection.id} id={selection.id} />;
  if (selection.kind === 'roof') return <RoofPanel />;
  if (selection.kind === 'level') return <LevelPanel id={selection.id} />;

  if (selection.kind === 'wall') {
    const w = building.walls.find((x) => x.id === selection.id);
    return w ? <WallPanel key={`${w.id}-${selection.side ?? ''}`} w={w} rooms={rooms} isExisting={isExisting} initialSide={selection.side} /> : <NoSelection />;
  }
  if (selection.kind === 'room') {
    const r = rooms.find((x) => x.label.id === selection.id);
    return r ? <RoomPanel r={r} isExisting={isExisting} /> : <NoSelection />;
  }
  if (selection.kind === 'opening') {
    const o = building.openings.find((x) => x.id === selection.id);
    if (!o) return <NoSelection />;
    return <OpeningPanel id={o.id} isExisting={isExisting} />;
  }
  if (selection.kind === 'roofWindow') {
    const w = building.roof?.windows?.find((x) => x.id === selection.id);
    return w ? <RoofWindowPanel id={w.id} isExisting={isExisting} /> : <NoSelection />;
  }
  if (selection.kind === 'zone') {
    const z = building.floorZones?.find((x) => x.id === selection.id);
    return z ? <ZonePanel z={z} rooms={rooms} isExisting={isExisting} /> : <NoSelection />;
  }
  const f = building.furniture.find((x) => x.id === selection.id);
  return f ? <FurniturePanel id={f.id} /> : <NoSelection />;
}

function NoSelection() {
  const step = useStore((s) => s.step);
  const setTool = useStore((s) => s.setTool);
  const select = useStore((s) => s.select);
  const levelId = useStore((s) => s.levelId);
  const viewpoints = useStore((s) => s.project.viewpoints);
  const isPlan = step === 'existant' || step === 'projet';
  const here = viewpoints.filter((v) => v.levelId === levelId);
  const flat = useStore((s) => isFlat(s.project.existing));
  return (
    <div className="panel">
      <h3>{step === 'existant' ? (flat ? 'Votre appartement actuel' : 'Votre maison actuelle') : 'Votre projet'}</h3>
      <p className="muted">
        {step === 'existant'
          ? 'Importez un plan ou dessinez les murs, ajoutez portes et fenêtres, puis cliquez sur une pièce, un mur ou une menuiserie pour indiquer ses matériaux et son état.'
          : 'Cliquez sur un mur pour le démolir ou changer son revêtement, sur une pièce pour changer son sol, sur un meuble pour le remplacer. Chaque choix met le budget à jour.'}
      </p>
      {step === 'existant' && <DwellingField />}
      {step === 'existant' && <LevelAlignPanel />}
      {step === 'existant' && <UnderlayPanel />}
      {step === 'existant' && <HouseOverview />}
      {step === 'projet' && !flat && (
        <button className="btn" onClick={() => select({ kind: 'roof', id: 'roof' })}>
          Toiture et isolation…
        </button>
      )}
      {isPlan && (
        <>
          <h4>Points de vue (photos)</h4>
          {here.length === 0 && <p className="muted small">Outil « Point de vue » : cliquez dans le plan là où la photo a été prise, puis glissez dans la direction visée.</p>}
          <ul className="vp-list">
            {here.map((v, i) => (
              <li key={v.id}>
                <button className="link" onClick={() => select({ kind: 'viewpoint', id: v.id })}>
                  📷 {v.caption || `Point de vue ${i + 1}`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Ajouter un meuble, un sanitaire ou un escalier</h4>
      <ProductPicker
        categories={['meuble', 'escalier']}
        placeholder="« WC suspendu », « escalier chêne », « grand canapé pas trop foncé »…"
        onPick={(p) => setTool('furniture', p.id)}
      />
      <p className="muted small">Choisissez un élément puis cliquez dans le plan pour le poser. Un escalier monte vers le haut de son symbole.</p>
    </div>
  );
}

function WallPanel({ w, rooms, isExisting, initialSide }: { w: Wall; rooms: Room[]; isExisting: boolean; initialSide?: WallSide }) {
  const catalog = useStore((s) => s.catalog);
  const editExisting = useStore((s) => s.editExisting);
  const L = wallLength(w);
  const sides: { side: WallSide; room?: Room }[] = (['gauche', 'droite'] as WallSide[]).map((side) => ({
    side,
    room: rooms.find((r) => r.wallIds.includes(w.id) && wallSideFacingRoom(w, r) === side),
  }));
  const edit = (fn: (x: Wall) => void) =>
    editExisting((b) => {
      const x = b.walls.find((y) => y.id === w.id);
      if (x) fn(x);
    });
  // Face à revêtir : celle cliquée (visite 3D), sinon la première tournée vers une pièce.
  const [side, setSide] = useState<WallSide>(initialSide ?? sides.find((s) => s.room)?.side ?? 'gauche');
  const faceName = (s: { side: WallSide; room?: Room }) => (s.room ? `côté ${s.room.label.name}` : s.side === 'gauche' ? 'face A (extérieur)' : 'face B (extérieur)');
  const active = sides.find((s) => s.side === side)!;
  const current = productById(catalog, w.finish[side]);

  return (
    <div className="panel">
      <h3>{w.kind === 'porteur' ? 'Mur porteur' : 'Cloison'}</h3>
      <h4>Peinture et revêtement</h4>
      <div className="faces" role="radiogroup" aria-label="Face du mur">
        {sides.map((s) => {
          const p = productById(catalog, w.finish[s.side]);
          return (
            <button key={s.side} role="radio" aria-checked={s.side === side} className={`face ${s.side === side ? 'is-active' : ''}`} onClick={() => setSide(s.side)}>
              <i className="face__swatch" style={{ background: p?.color ?? 'repeating-linear-gradient(45deg,#eee 0 4px,#fff 4px 8px)' }} />
              <span>
                <small>{faceName(s)}</small>
                <strong>{p?.name ?? 'Enduit brut'}</strong>
              </span>
            </button>
          );
        })}
      </div>
      <p className="muted small">
        Choisissez ci-dessous la peinture, le papier peint ou la faïence de la face <strong>{faceName(active)}</strong>
        {current ? ` (actuellement : ${current.name})` : ''}. Dans la visite 3D, cliquez directement sur la face du mur à changer.
      </p>
      <ProductPicker compact categories={['peinture', 'mur', 'faience']} currentId={w.finish[side]} onPick={(p) => setWallFinish(w.id, side, p.id)} placeholder="« blanc mat », « vert sauge », « faïence métro »…" />
      {active.room && current && (
        <div className="actions">
          <button className="btn" onClick={() => finishRoomWalls(active.room!, current.id)} title="Même revêtement sur toutes les faces de murs de la pièce">
            Appliquer à tous les murs de {active.room.label.name}
          </button>
        </div>
      )}
      <h4>Dimensions</h4>
      <div className="fields">
        <NumberField
          label="Longueur (m)"
          value={L}
          disabled={!isExisting}
          onChange={(v) =>
            edit((x) => {
              const k = v / (L || 1);
              x.b = { x: x.a.x + (x.b.x - x.a.x) * k, y: x.a.y + (x.b.y - x.a.y) * k };
            })
          }
        />
        <NumberField label="Épaisseur (m)" value={w.thickness} disabled={!isExisting} onChange={(v) => edit((x) => void (x.thickness = v))} />
        <NumberField label="Hauteur (m)" value={w.height} min={0.3} max={12} onChange={(v) => setWallHeight(w.id, v)} title={isExisting ? undefined : 'Dans le projet, la nouvelle hauteur apparaît dans les modifications'} />
        {isExisting && (
          <label className="field">
            <span>Type</span>
            <select value={w.kind} onChange={(e) => edit((x) => void (x.kind = e.target.value as Wall['kind']))}>
              <option value="porteur">Porteur</option>
              <option value="cloison">Cloison</option>
            </select>
          </label>
        )}
      </div>
      <WallLayersField w={w} isExisting={isExisting} onEdit={edit} />
      {isExisting && <ConditionField value={w.condition} onChange={(c) => setCondition({ kind: 'wall', id: w.id }, c)} label="État (fissures, humidité…)" />}
      <div className="actions">
        <button className="btn btn--danger" onClick={() => removeWall(w.id)}>
          {isExisting ? 'Supprimer le mur' : w.kind === 'porteur' ? 'Démolir ce mur porteur' : 'Démolir cette cloison'}
        </button>
      </div>
      {!isExisting && w.kind === 'porteur' && <p className="warning">Mur porteur : une démolition demande une étude de stabilité et une poutre de reprise. Elles sont ajoutées au chiffrage.</p>}
    </div>
  );
}

/** Composition d'un mur à plusieurs couches (mur creux : brique, coulisse, bloc), de la face A à la face B. */
function WallLayersField({ w, isExisting, onEdit }: { w: Wall; isExisting: boolean; onEdit: (fn: (x: Wall) => void) => void }) {
  const layers = w.layers ?? [];
  const setLayers = (next: WallLayer[] | undefined) =>
    onEdit((x) => {
      if (!next?.length) delete x.layers;
      else {
        x.layers = next;
        x.thickness = Math.round(next.reduce((s, l) => s + l.thickness, 0) * 100) / 100;
      }
    });
  if (!layers.length)
    return isExisting ? (
      <div className="actions">
        <button className="btn" onClick={() => setLayers(cavityWall(w.thickness))} title="Mur creux : parement en brique, coulisse isolée et bloc béton">
          Décrire les couches du mur (mur creux…)
        </button>
      </div>
    ) : null;
  return (
    <>
      <h4>Composition</h4>
      <p className="muted small">De la face A à la face B : {describeLayers(layers)}.</p>
      {isExisting && (
        <div className="layers">
          {layers.map((l, i) => (
            <div key={i} className="layers__row">
              <i className="layers__swatch" style={{ background: layerInfo(l.kind).color }} />
              <select value={l.kind} aria-label={`Couche ${i + 1}`} onChange={(e) => setLayers(layers.map((x, j) => (j === i ? { ...x, kind: e.target.value as WallLayerKind } : x)))}>
                {LAYER_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <NumberInput value={Math.round(l.thickness * 100)} min={1} max={60} onChange={(v) => setLayers(layers.map((x, j) => (j === i ? { ...x, thickness: v / 100 } : x)))} />
              <span className="muted small">cm</span>
              <button className="btn btn--ghost" title="Retirer cette couche" onClick={() => setLayers(layers.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="actions">
            <button className="btn" onClick={() => setLayers([...layers, { kind: 'platre', thickness: 0.02 }])}>
              Ajouter une couche
            </button>
            <button className="btn" onClick={() => setLayers([...layers].reverse())} title="Les couches dans l'autre sens (brique dehors, bloc dedans)">
              Inverser
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function RoomPanel({ r, isExisting }: { r: Room; isExisting: boolean }) {
  const catalog = useStore((s) => s.catalog);
  const building = useBuilding();
  const floor = productById(catalog, r.label.floorProductId);
  const level = levelById(building, r.label.levelId);
  const under = useMemo(() => areaAboveHeight(building, r), [building, r]);
  return (
    <div className="panel">
      {isExisting ? (
        <input className="title-input" value={r.label.name} onChange={(e) => renameRoom(r, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      ) : (
        <h3>{r.label.name}</h3>
      )}
      <p className="muted">
        {r.area.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m² au sol · périmètre {r.perimeter.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m
        {level ? ` · ${level.name}` : ''}
      </p>
      {level && (
        <div className="fields">
          <NumberField
            label="Hauteur sous plafond (m)"
            value={r.label.ceilingHeight ?? level.height}
            min={1}
            max={12}
            title={`Par défaut celle du niveau (${level.height.toLocaleString('fr-BE')} m) ; une pièce peut avoir un plafond plus bas ou plus haut.`}
            onChange={(v) => setRoomHeights(r, { ceilingHeight: v })}
          />
          <NumberField
            label="Sol : décalage (m)"
            value={r.label.floorOffset ?? 0}
            min={-2}
            max={2}
            title="+0,15 : sol surélevé d'une marche ; −0,20 : pièce en contrebas"
            onChange={(v) => setRoomHeights(r, { floorOffset: v })}
          />
        </div>
      )}
      {under != null && (
        <p className="muted small">
          Sous toiture : {under.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m² avec plus de 1,80 m de hauteur libre.
        </p>
      )}
      <h4>Sol {floor ? `: ${floor.name}` : ''}</h4>
      {isExisting && <ConditionField value={r.label.floorCondition} onChange={(c) => setCondition({ kind: 'room', id: r.label.id, room: r }, c)} label="État du sol" />}
      <ProductPicker categories={['sol']} currentId={r.label.floorProductId} onPick={(p) => setRoomFloor(r, p.id)} placeholder="« bois clair », « carrelage gris grand format »…" />
      <div className="actions">
        <button className="btn" onClick={() => addFloorZone(zoneInside(r))} title="Un autre sol sur une partie de la pièce (coin cuisine, entrée…)">
          + Sol sur une partie de la pièce
        </button>
      </div>
      <p className="muted small">Ou outil « Zone de sol » : glissez dans le plan pour délimiter la partie à revêtir.</p>
      <h4>Peindre ou revêtir tous les murs de la pièce</h4>
      <p className="muted small">Pour un seul mur : cliquez sur ce mur (dans la visite 3D, sur la face voulue).</p>
      <ProductPicker compact categories={['peinture', 'mur', 'faience']} onPick={(p) => finishRoomWalls(r, p.id)} placeholder="« blanc mat », « greige »…" />
    </div>
  );
}

function OpeningPanel({ id, isExisting }: { id: string; isExisting: boolean }) {
  const building = useBuilding();
  const catalog = useStore((s) => s.catalog);
  const o = building.openings.find((x) => x.id === id)!;
  const wall = building.walls.find((w) => w.id === o.wallId);
  const product = productById(catalog, o.productId);
  // Taille modifiable à l'existant, et dans le projet pour une ouverture ajoutée
  const sizable = isExisting || isAddedOpening(id);
  const edit = (fn: (x: typeof o) => void) => editOpening(id, fn);
  const maxOffset = wall ? wallLength(wall) - o.width / 2 : 99;
  const step = useStore((s) => s.step);
  const toggled = useUi((s) => !!s.toggled[id]);
  const toggle = useUi((s) => s.toggle);
  // Dans la visite, les portes sont ouvertes par défaut et les fenêtres fermées.
  const open = o.kind === 'porte' ? !toggled : toggled;
  return (
    <div className="panel">
      <h3>{o.kind === 'porte' ? 'Porte' : 'Fenêtre'}</h3>
      {isExisting && (
        <div className="actions">
          <button
            className="btn"
            title="Le retraçage s'est trompé : changer la nature de l'ouverture"
            onClick={() =>
              edit((x) => {
                const toDoor = x.kind === 'fenetre';
                x.kind = toDoor ? 'porte' : 'fenetre';
                x.productId = toDoor ? 'ex-porte-isoplane' : 'ex-fenetre-bois-simple';
                x.height = toDoor ? 2.05 : 1.25;
                x.sill = toDoor ? 0 : 0.9;
                delete x.options;
                delete x.swing;
              })
            }
          >
            {o.kind === 'porte' ? "C'est une fenêtre" : "C'est une porte"}
          </button>
        </div>
      )}
      <p className="muted">{product ? `${itemProduct(catalog, o)?.name} · ${euro(itemPrice(product, o.options, { w: o.width, h: o.height }))}` : 'Produit non défini'}</p>
      {step === 'visite' && (
        <div className="actions">
          <button className="btn btn--primary" onClick={() => toggle(id)}>
            {open ? 'Fermer' : 'Ouvrir'}
          </button>
        </div>
      )}
      <div className="fields">
        <NumberField label="Largeur (m)" value={o.width} disabled={!sizable} onChange={(v) => edit((x) => void (x.width = Math.min(wall ? wallLength(wall) - 0.05 : v, Math.max(0.3, v))))} />
        <NumberField label="Hauteur (m)" value={o.height} disabled={!sizable} onChange={(v) => edit((x) => void (x.height = v))} />
        <NumberField label="Allège (m)" value={o.sill} disabled={!sizable} onChange={(v) => edit((x) => void (x.sill = v))} />
        <NumberField label="Position (m)" value={o.offset} disabled={!sizable} onChange={(v) => edit((x) => void (x.offset = Math.min(maxOffset, Math.max(o.width / 2, v))))} />
      </div>
      {product?.generic && <GenericOptions product={product} options={o.options} dims={{ w: o.width, h: o.height }} onChange={(opt) => setOpeningOptions(o.id, opt)} />}
      {o.kind === 'porte' && sizable && !product?.id.includes('garage') && (
        <>
          <h4>Sens d'ouverture</h4>
          <div className="actions">
            {(o.options?.leaves ?? 1) < 2 && (
              <button className="btn" title="La porte tourne sur l'autre montant" onClick={() => edit((x) => void (x.swing = { hinge: x.swing?.hinge === 'b' ? 'a' : 'b', side: x.swing?.side ?? 'gauche' }))}>
                Charnière de l'autre côté
              </button>
            )}
            <button className="btn" title="La porte s'ouvre vers l'autre pièce" onClick={() => edit((x) => void (x.swing = { hinge: x.swing?.hinge ?? 'a', side: x.swing?.side === 'droite' ? 'gauche' : 'droite' }))}>
              S'ouvre de l'autre côté
            </button>
          </div>
        </>
      )}
      {isExisting && <ConditionField value={o.condition} onChange={(c) => setCondition({ kind: 'opening', id: o.id }, c)} />}
      <h4>{isExisting ? 'Modèle actuel' : 'Remplacer par'}</h4>
      <ProductPicker categories={[o.kind === 'porte' ? 'porte' : 'fenetre']} only={(p) => p.subcategory !== 'toit'} currentId={o.productId} onPick={(p) => replaceOpening(o.id, p.id)} />
      <div className="actions">
        <button className="btn btn--danger" onClick={() => removeOpening(o.id)}>
          {isExisting ? 'Supprimer' : 'Supprimer et reboucher'}
        </button>
      </div>
    </div>
  );
}

function FurniturePanel({ id }: { id: string }) {
  const building = useBuilding();
  const catalog = useStore((s) => s.catalog);
  const f = building.furniture.find((x) => x.id === id)!;
  const base = productById(catalog, f.productId);
  const p = itemProduct(catalog, f);
  return (
    <div className="panel">
      <h3>{p?.name ?? 'Meuble'}</h3>
      <p className="muted">
        {p && base ? `${euro(itemPrice(base, f.options))} · ${Math.round((p.size?.w ?? 0) * 100)} × ${Math.round((p.size?.d ?? 0) * 100)} cm` : ''}
      </p>
      {base?.generic && <GenericOptions product={base} options={f.options} onChange={(opt) => setFurnitureOptions(f.id, opt)} />}
      <div className="actions">
        <button className="btn" onClick={() => moveFurniture(f.id, f.x, f.y, (f.rotation + 90) % 360)}>
          Pivoter (R)
        </button>
        <button className="btn btn--danger" onClick={() => removeFurniture(f.id)}>
          Retirer
        </button>
      </div>
      <h4>Remplacer par</h4>
      <ProductPicker categories={p?.category === 'escalier' ? ['escalier'] : ['meuble']} subcategory={p?.subcategory} currentId={f.productId} onPick={(np) => swapFurniture(f, np.id)} />
    </div>
  );
}

/** Zone de 1,2 × 1,2 m (ou moins) au centre d'une pièce. */
export function zoneInside(r: Room): FloorZone {
  const xs = r.polygon.map((p) => p.x);
  const ys = r.polygon.map((p) => p.y);
  const w = Math.min(1.2, (Math.max(...xs) - Math.min(...xs)) * 0.6);
  const h = Math.min(1.2, (Math.max(...ys) - Math.min(...ys)) * 0.6);
  const c = r.label.at;
  return { id: newId('z'), levelId: r.label.levelId, x: Math.round((c.x - w / 2) * 20) / 20, y: Math.round((c.y - h / 2) * 20) / 20, w: n2(w), h: n2(h), productId: null };
}

function ZonePanel({ z, rooms, isExisting }: { z: FloorZone; rooms: Room[]; isExisting: boolean }) {
  const catalog = useStore((s) => s.catalog);
  const product = productById(catalog, z.productId);
  const room = rooms.find((r) => r.label.levelId === z.levelId && inRoom({ x: z.x + z.w / 2, y: z.y + z.h / 2 }, r));
  const editable = canEditZone(z.id);
  const edit = (fn: (x: FloorZone) => void) => editFloorZone(z.id, fn);
  return (
    <div className="panel">
      <h3>Zone de sol{room ? ` · ${room.label.name}` : ''}</h3>
      <p className="muted">
        {(z.w * z.h).toLocaleString('fr-BE', { maximumFractionDigits: 2 })} m² · {product ? product.name : 'revêtement à choisir'}
      </p>
      <div className="fields">
        <NumberField label="Largeur (m)" value={z.w} min={0.1} disabled={!editable} onChange={(v) => edit((x) => void (x.w = v))} />
        <NumberField label="Profondeur (m)" value={z.h} min={0.1} disabled={!editable} onChange={(v) => edit((x) => void (x.h = v))} />
        <NumberField label="Position x (m)" value={z.x} min={-999} disabled={!editable} onChange={(v) => edit((x) => void (x.x = v))} />
        <NumberField label="Position y (m)" value={z.y} min={-999} disabled={!editable} onChange={(v) => edit((x) => void (x.y = v))} />
      </div>
      {editable && <p className="muted small">Glissez la zone dans le plan pour la déplacer, ou tirez sa poignée (coin bas droit) pour la redimensionner.</p>}
      {isExisting && <ConditionField value={z.condition} onChange={(c) => edit((x) => void (x.condition = c))} label="État du sol" />}
      <h4>{isExisting ? 'Revêtement actuel' : 'Revêtement'}</h4>
      <ProductPicker categories={['sol']} currentId={z.productId} onPick={(p) => setFloorZoneProduct(z.id, p.id)} placeholder="« carrelage », « parquet chêne »…" />
      <div className="actions">
        <button className="btn btn--danger" onClick={() => removeFloorZone(z.id)}>
          Supprimer la zone
        </button>
      </div>
    </div>
  );
}

/** Fenêtre de toit (Velux) : modèle, dimensions, position dans le pan. */
function RoofWindowPanel({ id, isExisting }: { id: string; isExisting: boolean }) {
  const building = useBuilding();
  const catalog = useStore((s) => s.catalog);
  const project = useStore((s) => s.project);
  const roof = building.roof!;
  const w = roof.windows!.find((x) => x.id === id)!;
  const product = productById(catalog, w.productId);
  const added = !isExisting && project.operations.some((o) => o.type === 'addRoofWindow' && o.window.id === id);
  const editable = isExisting || added;
  const f = roofFrame(building);
  const h = roofWindowHeight(roof, w.length);
  // Hauteur du bas et du haut de la fenêtre au-dessus du plancher (sous le rampant)
  const heights = (() => {
    if (!f) return null;
    const t = Math.tan((roof.pitch * Math.PI) / 180);
    const alongX = roof.ridge === 'x';
    const c = alongX ? w.y : w.x;
    const lo = alongX ? f.minY : f.minX;
    const hi = alongX ? f.maxY : f.maxX;
    const loSide = roof.type === 'monopente' || c < (lo + hi) / 2;
    const d = loSide ? c - lo : hi - c;
    const base = f.base - f.level.elevation - ROOF_DEPTH / Math.cos((roof.pitch * Math.PI) / 180);
    return { low: base + (d - w.length / 2) * t, high: base + (d + w.length / 2) * t };
  })();
  const resize = (width: number, height: number) =>
    editRoofWindow(id, (x) => {
      x.width = width;
      x.length = roofWindowLength(roof, height);
      const at = placeRoofWindow(building, x, x.width, x.length);
      if (at) Object.assign(x, at);
    });
  return (
    <div className="panel">
      <h3>Fenêtre de toit</h3>
      <p className="muted">{product ? `${product.name}${product.price ? ` · ${euro(product.price)}` : ''}` : 'Modèle non défini'}</p>
      <div className="fields">
        <NumberField label="Largeur (m)" value={w.width} min={0.4} max={2} disabled={!editable} onChange={(v) => resize(v, h)} />
        <NumberField label="Hauteur dans la pente (m)" value={Math.round(h * 100) / 100} min={0.5} max={2.5} disabled={!editable} onChange={(v) => resize(w.width, v)} />
      </div>
      {heights && (
        <p className="muted small">
          Bas de la fenêtre à {heights.low.toLocaleString('fr-BE', { maximumFractionDigits: 2 })} m du plancher, haut à {heights.high.toLocaleString('fr-BE', { maximumFractionDigits: 2 })} m
          {heights.low > 1.3 ? ' : trop haut pour voir dehors assis, rapprochez-la de l\'égout.' : heights.high < 1.85 ? ' : rapprochez-la du faîtage pour voir dehors debout.' : '.'}
        </p>
      )}
      <p className="muted small">{editable ? 'Glissez-la sur le plan pour la déplacer dans le pan.' : 'Fenêtre existante : remplacez-la ou supprimez-la.'}</p>
      {isExisting && <ConditionField value={w.condition} onChange={(c) => editRoofWindow(id, (x) => void (x.condition = c))} />}
      <h4>{isExisting ? 'Modèle actuel' : added ? 'Modèle' : 'Remplacer par'}</h4>
      <ProductPicker categories={['fenetre']} only={(p) => p.subcategory === 'toit'} currentId={w.productId} onPick={(p) => replaceRoofWindow(id, p.id)} placeholder="« velux 78 × 118 », « blanc », « grand »…" />
      <div className="actions">
        <button className="btn btn--danger" onClick={() => removeRoofWindow(id)}>
          {isExisting || added ? 'Supprimer' : 'Supprimer et refermer le toit'}
        </button>
      </div>
    </div>
  );
}
