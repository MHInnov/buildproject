import { useEffect } from 'react';
import { addFloorZone, addOpeningAt, moveFurniture, removeFloorZone, removeFurniture, removeOpening, removeWall, removeRoofWindow } from '../actions';
import { productById } from '../model/catalog';
import { detectRooms, newId, wallSideFacingRoom } from '../model/geometry';
import type { Building } from '../model/types';
import { useStore } from '../store';
import { useUi } from '../uiState';
import type { MenuTarget } from './BuildingMeshes';

interface Item {
  label: string;
  run: () => void;
  danger?: boolean;
}

const r05 = (n: number) => Math.round(n * 20) / 20;

/** Actions proposées au clic droit sur un élément de la visite 3D. */
function itemsFor(t: MenuTarget, b: Building): { title: string; items: Item[] } {
  const st = useStore.getState();
  const ui = useUi.getState();
  const select = st.select;
  const sel = t.sel;
  const isExisting = st.step === 'existant';
  if (sel.kind === 'furniture') {
    const f = b.furniture.find((x) => x.id === sel.id);
    if (!f) return { title: 'Meuble', items: [] };
    return {
      title: productById(st.catalog, f.productId)?.name ?? 'Meuble',
      items: [
        { label: 'Pivoter de 90°', run: () => moveFurniture(f.id, f.x, f.y, (f.rotation + 90) % 360) },
        { label: 'Remplacer par un autre modèle…', run: () => select(sel) },
        { label: 'Retirer', run: () => removeFurniture(f.id), danger: true },
      ],
    };
  }
  if (sel.kind === 'opening') {
    const o = b.openings.find((x) => x.id === sel.id);
    if (!o) return { title: 'Ouverture', items: [] };
    const open = o.kind === 'porte' && !o.productId?.includes('garage') ? !ui.toggled[o.id] : !!ui.toggled[o.id];
    return {
      title: o.kind === 'porte' ? 'Porte' : 'Fenêtre',
      items: [
        { label: open ? 'Fermer' : 'Ouvrir', run: () => ui.toggle(o.id) },
        { label: 'Remplacer par un autre modèle…', run: () => select(sel) },
        { label: isExisting ? 'Supprimer' : 'Supprimer et reboucher', run: () => removeOpening(o.id), danger: true },
      ],
    };
  }
  if (sel.kind === 'roofWindow') {
    return {
      title: 'Fenêtre de toit',
      items: [
        { label: 'Changer de modèle…', run: () => select(sel) },
        { label: isExisting ? 'Supprimer' : 'Supprimer et refermer le toit', run: () => removeRoofWindow(sel.id), danger: true },
      ],
    };
  }
  if (sel.kind === 'wall') {
    const w = b.walls.find((x) => x.id === sel.id);
    if (!w) return { title: 'Mur', items: [] };
    const room = sel.side ? detectRooms(b).find((r) => r.wallIds.includes(w.id) && wallSideFacingRoom(w, r) === sel.side) : undefined;
    return {
      title: w.kind === 'porteur' ? 'Mur porteur' : 'Cloison',
      items: [
        { label: room ? `Peindre / revêtir ce mur (côté ${room.label.name})…` : 'Peindre / revêtir ce mur…', run: () => select(sel) },
        { label: 'Changer la hauteur du mur…', run: () => select(sel) },
        { label: 'Ajouter une porte ici', run: () => {
          const id = addOpeningAt(w, t.at, 'porte');
          if (id) select({ kind: 'opening', id });
        } },
        { label: 'Ajouter une fenêtre ici', run: () => {
          const id = addOpeningAt(w, t.at, 'fenetre');
          if (id) select({ kind: 'opening', id });
        } },
        { label: isExisting ? 'Supprimer le mur' : 'Démolir ce mur', run: () => removeWall(w.id), danger: true },
      ],
    };
  }
  if (sel.kind === 'zone') {
    return {
      title: 'Zone de sol',
      items: [
        { label: 'Changer le revêtement…', run: () => select(sel) },
        { label: 'Supprimer la zone', run: () => removeFloorZone(sel.id), danger: true },
      ],
    };
  }
  if (sel.kind === 'room') {
    const room = detectRooms(b).find((r) => r.label.id === sel.id);
    const lit = !!ui.lights[sel.id];
    return {
      title: room?.label.name ?? 'Pièce',
      items: [
        { label: 'Changer le sol de la pièce…', run: () => select(sel) },
        { label: 'Poser un autre sol ici (zone)', run: () => {
          if (!room) return;
          addFloorZone({ id: newId('z'), levelId: room.label.levelId, x: r05(t.at.x - 0.6), y: r05(t.at.y - 0.6), w: 1.2, h: 1.2, productId: null });
        } },
        { label: 'Hauteur sous plafond, sol surélevé…', run: () => select(sel) },
        { label: 'Peindre tous les murs de la pièce…', run: () => select(sel) },
        { label: lit ? 'Éteindre la lumière' : 'Allumer la lumière', run: () => ui.toggleLight(sel.id) },
      ],
    };
  }
  return { title: '', items: [] };
}

export function VisitMenu({ target, building, onClose }: { target: MenuTarget; building: Building; onClose: () => void }) {
  const { title, items } = itemsFor(target, building);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  if (!items.length) return null;
  return (
    <>
      <div className="ctx-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="ctx-menu" role="menu" style={{ left: Math.min(target.screen.x, window.innerWidth - 300), top: Math.min(target.screen.y, window.innerHeight - 50 - items.length * 36) }}>
        <div className="ctx-menu__title">{title}</div>
        {items.map((it, i) => (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? 'is-danger' : ''}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
