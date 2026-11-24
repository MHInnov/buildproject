import { useEffect, useMemo, useRef, useState } from 'react';
import { addFurniture, addOpening, moveFurniture, removeFurniture, removeOpening, removeWall, removeViewpoint, updateViewpoint } from '../actions';
import { useAsset } from '../assets';
import { productById, type Product } from '../model/catalog';
import { levelBelow, levelById, onLevel } from '../model/levels';
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
  wallLength,
  wallNormal,
} from '../model/geometry';
import type { Building, Opening, Point, Viewpoint, Wall, WallKind } from '../model/types';
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
  | null;

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
    const productId = kind === 'porte' ? 'porte-int-blanche' : 'chassis-pvc-blanc';
    const prod = productById(catalog, productId);
    const L = wallLength(hit.wall);
    const width = Math.min(prod?.size?.w ?? (kind === 'porte' ? 0.83 : 1.2), L - 0.1);
    const offset = Math.min(L - width / 2, Math.max(width / 2, Math.round(hit.t * L * 20) / 20));
    const o: Opening = {
      id: newId('o'),
      wallId: hit.wall.id,
      kind,
      offset,
      width,
      height: prod?.size?.h ?? (kind === 'porte' ? 2.01 : 1.35),
      sill: kind === 'porte' ? 0 : 0.9,
      productId,
    };
    addOpening(o);
    setTool('select');
    select({ kind: 'opening', id: o.id });
  }

  // ----- Événements -----
  // Point de vue sélectionné : un clic n'importe où sur le plan (même sur une pièce ou un meuble) l'y place,
  // un glisser donne la direction de la photo. Échap pour terminer.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0 || selection?.kind !== 'viewpoint') return;
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
    if (tool === 'viewpoint') {
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
    } else if (tool === 'door' || tool === 'window') {
      placeOpening(raw, tool === 'door' ? 'porte' : 'fenetre');
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
    } else if (drag.kind === 'node') {
      setDrag({ ...drag, to: snapPoint(raw, { ...building, walls: building.walls.filter((w) => !samePoint(w.a, drag.from) && !samePoint(w.b, drag.from)) }) });
    } else if (drag.kind === 'room') {
      setDrag({ ...drag, end: p });
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
  const floorProducts = [...new Set(rooms.map((r) => r.label.floorProductId).filter(Boolean))].map((id) => productById(catalog, id)).filter((p): p is Product => !!p);
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
    </div>
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
      onContextMenu={(e) => {
        e.preventDefault();
        setWallStart(null);
      }}
    >
      <defs>
        <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M1 0H0V1" fill="none" stroke="var(--grid)" strokeWidth={view.w / 1400} />
        </pattern>
        <pattern id="hatch" width="0.15" height="0.15" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="0.15" stroke="var(--danger)" strokeWidth="0.03" />
        </pattern>
        {floorProducts.map((p) => (
          <MaterialPattern key={p.id} product={p} />
        ))}
      </defs>
      <rect x={view.x} y={view.y} width={view.w} height={viewH} fill="url(#grid)" />

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
          />
        );
      })}

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
              if (tool !== 'select') return;
              e.stopPropagation();
              select({ kind: 'wall', id: w.id });
            }}
          >
            <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={isSel('wall', w.id) ? 'var(--accent)' : color} strokeWidth={Math.max(w.thickness, 0.06)} strokeLinecap="square" />
            {/* Zone de clic élargie pour les cloisons fines */}
            <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="transparent" strokeWidth={Math.max(w.thickness, fs * 1.4)} style={{ cursor: tool === 'select' ? 'pointer' : undefined }} />
          </g>
        );
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
              if (tool !== 'select') return;
              e.stopPropagation();
              select({ kind: 'opening', id: o.id });
            }}
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
            onPointerDown={(e) => {
              if (tool !== 'select') return;
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

      {/* Étiquettes des pièces */}
      {rooms.map((r) => (
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
          onDown={(e, mode) => {
            if (tool !== 'select') return;
            e.stopPropagation();
            (e.target as Element).setPointerCapture?.(e.pointerId);
            select({ kind: 'viewpoint', id: v.id });
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
      {cursor && tool !== 'select' && tool !== 'calibrate' && (
        <circle cx={cursor.x} cy={cursor.y} r={fs * 0.3} fill="var(--accent)" pointerEvents="none" />
      )}
    </svg>
    </>
  );
}

function Dimension({ a, b, offset, fs }: { a: Point; b: Point; offset: number; fs: number }) {
  const L = dist(a, b);
  if (L < 0.05) return null;
  const n = wallNormal({ a, b } as Wall);
  const pa = { x: a.x + n.x * offset, y: a.y + n.y * offset };
  const pb = { x: b.x + n.x * offset, y: b.y + n.y * offset };
  const m = lerp(pa, pb, 0.5);
  let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (ang > 90 || ang < -90) ang += 180;
  return (
    <g className="plan__dim" pointerEvents="none">
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} strokeWidth={fs * 0.08} />
      <text x={m.x} y={m.y - fs * 0.35} fontSize={fs} textAnchor="middle" transform={`rotate(${ang} ${m.x} ${m.y})`}>
        {fmtM(L)}
      </text>
    </g>
  );
}

function OpeningShape({ o, w, selected, isNew, onSelect }: { o: Opening; w: Wall; selected: boolean; isNew: boolean; onSelect: (e: React.PointerEvent) => void }) {
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
      <g onPointerDown={onSelect} style={{ cursor: 'pointer' }}>
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--paper)" strokeWidth={th + 0.01} />
        <line x1={p1.x + n.x * off} y1={p1.y + n.y * off} x2={p2.x + n.x * off} y2={p2.y + n.y * off} stroke={stroke} strokeWidth={sw} />
        <line x1={p1.x - n.x * off} y1={p1.y - n.y * off} x2={p2.x - n.x * off} y2={p2.y - n.y * off} stroke={stroke} strokeWidth={sw} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={sw * 0.6} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={th + 0.15} />
      </g>
    );
  }
  // Porte : vantail + arc d'ouverture
  const leaf = { x: p1.x + n.x * o.width, y: p1.y + n.y * o.width };
  return (
    <g onPointerDown={onSelect} style={{ cursor: 'pointer' }}>
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
function ViewpointMark({ v, fs, selected, onDown }: { v: Viewpoint; fs: number; selected: boolean; onDown: (e: React.PointerEvent, mode: 'move' | 'turn') => void }) {
  const a = (v.direction * Math.PI) / 180;
  const half = (v.fov * Math.PI) / 360;
  const L = 1.6;
  const p1 = { x: v.x + Math.cos(a - half) * L, y: v.y + Math.sin(a - half) * L };
  const p2 = { x: v.x + Math.cos(a + half) * L, y: v.y + Math.sin(a + half) * L };
  const handle = { x: v.x + Math.cos(a) * L, y: v.y + Math.sin(a) * L };
  const color = selected ? 'var(--accent)' : '#d97706';
  return (
    <g data-vp={v.id}>
      <path d={`M${v.x} ${v.y} L${p1.x} ${p1.y} A${L} ${L} 0 0 1 ${p2.x} ${p2.y} Z`} fill={color} fillOpacity={0.14} stroke={color} strokeWidth={fs * 0.08} pointerEvents="none" />
      <circle cx={v.x} cy={v.y} r={fs * 0.75} fill={color} stroke="#fff" strokeWidth={fs * 0.12} style={{ cursor: 'move' }} onPointerDown={(e) => onDown(e, 'move')} />
      <rect x={v.x - fs * 0.32} y={v.y - fs * 0.22} width={fs * 0.64} height={fs * 0.44} rx={fs * 0.06} fill="#fff" pointerEvents="none" />
      <circle cx={v.x} cy={v.y} r={fs * 0.14} fill={color} pointerEvents="none" />
      {selected && <circle cx={handle.x} cy={handle.y} r={fs * 0.5} className="plan__handle" style={{ cursor: 'grab' }} onPointerDown={(e) => onDown(e, 'turn')} />}
    </g>
  );
}

