import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addFloorZone,
  addFurniture,
  addOpeningAt,
  addRoofWindowAt,
  canEditZone,
  editFloorZone,
  editRoofWindow,
  moveFurniture,
  removeFloorZone,
  removeFurniture,
  removeOpening,
  removeRoofWindow,
  removeViewpoint,
  removeWall,
  updateViewpoint,
} from '../actions';
import { useAsset } from '../assets';
import { productById, type Product } from '../model/catalog';
import { levelBelow, levelById, onLevel } from '../model/levels';
import { groundLevel } from '../traceApply';
import { isSloped, placeRoofWindow, ROOF_DEPTH, roofFrame, roofWindowHeight, roofWindowRect } from '../model/roof';
import { patternTile, patternUrl } from '../textures/patterns';
import { useUi } from '../uiState';
import { projectDiff } from '../model/diff';
import {
  detectRooms,
  dist,
  insertWall,
  lerp,
  newId,
  projectOnSegment,
  samePoint,
  snapAngle,
  snapPoint,
  splitWall,
  wallLength,
  wallNormal,
  wallSideFacingRoom,
} from '../model/geometry';
import type { Building, FloorZone, Opening, Point, Viewpoint, Wall, WallKind, WallSide } from '../model/types';
import { useBuilding, useStore } from '../store';

interface View {
  x: number;
  y: number;
  w: number;
}

type Drag =
  | { kind: 'pan'; start: Point; view: View; screen: Point }
  | { kind: 'furniture'; id: string; dx: number; dy: number; x: number; y: number; rotation: number; moved: boolean }
  | { kind: 'node'; from: Point; to: Point }
  | { kind: 'room'; start: Point; end: Point }
  | { kind: 'underlay'; start: Point; x: number; y: number; dx: number; dy: number }
  | { kind: 'viewpoint'; id: string; mode: 'move' | 'turn'; x: number; y: number; direction: number; moved: boolean }
  | { kind: 'zone'; start: Point; end: Point }
  | { kind: 'zoneMove'; id: string; dx: number; dy: number; x: number; y: number; moved: boolean }
  | { kind: 'zoneSize'; id: string; w: number; h: number }
  | { kind: 'roofWindow'; id: string; dx: number; dy: number; x: number; y: number; moved: boolean }
  | null;

/** Menu du clic droit. */
interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
}
interface ContextMenu {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
}

const DIMS_KEY = 'construprojet:cotes';
const r05 = (n: number) => Math.round(n * 20) / 20;

const fmtM = (n: number) => `${n.toLocaleString('fr-BE', { maximumFractionDigits: 2 })} m`;

export function PlanEditor({ wallKind }: { wallKind: WallKind }) {
  const full = useBuilding();
  const levelId = useStore((s) => s.levelId);
  const building = useMemo(() => onLevel(full, levelId), [full, levelId]);
  const level = levelById(full, levelId) ?? full.levels[0];
  const lower = useMemo(() => {
    const l = levelBelow(full, levelId);
    return l ? onLevel(full, l.id) : null;
  }, [full, levelId]);
  const underlay = levelById(useStore((s) => s.project.existing), levelId)?.underlay;
  const underlaySrc = useAsset(underlay?.assetId);
  const ui = useUi();
  const project = useStore((s) => s.project);
  const catalog = useStore((s) => s.catalog);
  const step = useStore((s) => s.step);
  const tool = useStore((s) => s.tool);
  const pendingProductId = useStore((s) => s.pendingProductId);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const setTool = useStore((s) => s.setTool);
  const isExisting = step === 'existant';

  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ x: -1.5, y: -1.5, w: 14 });
  const [cursor, setCursor] = useState<Point | null>(null);
  const [wallStart, setWallStart] = useState<Point | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [showDims, setShowDims] = useState(() => {
    try {
      return localStorage.getItem(DIMS_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleDims = () => {
    setShowDims((v) => {
      try {
        localStorage.setItem(DIMS_KEY, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  const rooms = useMemo(() => detectRooms(building), [building]);
  const diff = useMemo(() => (isExisting ? null : projectDiff(project)), [isExisting, project]);
  const viewH = (view.w * size.h) / size.w;
  const fs = (view.w / size.w) * 13; // taille de texte en mètres (~13 px à l'écran)

  // Taille de l'écran
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cadrage initial sur le bâtiment
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || (building.walls.length === 0 && !underlay) || size.w === 800) return;
    fitted.current = true;
    fit(building);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, size]);

  function fit(b: Building) {
    const xs = b.walls.flatMap((w) => [w.a.x, w.b.x]);
    const ys = b.walls.flatMap((w) => [w.a.y, w.b.y]);
    if (underlay?.visible) {
      xs.push(underlay.x, underlay.x + underlay.width * underlay.scale);
      ys.push(underlay.y, underlay.y + underlay.height * underlay.scale);
    }
    if (!xs.length) return;
    const minX = Math.min(...xs) - 1.5;
    const maxX = Math.max(...xs) + 1.5;
    const minY = Math.min(...ys) - 1.5;
    const maxY = Math.max(...ys) + 1.5;
    const w = Math.max(maxX - minX, ((maxY - minY) * size.w) / size.h);
    setView({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - (w * size.h) / size.w / 2, w });
  }

  // Zoom à la molette (écouteur non passif pour bloquer le défilement de la page)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width;
      const fy = (e.clientY - rect.top) / rect.height;
      setView((v) => {
        const k = Math.exp(e.deltaY * 0.0015);
        const w = Math.min(80, Math.max(2, v.w * k));
        const h = (v.w * rect.height) / rect.width;
        const nh = (w * rect.height) / rect.width;
        return { x: v.x + fx * (v.w - w), y: v.y + fy * (h - nh), w };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'Escape') {
        setMenu(null);
        setWallStart(null);
        setDrag(null);
        if (tool !== 'select') setTool('select');
        else select(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        e.preventDefault();
        if (selection.kind === 'viewpoint') removeViewpoint(selection.id);
        if (selection.kind === 'wall') removeWall(selection.id);
        if (selection.kind === 'opening') removeOpening(selection.id);
        if (selection.kind === 'furniture') removeFurniture(selection.id);
        if (selection.kind === 'zone') removeFloorZone(selection.id);
      }
      if ((e.key === 'r' || e.key === 'R') && selection?.kind === 'furniture') {
        const f = building.furniture.find((x) => x.id === selection.id);
        if (f) moveFurniture(f.id, f.x, f.y, (f.rotation + 90) % 360);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, selection, building, select, setTool]);

  useEffect(() => setWallStart(null), [tool, step, levelId]);
  // Recadrage quand on change de niveau ou qu'un plan est importé
  useEffect(() => {
    if (size.w !== 800) fit(building);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelId, underlay?.assetId]);

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: view.x + ((e.clientX - rect.left) / rect.width) * view.w, y: view.y + ((e.clientY - rect.top) / rect.height) * viewH };
  };

  const nearestWall = (p: Point, max = 0.35): { wall: Wall; t: number } | null => {
    let best: { wall: Wall; t: number; d: number } | null = null;
    for (const w of building.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.d < max && (!best || pr.d < best.d)) best = { wall: w, t: pr.t, d: pr.d };
    }
    return best;
  };

  function commitWall(a: Point, b: Point, kind: WallKind) {
    if (dist(a, b) < 0.05) return;
    const wall: Wall = {
      id: newId('w'),
      levelId,
      a,
      b,
      kind,
      thickness: kind === 'porteur' ? 0.3 : 0.1,
      height: level?.height ?? 2.6,
      finish: { gauche: null, droite: null },
    };
    if (isExisting) useStore.getState().editExisting((bld) => insertWall(bld, wall));
    else useStore.getState().addOperation({ type: 'addWall', wall: { ...wall, kind: 'cloison', thickness: 0.1 } });
  }

  function placeOpening(p: Point, kind: 'porte' | 'fenetre') {
    const hit = nearestWall(p);
    if (!hit) return;
    const id = addOpeningAt(hit.wall, p, kind);
    setTool('select');
    if (id) select({ kind: 'opening', id });
  }

  // ----- Événements -----
  // Point de vue sélectionné : un clic n'importe où sur le plan (même sur une pièce ou un meuble) l'y place,
  // un glisser donne la direction de la photo. Échap pour terminer.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (!isExisting || tool !== 'select' || e.button !== 0 || selection?.kind !== 'viewpoint') return;
    if ((e.target as Element).closest?.('[data-vp]')) return;
    const v = project.viewpoints.find((x) => x.id === selection.id);
    if (!v) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const raw = toWorld(e);
    const at = { x: Math.round(raw.x * 20) / 20, y: Math.round(raw.y * 20) / 20 };
    if (v.levelId !== levelId) updateViewpoint(v.id, (x) => void (x.levelId = levelId));
    setDrag({ kind: 'viewpoint', id: v.id, mode: 'turn', x: at.x, y: at.y, direction: v.direction, moved: true });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (menu) setMenu(null);
    if (e.button === 2) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const raw = toWorld(e);
    const p = snapPoint(raw, building);
    if (tool === 'select' && ui.moveUnderlay && underlay && e.button === 0) {
      setDrag({ kind: 'underlay', start: raw, x: underlay.x, y: underlay.y, dx: 0, dy: 0 });
      return;
    }
    if (e.button === 1 || tool === 'select') {
      setDrag({ kind: 'pan', start: raw, view, screen: { x: e.clientX, y: e.clientY } });
      if (e.button !== 1) select(null);
      return;
    }
    if (tool === 'calibrate') {
      const pts = ui.calibration.length >= 2 ? [] : ui.calibration;
      ui.set({ calibration: [...pts, raw] });
      return;
    }
    if (tool === 'viewpoint' && isExisting) {
      const v: Viewpoint = { id: newId('v'), levelId, x: Math.round(raw.x * 20) / 20, y: Math.round(raw.y * 20) / 20, direction: 0, fov: 66, eye: 1.5, assetId: null, caption: '' };
      useStore.getState().updateProject((pr) => void pr.viewpoints.push(v));
      setTool('select');
      select({ kind: 'viewpoint', id: v.id });
      setDrag({ kind: 'viewpoint', id: v.id, mode: 'turn', x: v.x, y: v.y, direction: 0, moved: false });
      return;
    }
    if (tool === 'wall') {
      if (!wallStart) setWallStart(p);
      else {
        const end = e.shiftKey ? p : snapAngle(wallStart, p);
        const endSnapped = samePoint(end, p) ? p : end;
        commitWall(wallStart, endSnapped, wallKind);
        setWallStart(endSnapped);
      }
    } else if (tool === 'room') {
      setDrag({ kind: 'room', start: p, end: p });
    } else if (tool === 'zone') {
      const q = { x: r05(raw.x), y: r05(raw.y) };
      setDrag({ kind: 'zone', start: q, end: q });
    } else if (tool === 'door' || tool === 'window') {
      placeOpening(raw, tool === 'door' ? 'porte' : 'fenetre');
    } else if (tool === 'roofWindow') {
      const id = addRoofWindowAt(raw);
      if (id) {
        setTool('select');
        select({ kind: 'roofWindow', id });
      }
    } else if (tool === 'furniture' && pendingProductId) {
      const id = addFurniture(pendingProductId, Math.round(raw.x * 20) / 20, Math.round(raw.y * 20) / 20);
      setTool('select');
      select({ kind: 'furniture', id });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const raw = toWorld(e);
    const p = snapPoint(raw, building);
    setCursor(tool === 'wall' && wallStart && !e.shiftKey ? snapAngle(wallStart, p) : p);
    if (!drag) return;
    if (drag.kind === 'pan') {
      const rect = svgRef.current!.getBoundingClientRect();
      const k = drag.view.w / rect.width;
      setView({ ...drag.view, x: drag.view.x - (e.clientX - drag.screen.x) * k, y: drag.view.y - (e.clientY - drag.screen.y) * k });
    } else if (drag.kind === 'furniture') {
      const x = Math.round((raw.x - drag.dx) * 20) / 20;
      const y = Math.round((raw.y - drag.dy) * 20) / 20;
      setDrag({ ...drag, x, y, moved: true });
    } else if (drag.kind === 'roofWindow') {
      const w = full.roof?.windows?.find((x) => x.id === drag.id);
      const q = w && placeRoofWindow(full, { x: raw.x - drag.dx, y: raw.y - drag.dy }, w.width, w.length);
      if (q) setDrag({ ...drag, x: q.x, y: q.y, moved: true });
    } else if (drag.kind === 'node') {
      setDrag({ ...drag, to: snapPoint(raw, { ...building, walls: building.walls.filter((w) => !samePoint(w.a, drag.from) && !samePoint(w.b, drag.from)) }) });
    } else if (drag.kind === 'room') {
      setDrag({ ...drag, end: p });
    } else if (drag.kind === 'zone') {
      setDrag({ ...drag, end: { x: r05(raw.x), y: r05(raw.y) } });
    } else if (drag.kind === 'zoneMove') {
      setDrag({ ...drag, x: r05(raw.x - drag.dx), y: r05(raw.y - drag.dy), moved: true });
    } else if (drag.kind === 'zoneSize') {
      const z = building.floorZones?.find((x) => x.id === drag.id);
      if (z) setDrag({ ...drag, w: Math.max(0.1, r05(raw.x - z.x)), h: Math.max(0.1, r05(raw.y - z.y)) });
    } else if (drag.kind === 'underlay') {
      setDrag({ ...drag, dx: raw.x - drag.start.x, dy: raw.y - drag.start.y });
    } else if (drag.kind === 'viewpoint') {
      if (drag.mode === 'move') setDrag({ ...drag, x: Math.round(raw.x * 20) / 20, y: Math.round(raw.y * 20) / 20, moved: true });
      else if (dist(raw, drag) > 0.1) setDrag({ ...drag, direction: Math.round((Math.atan2(raw.y - drag.y, raw.x - drag.x) * 180) / Math.PI), moved: true });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    if (drag.kind === 'furniture' && drag.moved) moveFurniture(drag.id, drag.x, drag.y, drag.rotation);
    if (drag.kind === 'roofWindow' && drag.moved) {
      const { x, y } = drag;
      editRoofWindow(drag.id, (w) => Object.assign(w, { x, y }));
    }
    if (drag.kind === 'underlay' && (drag.dx || drag.dy)) {
      const { x, y, dx, dy } = drag;
      useStore.getState().editExisting((b) => {
        const l = b.levels.find((m) => m.id === levelId);
        if (l?.underlay) Object.assign(l.underlay, { x: x + dx, y: y + dy });
      });
    }
    if (drag.kind === 'viewpoint' && drag.moved) {
      const { x, y, direction } = drag;
      updateViewpoint(drag.id, (v) => Object.assign(v, { x, y, direction }));
    }
    if (drag.kind === 'node' && !samePoint(drag.from, drag.to)) {
      const { from, to } = drag;
      useStore.getState().editExisting((b) => {
        for (const w of b.walls) {
          if (w.levelId !== levelId) continue;
          if (samePoint(w.a, from)) w.a = { ...to };
          if (samePoint(w.b, from)) w.b = { ...to };
        }
        b.walls = b.walls.filter((w) => wallLength(w) > 0.02);
      });
    }
    if (drag.kind === 'zone') {
      const { start: s, end: t } = drag;
      if (Math.abs(t.x - s.x) >= 0.1 && Math.abs(t.y - s.y) >= 0.1) {
        setTool('select');
        addFloorZone({ id: newId('z'), levelId, x: Math.min(s.x, t.x), y: Math.min(s.y, t.y), w: r05(Math.abs(t.x - s.x)), h: r05(Math.abs(t.y - s.y)), productId: null });
      }
    }
    if (drag.kind === 'zoneMove' && drag.moved) {
      const { x, y } = drag;
      editFloorZone(drag.id, (z) => Object.assign(z, { x, y }));
    }
    if (drag.kind === 'zoneSize') {
      const { w, h } = drag;
      editFloorZone(drag.id, (z) => Object.assign(z, { w, h }));
    }
    if (drag.kind === 'room') {
      const { start: s, end: t } = drag;
      if (Math.abs(t.x - s.x) > 0.3 && Math.abs(t.y - s.y) > 0.3) {
        const c = [s, { x: t.x, y: s.y }, t, { x: s.x, y: t.y }];
        const kind: WallKind = isExisting ? wallKind : 'cloison';
        for (let i = 0; i < 4; i++) commitWall(c[i], c[(i + 1) % 4], kind);
        if (isExisting) {
          const n = building.rooms.length + 1;
          useStore.getState().editExisting((b) =>
            void b.rooms.push({ id: newId('r'), levelId, at: { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 }, name: `Pièce ${n}`, floorProductId: null }),
          );
        }
      }
    }
    setDrag(null);
  };

  const onDoubleClick = () => setWallStart(null);

  // ----- Clic droit -----
  const openMenu = (e: React.MouseEvent, title: string, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
    setMenu({ x: e.clientX, y: e.clientY, title, items });
  };
  const at = (e: React.MouseEvent) => toWorld(e);
  const zoneAt = (p: Point): FloorZone => ({ id: newId('z'), levelId, x: r05(p.x - 0.6), y: r05(p.y - 0.6), w: 1.2, h: 1.2, productId: null });

  const wallMenu = (e: React.MouseEvent, w: Wall) => {
    const p = at(e);
    select({ kind: 'wall', id: w.id });
    const faces = (['gauche', 'droite'] as WallSide[]).flatMap((side) => {
      const room = rooms.find((r) => r.wallIds.includes(w.id) && wallSideFacingRoom(w, r) === side);
      return room ? [{ label: `Peindre / revêtir côté ${room.label.name}…`, run: () => select({ kind: 'wall', id: w.id, side }) }] : [];
    });
    const items: MenuItem[] = [
      ...faces,
      { label: 'Hauteur et dimensions…', run: () => select({ kind: 'wall', id: w.id }) },
      { label: 'Ajouter une porte ici', run: () => placeOpening(p, 'porte') },
      { label: 'Ajouter une fenêtre ici', run: () => placeOpening(p, 'fenetre') },
    ];
    if (isExisting) {
      items.push({
        label: 'Couper le mur ici',
        run: () => useStore.getState().editExisting((b) => splitWall(b, w.id, p)),
      });
      items.push({ label: w.kind === 'porteur' ? 'Changer en cloison' : 'Changer en mur porteur', run: () => useStore.getState().editExisting((b) => {
        const x = b.walls.find((y) => y.id === w.id);
        if (x) Object.assign(x, x.kind === 'porteur' ? { kind: 'cloison', thickness: 0.1 } : { kind: 'porteur', thickness: 0.3 });
      }) });
    }
    items.push({ label: isExisting ? 'Supprimer le mur' : 'Démolir ce mur', run: () => removeWall(w.id), danger: true });
    openMenu(e, w.kind === 'porteur' ? 'Mur porteur' : 'Cloison', items);
  };
  const openingMenu = (e: React.MouseEvent, o: Opening) => {
    select({ kind: 'opening', id: o.id });
    openMenu(e, o.kind === 'porte' ? 'Porte' : 'Fenêtre', [
      { label: isExisting ? 'Modèle et dimensions…' : 'Remplacer par un autre modèle…', run: () => select({ kind: 'opening', id: o.id }) },
      { label: isExisting ? 'Supprimer' : 'Supprimer et reboucher', run: () => removeOpening(o.id), danger: true },
    ]);
  };
  const furnitureMenu = (e: React.MouseEvent, id: string) => {
    const f = building.furniture.find((x) => x.id === id);
    if (!f) return;
    select({ kind: 'furniture', id });
    openMenu(e, productById(catalog, f.productId)?.name ?? 'Meuble', [
      { label: 'Pivoter de 90°', run: () => moveFurniture(f.id, f.x, f.y, (f.rotation + 90) % 360) },
      { label: 'Dupliquer', run: () => select({ kind: 'furniture', id: addFurniture(f.productId, f.x + 0.3, f.y + 0.3, f.rotation) }) },
      { label: 'Remplacer par…', run: () => select({ kind: 'furniture', id }) },
      { label: 'Retirer', run: () => removeFurniture(f.id), danger: true },
    ]);
  };
  const roofWindowMenu = (e: React.MouseEvent, id: string) => {
    select({ kind: 'roofWindow', id });
    openMenu(e, 'Fenêtre de toit', [
      { label: 'Changer de modèle…', run: () => select({ kind: 'roofWindow', id }) },
      { label: isExisting ? 'Supprimer' : 'Supprimer et refermer le toit', run: () => removeRoofWindow(id), danger: true },
    ]);
  };
  const roomMenu = (e: React.MouseEvent, roomId: string, name: string) => {
    const p = at(e);
    select({ kind: 'room', id: roomId });
    openMenu(e, name, [
      { label: 'Changer le sol de la pièce…', run: () => select({ kind: 'room', id: roomId }) },
      { label: 'Poser un autre sol sur une partie ici', run: () => addFloorZone(zoneAt(p)) },
      { label: 'Tracer une zone de sol…', run: () => setTool('zone') },
      { label: 'Revêtir tous les murs…', run: () => select({ kind: 'room', id: roomId }) },
    ]);
  };
  const zoneMenu = (e: React.MouseEvent, z: FloorZone) => {
    select({ kind: 'zone', id: z.id });
    openMenu(e, 'Zone de sol', [
      { label: 'Changer le revêtement…', run: () => select({ kind: 'zone', id: z.id }) },
      { label: 'Supprimer la zone', run: () => removeFloorZone(z.id), danger: true },
    ]);
  };
  const viewpointMenu = (e: React.MouseEvent, v: Viewpoint) => {
    select({ kind: 'viewpoint', id: v.id });
    openMenu(
      e,
      v.caption || 'Point de vue',
      isExisting
        ? [
            { label: 'Photo et réglages…', run: () => select({ kind: 'viewpoint', id: v.id }) },
            { label: 'Supprimer le point de vue', run: () => removeViewpoint(v.id), danger: true },
          ]
        : [
            { label: 'Voir la photo du projet', run: () => {
              useUi.getState().set({ viewFrom: v.id });
              useStore.getState().setStep('visite');
            } },
          ],
    );
  };
  /** Pendant le tracé d'un mur, le clic droit sur un élément termine aussi le mur. */
  const ctx = (fn: (e: React.MouseEvent) => void) => (e: React.MouseEvent) => {
    if (tool === 'wall' && wallStart) return;
    fn(e);
  };
  const backgroundMenu = (e: React.MouseEvent) => {
    if (tool === 'wall' && wallStart) {
      // Pendant le tracé d'un mur, le clic droit termine le mur (comme avant).
      e.preventDefault();
      setWallStart(null);
      return;
    }
    const p = snapPoint(at(e), building);
    openMenu(e, 'Plan', [
      { label: 'Commencer un mur ici', run: () => {
        setTool('wall');
        setTimeout(() => setWallStart(p), 0);
      } },
      { label: 'Tracer une pièce', run: () => setTool('room') },
      { label: 'Tracer une zone de sol', run: () => setTool('zone') },
      ...(isExisting
        ? [{ label: 'Point de vue photo ici', run: () => {
            const v: Viewpoint = { id: newId('v'), levelId, x: r05(p.x), y: r05(p.y), direction: 0, fov: 66, eye: 1.5, assetId: null, caption: '' };
            useStore.getState().updateProject((pr) => void pr.viewpoints.push(v));
            select({ kind: 'viewpoint', id: v.id });
          } }]
        : []),
      { label: showDims ? 'Masquer les cotes des murs' : 'Afficher les cotes des murs', run: toggleDims },
      { label: 'Recadrer sur la maison', run: () => fit(building) },
    ]);
  };

  // ----- Rendu -----
  const furniture = building.furniture.map((f) =>
    drag?.kind === 'furniture' && drag.id === f.id ? { ...f, x: drag.x, y: drag.y } : f,
  );
  const walls =
    drag?.kind === 'node'
      ? building.walls.map((w) => ({
          ...w,
          a: samePoint(w.a, drag.from) ? drag.to : w.a,
          b: samePoint(w.b, drag.from) ? drag.to : w.b,
        }))
      : building.walls;

  const isSel = (kind: string, id: string) => selection?.kind === kind && selection.id === id;
  const selectedWall = selection?.kind === 'wall' ? walls.find((w) => w.id === selection.id) : undefined;

  const cursorClass = tool === 'select' ? (drag?.kind === 'pan' || drag?.kind === 'underlay' ? 'grabbing' : ui.moveUnderlay && underlay ? 'move' : 'default') : 'crosshair';
  const zones = (building.floorZones ?? []).map((z) =>
    drag?.kind === 'zoneMove' && drag.id === z.id ? { ...z, x: drag.x, y: drag.y } : drag?.kind === 'zoneSize' && drag.id === z.id ? { ...z, w: drag.w, h: drag.h } : z,
  );
  const center = (() => {
    const xs = walls.flatMap((w) => [w.a.x, w.b.x]);
    const ys = walls.flatMap((w) => [w.a.y, w.b.y]);
    return xs.length ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 } : { x: 0, y: 0 };
  })();
  const floorProducts = [...new Set([...rooms.map((r) => r.label.floorProductId), ...zones.map((z) => z.productId)].filter(Boolean))].map((id) => productById(catalog, id)).filter((p): p is Product => !!p);
  const viewpoints = project.viewpoints
    .filter((v) => v.levelId === levelId)
    .map((v) => (drag?.kind === 'viewpoint' && drag.id === v.id ? { ...v, x: drag.x, y: drag.y, direction: drag.direction } : v));
  const stairsBelow = lower ? lower.furniture.filter((f) => productById(catalog, f.productId)?.category === 'escalier') : [];
  const ul = underlay && drag?.kind === 'underlay' ? { ...underlay, x: drag.x + drag.dx, y: drag.y + drag.dy } : underlay;

  const zoom = (k: number) =>
    setView((v) => {
      const w = Math.min(80, Math.max(2, v.w * k));
      return { x: v.x + (v.w - w) / 2, y: v.y + ((v.w - w) * size.h) / size.w / 2, w };
    });

  return (
    <>
    <div className="zoom no-print">
      <button className="icon-btn" onClick={() => zoom(0.8)} aria-label="Zoomer">+</button>
      <button className="icon-btn" onClick={() => zoom(1.25)} aria-label="Dézoomer">−</button>
      <button className="icon-btn" onClick={() => fit(building)} aria-label="Recadrer" title="Recadrer sur la maison">⤢</button>
      {(
        <button className={`icon-btn ${showDims ? 'is-on' : ''}`} onClick={toggleDims} aria-pressed={showDims} title={showDims ? 'Masquer les cotes des murs' : 'Afficher les cotes des murs'}>
          ↔
        </button>
      )}
    </div>
    {menu && (
      <>
        <div className="ctx-backdrop" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
        <div className="ctx-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 270), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 36) }}>
          <div className="ctx-menu__title">{menu.title}</div>
          {menu.items.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              className={it.danger ? 'is-danger' : ''}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      </>
    )}
    <svg
      ref={svgRef}
      className="plan"
      style={{ cursor: cursorClass }}
      viewBox={`${view.x} ${view.y} ${view.w} ${viewH}`}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={backgroundMenu}
    >
      <defs>
        <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M1 0H0V1" fill="none" stroke="var(--grid)" strokeWidth={view.w / 1400} />
        </pattern>
        <pattern id="hatch" width="0.15" height="0.15" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.15" stroke="var(--danger)" strokeWidth="0.03" />
        </pattern>
        <pattern id="slope" width="0.25" height="0.25" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.25" stroke="var(--ink-soft)" strokeOpacity={0.35} strokeWidth="0.02" />
        </pattern>
        <pattern id="zone-empty" width="0.2" height="0.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="0.2" height="0.2" fill="var(--paper)" fillOpacity={0.7} />
          <line x1="0" y1="0" x2="0" y2="0.2" stroke="var(--accent)" strokeOpacity={0.5} strokeWidth="0.03" />
        </pattern>
        {floorProducts.map((p) => (
          <MaterialPattern key={p.id} product={p} />
        ))}
      </defs>
      <rect x={view.x} y={view.y} width={view.w} height={viewH} fill="url(#grid)" />

      {/* Jardin (parcelle du plan d'implantation), au rez-de-chaussée */}
      {full.site && groundLevel(full).id === levelId && <SiteOutline parcel={full.site.parcel} fs={fs} />}

      {/* Plan importé (calque) */}
      {ul && ul.visible && underlaySrc && (
        <image href={underlaySrc} x={ul.x} y={ul.y} width={ul.width * ul.scale} height={ul.height * ul.scale} opacity={ul.opacity} preserveAspectRatio="none" pointerEvents="none" />
      )}
      {ul && ui.tracePreview && (
        <image href={ui.tracePreview} x={ul.x} y={ul.y} width={ul.width * ul.scale} height={ul.height * ul.scale} opacity={0.55} preserveAspectRatio="none" pointerEvents="none" />
      )}

      {/* Niveau inférieur en filigrane, pour superposer les murs */}
      {lower?.walls.map((w) => (
        <line key={`lw-${w.id}`} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="var(--ink-soft)" strokeOpacity={0.18} strokeWidth={w.thickness} strokeLinecap="square" pointerEvents="none" />
      ))}
      {stairsBelow.map((f) => {
        const s = productById(catalog, f.productId)?.size ?? { w: 0.8, d: 3, h: 2.8 };
        return (
          <g key={`tr-${f.id}`} transform={`translate(${f.x} ${f.y}) rotate(${f.rotation})`} pointerEvents="none">
            <rect x={-s.w / 2} y={-s.d / 2} width={s.w} height={s.d} fill="none" stroke="var(--ink-soft)" strokeWidth={fs * 0.12} strokeDasharray={`${fs * 0.5} ${fs * 0.3}`} />
            <line x1={-s.w / 2} y1={-s.d / 2} x2={s.w / 2} y2={s.d / 2} stroke="var(--ink-soft)" strokeWidth={fs * 0.08} />
            <line x1={s.w / 2} y1={-s.d / 2} x2={-s.w / 2} y2={s.d / 2} stroke="var(--ink-soft)" strokeWidth={fs * 0.08} />
          </g>
        );
      })}

      {/* Pièces */}
      {rooms.map((r) => {
        const floor = productById(catalog, r.label.floorProductId);
        return (
          <path
            key={r.label.id}
            d={[r.polygon, ...(r.holes ?? [])].map((ring) => `M${ring.map((p) => `${p.x},${p.y}`).join('L')}Z`).join('')}
            fillRule="evenodd"
            fill={floor ? (floor.pattern ? `url(#mat-${floor.id})` : floor.color) : 'var(--room)'}
            fillOpacity={floor ? 0.75 : 0.6}
            stroke={isSel('room', r.label.id) ? 'var(--accent)' : 'none'}
            strokeWidth={isSel('room', r.label.id) ? fs * 0.35 : 0}
            onPointerDown={(e) => {
              if (tool !== 'select') return;
              e.stopPropagation();
              select({ kind: 'room', id: r.label.id });
              setDrag({ kind: 'pan', start: toWorld(e), view, screen: { x: e.clientX, y: e.clientY } });
            }}
            onContextMenu={ctx((e) => roomMenu(e, r.label.id, r.label.name))}
          />
        );
      })}

      {/* Zones de sol (sol posé sur une partie de pièce) */}
      {zones.map((z) => {
        const prod = productById(catalog, z.productId);
        const sel = isSel('zone', z.id);
        const movable = tool === 'select' && canEditZone(z.id);
        return (
          <g key={z.id}>
            <rect
              x={z.x}
              y={z.y}
              width={z.w}
              height={z.h}
              fill={prod ? (prod.pattern ? `url(#mat-${prod.id})` : prod.color) : 'url(#zone-empty)'}
              fillOpacity={prod ? 0.9 : 1}
              stroke={sel ? 'var(--accent)' : 'var(--ink-soft)'}
              strokeWidth={sel ? fs * 0.3 : fs * 0.12}
              strokeDasharray={`${fs * 0.5} ${fs * 0.3}`}
              style={{ cursor: movable ? 'move' : tool === 'select' ? 'pointer' : undefined }}
              onPointerDown={(e) => {
                if (tool !== 'select' || e.button !== 0) return;
                e.stopPropagation();
                select({ kind: 'zone', id: z.id });
                if (!canEditZone(z.id)) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                const raw = toWorld(e);
                setDrag({ kind: 'zoneMove', id: z.id, dx: raw.x - z.x, dy: raw.y - z.y, x: z.x, y: z.y, moved: false });
              }}
              onContextMenu={ctx((e) => zoneMenu(e, z))}
            />
            <text x={z.x + z.w / 2} y={z.y + z.h / 2 + fs * 0.35} fontSize={fs * 0.85} textAnchor="middle" className="plan__zone-label" pointerEvents="none">
              {prod ? `${prod.name.split(' ').slice(0, 2).join(' ')} · ${(z.w * z.h).toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m²` : 'Choisir un sol'}
            </text>
            {sel && canEditZone(z.id) && (
              <rect
                x={z.x + z.w - fs * 0.45}
                y={z.y + z.h - fs * 0.45}
                width={fs * 0.9}
                height={fs * 0.9}
                className="plan__handle"
                style={{ cursor: 'nwse-resize' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setDrag({ kind: 'zoneSize', id: z.id, w: z.w, h: z.h });
                }}
              />
            )}
          </g>
        );
      })}

      {/* Combles aménagés : bandes sous les rampants où l'on tient à peine debout (moins de 1,80 m) */}
      {full.roof && full.roof.levelId === levelId && full.roof.eave != null && <UnderSlope building={full} fs={fs} />}

      {/* Murs démolis (projet) */}
      {diff?.demolished.map((w, i) => (
        <line key={`d${i}`} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="url(#hatch)" strokeWidth={w.thickness} strokeLinecap="square" opacity={0.8} />
      ))}

      {/* Murs */}
      {walls.map((w) => {
        const isNew = diff?.newWallIds.has(w.id);
        const color = isNew ? 'var(--new)' : w.kind === 'porteur' ? 'var(--wall-strong)' : 'var(--wall)';
        return (
          <g
            key={w.id}
            onPointerDown={(e) => {
              if (tool !== 'select' || e.button !== 0) return;
              e.stopPropagation();
              select({ kind: 'wall', id: w.id });
            }}
            onContextMenu={ctx((e) => wallMenu(e, w))}
          >
            <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={isSel('wall', w.id) ? 'var(--accent)' : color} strokeWidth={Math.max(w.thickness, 0.06)} strokeLinecap="square" />
            {/* Zone de clic élargie pour les cloisons fines */}
            <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="transparent" strokeWidth={Math.max(w.thickness, fs * 1.4)} style={{ cursor: tool === 'select' ? 'pointer' : undefined }} />
          </g>
        );
      })}

      {/* Revêtements des murs (peinture, papier peint, faïence) : une bande de couleur sur chaque face */}
      {walls.map((w) =>
        (['gauche', 'droite'] as WallSide[]).map((side) => {
          const prod = productById(catalog, w.finish[side]);
          if (!prod) return null;
          const n = wallNormal(w, side);
          const off = Math.max(w.thickness, 0.06) / 2 + fs * 0.22;
          const L = wallLength(w);
          if (L < 0.1) return null;
          const k = Math.min(0.06, L / 4) / L;
          const a = lerp(w.a, w.b, k);
          const b = lerp(w.a, w.b, 1 - k);
          const line = { x1: a.x + n.x * off, y1: a.y + n.y * off, x2: b.x + n.x * off, y2: b.y + n.y * off };
          return (
            <g key={`f-${w.id}-${side}`} pointerEvents="none">
              <line {...line} stroke="var(--ink-soft)" strokeOpacity={0.45} strokeWidth={fs * 0.42} strokeLinecap="round" />
              <line {...line} stroke={prod.color} strokeWidth={fs * 0.3} strokeLinecap="round" />
            </g>
          );
        }),
      )}

      {/* Cotes de tous les murs */}
      {showDims &&
        walls
          .filter((w) => w.id !== selectedWall?.id && wallLength(w) >= 0.3)
          .map((w) => {
            const n = wallNormal(w);
            const mid = lerp(w.a, w.b, 0.5);
            // Cote à l'extérieur de la maison pour les murs de façade, côté gauche sinon
            const out = (mid.x + n.x - center.x) ** 2 + (mid.y + n.y - center.y) ** 2 > (mid.x - n.x - center.x) ** 2 + (mid.y - n.y - center.y) ** 2 ? 1 : -1;
            const off = out * (Math.max(w.thickness, 0.06) / 2 + fs * 0.9);
            return <Dimension key={`dim-${w.id}`} a={w.a} b={w.b} offset={off} fs={fs * 0.85} muted />;
          })}

      {/* Largeur des portes et fenêtres (côté opposé aux cotes du mur) */}
      {showDims &&
        building.openings.map((o) => {
          const w = walls.find((x) => x.id === o.wallId);
          if (!w) return null;
          const L = wallLength(w);
          if (L < 0.01) return null;
          const p1 = lerp(w.a, w.b, (o.offset - o.width / 2) / L);
          const p2 = lerp(w.a, w.b, (o.offset + o.width / 2) / L);
          const n = wallNormal(w);
          const mid = lerp(w.a, w.b, 0.5);
          const out = (mid.x + n.x - center.x) ** 2 + (mid.y + n.y - center.y) ** 2 > (mid.x - n.x - center.x) ** 2 + (mid.y - n.y - center.y) ** 2 ? 1 : -1;
          const label = `${o.productId?.includes('garage') ? 'Garage' : o.kind === 'porte' ? 'P' : 'F'} ${Math.round(o.width * 100)}${o.kind === 'fenetre' ? ` × ${Math.round(o.height * 100)}` : ''}`;
          return <Dimension key={`od-${o.id}`} a={p1} b={p2} offset={-out * (Math.max(w.thickness, 0.06) / 2 + fs * 0.7)} fs={fs * 0.8} text={label} opening />;
        })}

      {/* Ouvertures */}
      {building.openings.map((o) => {
        const w = walls.find((x) => x.id === o.wallId);
        if (!w) return null;
        return (
          <OpeningShape
            key={o.id}
            o={o}
            w={w}
            selected={isSel('opening', o.id)}
            isNew={!!diff?.newOpeningIds.has(o.id)}
            onSelect={(e) => {
              if (tool !== 'select' || e.button !== 0) return;
              e.stopPropagation();
              select({ kind: 'opening', id: o.id });
            }}
            onMenu={ctx((e) => openingMenu(e, o))}
          />
        );
      })}

      {/* Meubles */}
      {furniture.map((f) => {
        const p = productById(catalog, f.productId);
        const s = p?.size ?? { w: 0.6, d: 0.6, h: 0.8 };
        const sel = isSel('furniture', f.id);
        return (
          <g
            key={f.id}
            transform={`translate(${f.x} ${f.y}) rotate(${f.rotation})`}
            onContextMenu={ctx((e) => furnitureMenu(e, f.id))}
            onPointerDown={(e) => {
              if (tool !== 'select' || e.button !== 0) return;
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              select({ kind: 'furniture', id: f.id });
              const raw = toWorld(e);
              setDrag({ kind: 'furniture', id: f.id, dx: raw.x - f.x, dy: raw.y - f.y, x: f.x, y: f.y, rotation: f.rotation, moved: false });
            }}
            style={{ cursor: tool === 'select' ? 'move' : undefined }}
          >
            <rect
              x={-s.w / 2}
              y={-s.d / 2}
              width={s.w}
              height={s.d}
              rx={0.04}
              fill={p?.color ?? '#ccc'}
              fillOpacity={0.9}
              stroke={sel ? 'var(--accent)' : diff?.newFurnitureIds.has(f.id) ? 'var(--new)' : 'var(--ink-soft)'}
              strokeWidth={sel ? fs * 0.3 : fs * 0.12}
            />
            {p?.category === 'escalier' ? (
              <StairSymbol w={s.w} d={s.d} fs={fs} />
            ) : (
              <line x1={-s.w / 2} y1={-s.d / 2 + 0.06} x2={s.w / 2} y2={-s.d / 2 + 0.06} stroke="var(--ink-soft)" strokeWidth={fs * 0.08} opacity={0.6} />
            )}
          </g>
        );
      })}

      {/* Fenêtres de toit (dans le rampant, au-dessus du niveau qui porte le toit) */}
      {isSloped(full.roof) &&
        full.roof.levelId === levelId &&
        (full.roof.windows ?? []).map((w0) => {
          const roof = full.roof!;
          const w = drag?.kind === 'roofWindow' && drag.id === w0.id ? { ...w0, x: drag.x, y: drag.y } : w0;
          const r = roofWindowRect(roof, w);
          const sel = isSel('roofWindow', w.id);
          const movable = tool === 'select' && (isExisting || !!diff?.newRoofWindowIds.has(w.id));
          const isNew = !!diff?.newRoofWindowIds.has(w.id);
          return (
            <g
              key={w.id}
              onContextMenu={ctx((e) => roofWindowMenu(e, w.id))}
              onPointerDown={(e) => {
                if (tool !== 'select' || e.button !== 0) return;
                e.stopPropagation();
                select({ kind: 'roofWindow', id: w.id });
                if (!movable) return;
                (e.target as Element).setPointerCapture?.(e.pointerId);
                const raw = toWorld(e);
                setDrag({ kind: 'roofWindow', id: w.id, dx: raw.x - w.x, dy: raw.y - w.y, x: w.x, y: w.y, moved: false });
              }}
              style={{ cursor: movable ? 'move' : tool === 'select' ? 'pointer' : undefined }}
            >
              <rect
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                fill="#cfe3f3"
                fillOpacity={0.75}
                stroke={sel ? 'var(--accent)' : isNew ? 'var(--new)' : 'var(--ink-soft)'}
                strokeWidth={sel ? fs * 0.3 : fs * 0.14}
                strokeDasharray={`${fs * 0.5} ${fs * 0.25}`}
              />
              <line x1={r.x} y1={r.y} x2={r.x + r.w} y2={r.y + r.h} stroke="var(--ink-soft)" strokeWidth={fs * 0.06} opacity={0.6} />
              <line x1={r.x + r.w} y1={r.y} x2={r.x} y2={r.y + r.h} stroke="var(--ink-soft)" strokeWidth={fs * 0.06} opacity={0.6} />
              <text x={w.x} y={r.y + r.h + fs * 1.1} fontSize={fs * 0.8} textAnchor="middle" fill="var(--ink-soft)" pointerEvents="none">
                Velux {Math.round(w.width * 100)}×{Math.round(roofWindowHeight(roof, w.length) * 100)}
              </text>
            </g>
          );
        })}

      {/* Étiquettes des pièces (pas pour un interstice entre deux murs collés) */}
      {rooms.filter((r) => r.area >= 0.3 || !r.label.id.startsWith('auto')).map((r) => (
        <g key={`l-${r.label.id}`} className="plan__label" pointerEvents="none">
          <text x={r.label.at.x} y={r.label.at.y} fontSize={fs * 1.1} textAnchor="middle" fontWeight={600}>
            {r.label.name}
          </text>
          <text x={r.label.at.x} y={r.label.at.y + fs * 1.4} fontSize={fs * 0.95} textAnchor="middle">
            {r.area.toLocaleString('fr-BE', { maximumFractionDigits: 1 })} m²
          </text>
        </g>
      ))}

      {/* Cotes et poignées du mur sélectionné */}
      {selectedWall && (
        <g>
          <Dimension a={selectedWall.a} b={selectedWall.b} offset={selectedWall.thickness / 2 + fs * 1.2} fs={fs} />
          {isExisting &&
            [selectedWall.a, selectedWall.b].map((pt, i) => (
              <circle
                key={i}
                cx={pt.x}
                cy={pt.y}
                r={fs * 0.6}
                className="plan__handle"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setDrag({ kind: 'node', from: pt, to: pt });
                }}
              />
            ))}
        </g>
      )}

      {/* Points de vue (photos) */}
      {viewpoints.map((v) => (
        <ViewpointMark
          key={v.id}
          v={v}
          fs={fs}
          selected={isSel('viewpoint', v.id)}
          onMenu={ctx((e) => viewpointMenu(e, v))}
          onDown={(e, mode) => {
            if (tool !== 'select' || e.button !== 0) return;
            e.stopPropagation();
            select({ kind: 'viewpoint', id: v.id });
            if (!isExisting) return; // en projet, les points de vue sont figés
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag({ kind: 'viewpoint', id: v.id, mode, x: v.x, y: v.y, direction: v.direction, moved: false });
          }}
        />
      ))}

      {/* Étalonnage du plan importé */}
      {tool === 'calibrate' && ui.calibration.length > 0 && (
        <g pointerEvents="none">
          {ui.calibration.map((c, i) => (
            <circle key={i} cx={c.x} cy={c.y} r={fs * 0.4} fill="var(--danger)" />
          ))}
          {ui.calibration.length === 1 && cursor && <line x1={ui.calibration[0].x} y1={ui.calibration[0].y} x2={cursor.x} y2={cursor.y} stroke="var(--danger)" strokeWidth={fs * 0.15} />}
          {ui.calibration.length === 2 && <line x1={ui.calibration[0].x} y1={ui.calibration[0].y} x2={ui.calibration[1].x} y2={ui.calibration[1].y} stroke="var(--danger)" strokeWidth={fs * 0.15} />}
        </g>
      )}

      {/* Aperçus */}
      {tool === 'wall' && wallStart && cursor && (
        <g pointerEvents="none">
          <line x1={wallStart.x} y1={wallStart.y} x2={cursor.x} y2={cursor.y} stroke="var(--accent)" strokeWidth={wallKind === 'porteur' && isExisting ? 0.3 : 0.1} strokeOpacity={0.5} strokeLinecap="square" />
          <Dimension a={wallStart} b={cursor} offset={fs * 1.5} fs={fs} />
        </g>
      )}
      {drag?.kind === 'room' && (
        <g pointerEvents="none">
          <rect
            x={Math.min(drag.start.x, drag.end.x)}
            y={Math.min(drag.start.y, drag.end.y)}
            width={Math.abs(drag.end.x - drag.start.x)}
            height={Math.abs(drag.end.y - drag.start.y)}
            fill="var(--accent)"
            fillOpacity={0.08}
            stroke="var(--accent)"
            strokeWidth={0.1}
          />
          <Dimension a={drag.start} b={{ x: drag.end.x, y: drag.start.y }} offset={-fs * 1.5} fs={fs} />
          <Dimension a={{ x: drag.end.x, y: drag.start.y }} b={drag.end} offset={-fs * 1.5} fs={fs} />
        </g>
      )}
      {drag?.kind === 'zone' && (
        <g pointerEvents="none">
          <rect
            x={Math.min(drag.start.x, drag.end.x)}
            y={Math.min(drag.start.y, drag.end.y)}
            width={Math.abs(drag.end.x - drag.start.x)}
            height={Math.abs(drag.end.y - drag.start.y)}
            fill="var(--accent)"
            fillOpacity={0.12}
            stroke="var(--accent)"
            strokeWidth={fs * 0.15}
            strokeDasharray={`${fs * 0.5} ${fs * 0.3}`}
          />
          <Dimension a={drag.start} b={{ x: drag.end.x, y: drag.start.y }} offset={-fs * 1.5} fs={fs} />
          <Dimension a={{ x: drag.end.x, y: drag.start.y }} b={drag.end} offset={-fs * 1.5} fs={fs} />
        </g>
      )}
      {cursor && tool !== 'select' && tool !== 'calibrate' && (
        <circle cx={cursor.x} cy={cursor.y} r={fs * 0.3} fill="var(--accent)" pointerEvents="none" />
      )}
    </svg>
    </>
  );
}

function Dimension({ a, b, offset, fs, muted, text, opening }: { a: Point; b: Point; offset: number; fs: number; muted?: boolean; text?: string; opening?: boolean }) {
  const L = dist(a, b);
  if (L < 0.05) return null;
  const n = wallNormal({ a, b } as Wall);
  const pa = { x: a.x + n.x * offset, y: a.y + n.y * offset };
  const pb = { x: b.x + n.x * offset, y: b.y + n.y * offset };
  const m = lerp(pa, pb, 0.5);
  let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (ang > 90 || ang < -90) ang += 180;
  return (
    <g className={opening ? 'plan__dim plan__dim--opening' : muted ? 'plan__dim plan__dim--muted' : 'plan__dim'} pointerEvents="none">
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} strokeWidth={fs * 0.08} />
      {/* Petits traits aux extrémités */}
      {[pa, pb].map((q, i) => {
        const nn = wallNormal({ a, b } as Wall);
        return <line key={i} x1={q.x - nn.x * fs * 0.35} y1={q.y - nn.y * fs * 0.35} x2={q.x + nn.x * fs * 0.35} y2={q.y + nn.y * fs * 0.35} strokeWidth={fs * 0.08} />;
      })}
      <text x={m.x} y={m.y - fs * 0.35} fontSize={fs} textAnchor="middle" transform={`rotate(${ang} ${m.x} ${m.y})`}>
        {text ?? fmtM(L)}
      </text>
    </g>
  );
}

function OpeningShape({ o, w, selected, isNew, onSelect, onMenu }: { o: Opening; w: Wall; selected: boolean; isNew: boolean; onSelect: (e: React.PointerEvent) => void; onMenu: (e: React.MouseEvent) => void }) {
  const L = wallLength(w);
  if (L === 0) return null;
  const t1 = (o.offset - o.width / 2) / L;
  const t2 = (o.offset + o.width / 2) / L;
  const p1 = lerp(w.a, w.b, t1);
  const p2 = lerp(w.a, w.b, t2);
  const n = wallNormal(w);
  const th = Math.max(w.thickness, 0.06);
  const stroke = selected ? 'var(--accent)' : isNew ? 'var(--new)' : 'var(--ink)';
  const sw = 0.025;
  if (o.kind === 'fenetre') {
    const off = th / 4;
    return (
      <g onPointerDown={onSelect} onContextMenu={onMenu} style={{ cursor: 'pointer' }}>
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--paper)" strokeWidth={th + 0.01} />
        <line x1={p1.x + n.x * off} y1={p1.y + n.y * off} x2={p2.x + n.x * off} y2={p2.y + n.y * off} stroke={stroke} strokeWidth={sw} />
        <line x1={p1.x - n.x * off} y1={p1.y - n.y * off} x2={p2.x - n.x * off} y2={p2.y - n.y * off} stroke={stroke} strokeWidth={sw} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={sw * 0.6} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={th + 0.15} />
      </g>
    );
  }
  // Porte de garage : tablier dessiné en tirets (il remonte au plafond), sans arc
  if (o.productId?.includes('garage')) {
    const off = th / 2 + 0.04;
    const q1 = { x: p1.x - n.x * off, y: p1.y - n.y * off };
    const q2 = { x: p2.x - n.x * off, y: p2.y - n.y * off };
    const r1 = { x: p1.x + n.x * off, y: p1.y + n.y * off };
    const r2 = { x: p2.x + n.x * off, y: p2.y + n.y * off };
    return (
      <g onPointerDown={onSelect} onContextMenu={onMenu} style={{ cursor: 'pointer' }}>
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--paper)" strokeWidth={th + 0.01} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={sw * 2} />
        <line x1={q1.x} y1={q1.y} x2={q2.x} y2={q2.y} stroke={stroke} strokeWidth={sw * 0.6} strokeDasharray="0.12 0.08" />
        <line x1={r1.x} y1={r1.y} x2={r2.x} y2={r2.y} stroke={stroke} strokeWidth={sw * 0.6} strokeDasharray="0.12 0.08" />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={th + 0.15} />
      </g>
    );
  }
  // Porte : vantail + arc d'ouverture
  const leaf = { x: p1.x + n.x * o.width, y: p1.y + n.y * o.width };
  return (
    <g onPointerDown={onSelect} onContextMenu={onMenu} style={{ cursor: 'pointer' }}>
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--paper)" strokeWidth={th + 0.01} />
      <line x1={p1.x} y1={p1.y} x2={leaf.x} y2={leaf.y} stroke={stroke} strokeWidth={sw * 1.5} />
      <path d={`M${leaf.x} ${leaf.y} A${o.width} ${o.width} 0 0 ${crossSign(w) ? 1 : 0} ${p2.x} ${p2.y}`} fill="none" stroke={stroke} strokeWidth={sw * 0.6} strokeDasharray="0.05 0.04" />
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={th + 0.15} />
    </g>
  );
}

/** Sens de l'arc de la porte selon l'orientation du mur. */
function crossSign(w: Wall): boolean {
  const n = wallNormal(w);
  const d = { x: w.b.x - w.a.x, y: w.b.y - w.a.y };
  return n.x * d.y - n.y * d.x < 0;
}

/** Motif SVG d'un matériau (sol), à l'échelle réelle. */
function MaterialPattern({ product }: { product: Product }) {
  const tile = patternTile(product.pattern, product.color, 96);
  return (
    <pattern id={`mat-${product.id}`} width={tile.w} height={tile.h} patternUnits="userSpaceOnUse">
      <image href={patternUrl(product.pattern, product.color, 96)} width={tile.w} height={tile.h} preserveAspectRatio="none" />
    </pattern>
  );
}

/** Escalier en plan : marches et flèche de montée (vers le haut du symbole). */
function StairSymbol({ w, d, fs }: { w: number; d: number; fs: number }) {
  const n = Math.max(3, Math.round(d / 0.25));
  return (
    <g pointerEvents="none">
      {Array.from({ length: n - 1 }, (_, i) => {
        const y = -d / 2 + ((i + 1) * d) / n;
        return <line key={i} x1={-w / 2} y1={y} x2={w / 2} y2={y} stroke="var(--ink-soft)" strokeWidth={fs * 0.07} />;
      })}
      <line x1={0} y1={d / 2 - 0.15} x2={0} y2={-d / 2 + 0.2} stroke="var(--ink)" strokeWidth={fs * 0.1} />
      <path d={`M${-0.12} ${-d / 2 + 0.35} L0 ${-d / 2 + 0.15} L${0.12} ${-d / 2 + 0.35}`} fill="none" stroke="var(--ink)" strokeWidth={fs * 0.1} />
    </g>
  );
}

/** Point de vue : appareil photo et cône de vision, orientable par la poignée. */
function ViewpointMark({ v, fs, selected, onDown, onMenu }: { v: Viewpoint; fs: number; selected: boolean; onDown: (e: React.PointerEvent, mode: 'move' | 'turn') => void; onMenu: (e: React.MouseEvent) => void }) {
  const a = (v.direction * Math.PI) / 180;
  const half = (v.fov * Math.PI) / 360;
  const L = 1.6;
  const p1 = { x: v.x + Math.cos(a - half) * L, y: v.y + Math.sin(a - half) * L };
  const p2 = { x: v.x + Math.cos(a + half) * L, y: v.y + Math.sin(a + half) * L };
  const handle = { x: v.x + Math.cos(a) * L, y: v.y + Math.sin(a) * L };
  const color = selected ? 'var(--accent)' : '#d97706';
  return (
    <g data-vp={v.id} onContextMenu={onMenu}>
      <path d={`M${v.x} ${v.y} L${p1.x} ${p1.y} A${L} ${L} 0 0 1 ${p2.x} ${p2.y} Z`} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={fs * 0.08} pointerEvents="none" />
      <circle cx={v.x} cy={v.y} r={fs * 0.75} fill={color} stroke="#fff" strokeWidth={fs * 0.12} style={{ cursor: 'move' }} onPointerDown={(e) => onDown(e, 'move')} />
      <rect x={v.x - fs * 0.32} y={v.y - fs * 0.22} width={fs * 0.64} height={fs * 0.44} rx={fs * 0.06} fill="#fff" pointerEvents="none" />
      <circle cx={v.x} cy={v.y} r={fs * 0.14} fill={color} pointerEvents="none" />
      {selected && <circle cx={handle.x} cy={handle.y} r={fs * 0.5} className="plan__handle" style={{ cursor: 'grab' }} onPointerDown={(e) => onDown(e, 'turn')} />}
    </g>
  );
}

/** Contour de la parcelle et sa surface. */
function SiteOutline({ parcel, fs }: { parcel: Point[]; fs: number }) {
  const area = Math.abs(parcel.reduce((s, a, i) => s + a.x * parcel[(i + 1) % parcel.length].y - parcel[(i + 1) % parcel.length].x * a.y, 0)) / 2;
  // Étiquette au milieu du plus long côté, un peu vers l'intérieur
  let best = 0;
  for (let i = 1; i < parcel.length; i++) {
    const L = (j: number) => Math.hypot(parcel[(j + 1) % parcel.length].x - parcel[j].x, parcel[(j + 1) % parcel.length].y - parcel[j].y);
    if (L(i) > L(best)) best = i;
  }
  const a = parcel[best];
  const b = parcel[(best + 1) % parcel.length];
  const c = { x: parcel.reduce((s, p) => s + p.x, 0) / parcel.length, y: parcel.reduce((s, p) => s + p.y, 0) / parcel.length };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const k = (fs * 2.5) / Math.max(0.01, Math.hypot(c.x - m.x, c.y - m.y));
  const at = { x: m.x + (c.x - m.x) * k, y: m.y + (c.y - m.y) * k };
  return (
    <g pointerEvents="none" className="plan__site">
      <polygon points={parcel.map((p) => `${p.x},${p.y}`).join(' ')} fill="#6f9a45" fillOpacity={0.08} stroke="#4f7a2e" strokeWidth={fs * 0.18} strokeDasharray={`${fs} ${fs * 0.5}`} />
      <text x={at.x} y={at.y} fontSize={fs} textAnchor="middle" fill="#4f7a2e">
        Jardin · {Math.round(area).toLocaleString('fr-FR')} m²
      </text>
    </g>
  );
}

/** Zones des combles de moins de 1,80 m sous le rampant (convention des plans), le long des égouts. */
function UnderSlope({ building, fs }: { building: Building; fs: number }) {
  const roof = building.roof!;
  const f = roofFrame(building, roof);
  if (!f || (roof.type !== 'deux-pans' && roof.type !== 'monopente')) return null;
  const t = Math.tan((roof.pitch * Math.PI) / 180);
  const d = Math.max(0, (1.8 - (roof.eave ?? 0) + ROOF_DEPTH / Math.cos((roof.pitch * Math.PI) / 180)) / t);
  if (d < 0.05) return null;
  const alongX = roof.ridge === 'x';
  const strips = (roof.type === 'deux-pans' ? [0, 1] : [0]).map((side) => {
    if (alongX) {
      const y0 = side ? f.maxY - d : f.minY;
      return { x: f.minX, y: y0, w: f.maxX - f.minX, h: d, line: side ? [f.minX, y0, f.maxX, y0] : [f.minX, y0 + d, f.maxX, y0 + d] };
    }
    const x0 = side ? f.maxX - d : f.minX;
    return { x: x0, y: f.minY, w: d, h: f.maxY - f.minY, line: side ? [x0, f.minY, x0, f.maxY] : [x0 + d, f.minY, x0 + d, f.maxY] };
  });
  return (
    <g pointerEvents="none">
      {strips.map((r, i) => (
        <g key={i}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#slope)" />
          <line x1={r.line[0]} y1={r.line[1]} x2={r.line[2]} y2={r.line[3]} stroke="var(--ink-soft)" strokeWidth={fs * 0.1} strokeDasharray={`${fs * 0.6} ${fs * 0.3}`} />
          <text
            x={r.x + r.w / 2}
            y={r.y + r.h / 2}
            fontSize={fs * 0.85}
            textAnchor="middle"
            fill="var(--ink-soft)"
            transform={alongX ? undefined : `rotate(-90 ${r.x + r.w / 2} ${r.y + r.h / 2})`}
          >
            sous rampant · moins de 1,80 m
          </text>
        </g>
      ))}
    </g>
  );
}
