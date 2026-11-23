import { useMemo } from 'react';
import {
  finishRoomWalls,
  moveFurniture,
  removeFurniture,
  removeOpening,
  removeWall,
  renameRoom,
  replaceOpening,
  setRoomFloor,
  setWallFinish,
  swapFurniture,
} from '../actions';
import { productById } from '../model/catalog';
import { euro } from '../model/estimate';
import { detectRooms, wallLength, wallSideFacingRoom } from '../model/geometry';
import type { Room, Wall, WallSide } from '../model/types';
import { useBuilding, useStore } from '../store';
import { ProductPicker } from './ProductPicker';

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
  const f = building.furniture.find((x) => x.id === selection.id);
  return f ? <FurniturePanel id={f.id} /> : <NoSelection />;
}

function NoSelection() {
  const step = useStore((s) => s.step);
  const setTool = useStore((s) => s.setTool);
  return (
    <div className="panel">
      <h3>{step === 'existant' ? 'Votre maison actuelle' : 'Votre projet'}</h3>
      <p className="muted">
        {step === 'existant'
          ? 'Dessinez les murs ou tracez des pièces, ajoutez portes et fenêtres, puis cliquez sur une pièce ou un mur pour indiquer ses matériaux.'
          : 'Cliquez sur un mur pour le démolir ou le repeindre, sur une pièce pour changer son sol, sur un meuble pour le remplacer. Chaque choix met le budget à jour.'}
      </p>
      <h4>Ajouter un meuble</h4>
      <ProductPicker
        categories={['meuble']}
        placeholder="« grand canapé pas trop foncé », « table bois »…"
        onPick={(p) => setTool('furniture', p.id)}
      />
      <p className="muted small">Choisissez un meuble puis cliquez dans le plan pour le poser.</p>
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
            <ProductPicker compact categories={['peinture', 'faience']} currentId={w.finish[side]} onPick={(p) => setWallFinish(w.id, side, p.id)} />
          </details>
        );
      })}
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
  const floor = productById(catalog, r.label.floorProductId);
  return (
    <div className="panel">
      {isExisting ? (
        <input className="title-input" value={r.label.name} onChange={(e) => renameRoom(r, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      ) : (
        <h3>{r.label.name}</h3>
      )}
      <p className="muted">
        {r.area.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m² au sol · périmètre {r.perimeter.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m
      </p>
      <h4>Sol {floor ? `: ${floor.name}` : ''}</h4>
      <ProductPicker categories={['sol']} currentId={r.label.floorProductId} onPick={(p) => setRoomFloor(r, p.id)} placeholder="« bois clair », « carrelage gris grand format »…" />
      <details className="sub">
        <summary>Revêtir tous les murs de la pièce</summary>
        <ProductPicker compact categories={['peinture', 'faience']} onPick={(p) => finishRoomWalls(r, p.id)} />
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
  return (
    <div className="panel">
      <h3>{o.kind === 'porte' ? 'Porte' : 'Fenêtre'}</h3>
      <p className="muted">{product ? `${product.name} · ${euro(product.price)}` : 'Produit non défini'}</p>
      <div className="fields">
        <NumberField label="Largeur (m)" value={o.width} disabled={!isExisting} onChange={(v) => edit((x) => void (x.width = v))} />
        <NumberField label="Hauteur (m)" value={o.height} disabled={!isExisting} onChange={(v) => edit((x) => void (x.height = v))} />
        <NumberField label="Allège (m)" value={o.sill} disabled={!isExisting} onChange={(v) => edit((x) => void (x.sill = v))} />
        <NumberField label="Position (m)" value={o.offset} disabled={!isExisting} onChange={(v) => edit((x) => void (x.offset = Math.min(maxOffset, Math.max(o.width / 2, v))))} />
      </div>
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
      <ProductPicker categories={['meuble']} subcategory={p?.subcategory} currentId={f.productId} onPick={(np) => swapFurniture(f, np.id)} />
    </div>
  );
}
