import { useMemo } from 'react';
import {
  addFloorZone,
  canEditZone,
  editFloorZone,
  removeFloorZone,
  setFloorZoneProduct,
  finishRoomWalls,
  moveFurniture,
  removeFurniture,
  removeOpening,
  removeWall,
  renameRoom,
  replaceOpening,
  setCondition,
  setRoomFloor,
  setWallFinish,
  swapFurniture,
} from '../actions';
import { productById } from '../model/catalog';
import { euro } from '../model/estimate';
import { detectRooms, inRoom, newId, wallLength, wallSideFacingRoom } from '../model/geometry';
import { levelById } from '../model/levels';
import { areaAboveHeight } from '../model/roof';
import type { FloorZone, Room, Wall, WallSide } from '../model/types';
import { useBuilding, useStore } from '../store';
import { useUi } from '../uiState';
import { ConditionField, HouseOverview, LevelPanel, RoofPanel } from './HousePanels';
import { ProductPicker } from './ProductPicker';
import { UnderlayPanel } from './UnderlayPanel';
import { ViewpointPanel } from './ViewpointPanel';

const n2 = (n: number) => Math.round(n * 100) / 100;

function NumberField({ label, value, onChange, step = 0.01, min = 0, disabled }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; disabled?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        value={n2(value)}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min) onChange(v);
        }}
      />
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
    return w ? <WallPanel w={w} rooms={rooms} isExisting={isExisting} /> : <NoSelection />;
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
  return (
    <div className="panel">
      <h3>{step === 'existant' ? 'Votre maison actuelle' : 'Votre projet'}</h3>
      <p className="muted">
        {step === 'existant'
          ? 'Importez un plan ou dessinez les murs, ajoutez portes et fenêtres, puis cliquez sur une pièce, un mur ou une menuiserie pour indiquer ses matériaux et son état.'
          : 'Cliquez sur un mur pour le démolir ou changer son revêtement, sur une pièce pour changer son sol, sur un meuble pour le remplacer. Chaque choix met le budget à jour.'}
      </p>
      {step === 'existant' && <UnderlayPanel />}
      {step === 'existant' && <HouseOverview />}
      {step === 'projet' && (
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

function WallPanel({ w, rooms, isExisting }: { w: Wall; rooms: Room[]; isExisting: boolean }) {
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

  return (
    <div className="panel">
      <h3>{w.kind === 'porteur' ? 'Mur porteur' : 'Cloison'}</h3>
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
        <NumberField label="Hauteur (m)" value={w.height} disabled={!isExisting} onChange={(v) => edit((x) => void (x.height = v))} />
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
      {sides.map(({ side, room }) => {
        const current = productById(catalog, w.finish[side]);
        return (
          <details key={side} className="sub">
            <summary>
              Face côté {room ? room.label.name : side === 'gauche' ? 'A' : 'B'} : <strong>{current?.name ?? 'non définie'}</strong>
            </summary>
            <ProductPicker compact categories={['peinture', 'mur', 'faience']} currentId={w.finish[side]} onPick={(p) => setWallFinish(w.id, side, p.id)} />
          </details>
        );
      })}
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
        {level ? ` · ${level.name}, ${level.height.toLocaleString('fr-BE')} m sous plafond` : ''}
      </p>
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
      <details className="sub">
        <summary>Revêtir tous les murs de la pièce</summary>
        <ProductPicker compact categories={['peinture', 'mur', 'faience']} onPick={(p) => finishRoomWalls(r, p.id)} />
      </details>
    </div>
  );
}

function OpeningPanel({ id, isExisting }: { id: string; isExisting: boolean }) {
  const building = useBuilding();
  const catalog = useStore((s) => s.catalog);
  const editExisting = useStore((s) => s.editExisting);
  const o = building.openings.find((x) => x.id === id)!;
  const wall = building.walls.find((w) => w.id === o.wallId);
  const product = productById(catalog, o.productId);
  const edit = (fn: (x: typeof o) => void) =>
    editExisting((b) => {
      const x = b.openings.find((y) => y.id === id);
      if (x) fn(x);
    });
  const maxOffset = wall ? wallLength(wall) - o.width / 2 : 99;
  const step = useStore((s) => s.step);
  const toggled = useUi((s) => !!s.toggled[id]);
  const toggle = useUi((s) => s.toggle);
  // Dans la visite, les portes sont ouvertes par défaut et les fenêtres fermées.
  const open = o.kind === 'porte' ? !toggled : toggled;
  return (
    <div className="panel">
      <h3>{o.kind === 'porte' ? 'Porte' : 'Fenêtre'}</h3>
      <p className="muted">{product ? `${product.name} · ${euro(product.price)}` : 'Produit non défini'}</p>
      {step === 'visite' && (
        <div className="actions">
          <button className="btn btn--primary" onClick={() => toggle(id)}>
            {open ? 'Fermer' : 'Ouvrir'}
          </button>
        </div>
      )}
      <div className="fields">
        <NumberField label="Largeur (m)" value={o.width} disabled={!isExisting} onChange={(v) => edit((x) => void (x.width = v))} />
        <NumberField label="Hauteur (m)" value={o.height} disabled={!isExisting} onChange={(v) => edit((x) => void (x.height = v))} />
        <NumberField label="Allège (m)" value={o.sill} disabled={!isExisting} onChange={(v) => edit((x) => void (x.sill = v))} />
        <NumberField label="Position (m)" value={o.offset} disabled={!isExisting} onChange={(v) => edit((x) => void (x.offset = Math.min(maxOffset, Math.max(o.width / 2, v))))} />
      </div>
      {isExisting && <ConditionField value={o.condition} onChange={(c) => setCondition({ kind: 'opening', id: o.id }, c)} />}
      <h4>{isExisting ? 'Modèle actuel' : 'Remplacer par'}</h4>
      <ProductPicker categories={[o.kind === 'porte' ? 'porte' : 'fenetre']} currentId={o.productId} onPick={(p) => replaceOpening(o.id, p.id)} />
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
  const p = productById(catalog, f.productId);
  return (
    <div className="panel">
      <h3>{p?.name ?? 'Meuble'}</h3>
      <p className="muted">
        {p ? `${euro(p.price)} · ${Math.round((p.size?.w ?? 0) * 100)} × ${Math.round((p.size?.d ?? 0) * 100)} cm` : ''}
      </p>
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
