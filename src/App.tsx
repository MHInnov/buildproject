import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { putAsset, useAssets } from './assets';
import { describeOperation } from './model/diff';
import { migrateProject } from './model/levels';
import { euro } from './model/estimate';
import { detectRooms } from './model/geometry';
import type { Project, WallKind } from './model/types';
import { useStore, type Step, type Tool } from './store';
import { AdminDialog } from './ui/AdminDialog';
import { Artisans } from './ui/Artisans';
import { LevelTabs } from './ui/HousePanels';
import { Inspector } from './ui/Inspector';
import { PlanEditor } from './ui/PlanEditor';
import { Summary, useEstimate } from './ui/Summary';

// La 3D (three.js) n'est chargée qu'à l'ouverture de la visite : démarrage plus léger.
const Visit3D = lazy(() => import('./three/Visit3D').then((m) => ({ default: m.Visit3D })));

const STEPS: { id: Step; label: string }[] = [
  { id: 'existant', label: 'Existant' },
  { id: 'projet', label: 'Projet' },
  { id: 'visite', label: 'Visite 3D' },
  { id: 'artisans', label: 'Artisans' },
  { id: 'resume', label: 'Résumé' },
];

export function App() {
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const project = useStore((s) => s.project);
  const updateProject = useStore((s) => s.updateProject);
  const e = useEstimate();

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest('input, textarea, select')) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) redo();
        else undo();
      } else if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <span className="brand__logo">CP</span>
          <input className="brand__name" value={project.name} onChange={(ev) => updateProject((p) => void (p.name = ev.target.value))} aria-label="Nom du projet" />
        </div>
        <nav className="steps" aria-label="Étapes">
          {STEPS.map((s, i) => (
            <button key={s.id} className={`step ${step === s.id ? 'is-active' : ''}`} onClick={() => setStep(s.id)}>
              <span className="step__num">{i + 1}</span>
              <span className="step__label">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar__right">
          <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Annuler (Ctrl+Z)" aria-label="Annuler">
            ↶
          </button>
          <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Rétablir (Ctrl+Y)" aria-label="Rétablir">
            ↷
          </button>
          <button className="budget" onClick={() => setStep('resume')} title="Voir le résumé">
            <small>Budget estimé</small>
            <strong>{e.lots.length ? `${euro(e.totalMin)} – ${euro(e.totalMax)}` : '0 €'}</strong>
          </button>
          <FileMenu />
        </div>
      </header>

      <main className="main">
        {(step === 'existant' || step === 'projet') && <PlanStep />}
        {step === 'visite' && (
          <div className="workspace">
            <div className="canvas-area">
              <Suspense fallback={<div className="loading">Chargement de la 3D…</div>}>
                <Visit3D />
              </Suspense>
            </div>
            <aside className="sidebar">
              <Inspector />
            </aside>
          </div>
        )}
        {step === 'artisans' && <Artisans />}
        {step === 'resume' && <Summary />}
      </main>
    </div>
  );
}

function PlanStep() {
  const step = useStore((s) => s.step);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const [wallKind, setWallKind] = useState<WallKind>('porteur');
  const isExisting = step === 'existant';
  const tools: { id: Tool; label: string; hint: string }[] = [
    { id: 'select', label: 'Sélection', hint: 'Cliquer pour choisir, glisser pour déplacer le plan ou un meuble' },
    { id: 'room', label: 'Pièce', hint: 'Glisser pour tracer une pièce rectangulaire' },
    { id: 'wall', label: 'Mur', hint: 'Cliquer point par point ; double-clic ou Échap pour terminer ; Maj pour un angle libre' },
    { id: 'door', label: 'Porte', hint: 'Cliquer sur un mur' },
    { id: 'window', label: 'Fenêtre', hint: 'Cliquer sur un mur' },
    { id: 'viewpoint', label: 'Point de vue', hint: 'Cliquer là où la photo a été prise, puis glisser dans la direction visée' },
  ];
  const current = tools.find((t) => t.id === tool);
  const hint = tool === 'calibrate' ? "Cliquez les deux extrémités d'une cote connue du plan importé" : current?.hint;

  return (
    <div className="workspace">
      <div className="canvas-area">
        <div className="toolbar">
          {tools.map((t) => (
            <button key={t.id} className={`tool ${tool === t.id ? 'is-active' : ''}`} onClick={() => setTool(t.id)} title={t.hint}>
              {t.label}
            </button>
          ))}
          {isExisting && (tool === 'wall' || tool === 'room') && (
            <select className="tool" value={wallKind} onChange={(ev) => setWallKind(ev.target.value as WallKind)} aria-label="Type de mur">
              <option value="porteur">Mur porteur 30 cm</option>
              <option value="cloison">Cloison 10 cm</option>
            </select>
          )}
        </div>
        <LevelTabs />
        <PlanEditor wallKind={wallKind} />
        <div className="statusbar">
          <span className={`mode-badge ${isExisting ? '' : 'mode-badge--project'}`}>{isExisting ? "Plan de l'existant" : 'Plan du projet'}</span>
          <span className="muted">{tool === 'furniture' ? 'Cliquez dans le plan pour poser le meuble (Échap pour annuler)' : hint}</span>
          {!isExisting && (
            <span className="legend">
              <i className="lg lg--new" /> nouveau <i className="lg lg--demo" /> démoli
            </span>
          )}
        </div>
      </div>
      <aside className="sidebar">
        <Inspector />
        {!isExisting && <Operations />}
      </aside>
    </div>
  );
}

function Operations() {
  const project = useStore((s) => s.project);
  const catalog = useStore((s) => s.catalog);
  const removeOperation = useStore((s) => s.removeOperation);
  const names = useMemo(() => {
    const m = new Map(detectRooms(project.existing).map((r) => [r.label.id, r.label.name]));
    return (id: string) => m.get(id) ?? 'la pièce';
  }, [project.existing]);
  return (
    <div className="panel">
      <h4>Modifications ({project.operations.length})</h4>
      {project.operations.length === 0 && <p className="muted small">Aucune modification. L'existant est conservé tel quel.</p>}
      <ol className="ops">
        {project.operations.map((op, i) => (
          <li key={i}>
            <span>{describeOperation(op, catalog, names)}</span>
            <button className="icon-btn icon-btn--small" onClick={() => removeOperation(i)} title="Annuler cette modification" aria-label="Annuler cette modification">
              ×
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FileMenu() {
  const [open, setOpen] = useState(false);
  const [admin, setAdmin] = useState(false);
  const project = useStore((s) => s.project);
  const loadProject = useStore((s) => s.loadProject);
  const resetDemo = useStore((s) => s.resetDemo);
  const resetEmpty = useStore((s) => s.resetEmpty);
  const input = useRef<HTMLInputElement>(null);

  const exportJson = () => {
    // Les images (plans importés, photos) sont jointes au fichier pour qu'il soit complet.
    const all = useAssets.getState().assets;
    const ids = new Set([...project.existing.levels.flatMap((l) => (l.underlay ? [l.underlay.assetId] : [])), ...project.viewpoints.flatMap((v) => (v.assetId ? [v.assetId] : []))]);
    const assets = Object.fromEntries([...ids].filter((id) => all[id]).map((id) => [id, all[id]]));
    const blob = new Blob([JSON.stringify({ ...project, assets }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\w-]+/g, '_') || 'projet'}.construprojet.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setOpen(false);
  };

  return (
    <div className="menu">
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu fichier">
        ☰
      </button>
      {open && (
        <div className="menu__list" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => { resetEmpty(); setOpen(false); }}>Nouveau projet vide</button>
          <button onClick={() => { resetDemo(); setOpen(false); }}>Recharger la maison de démo</button>
          <button onClick={exportJson}>Exporter le projet (.json)</button>
          <button onClick={() => input.current?.click()}>Importer un projet…</button>
          <button onClick={() => { setAdmin(true); setOpen(false); }}>Administration (IA)…</button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (ev) => {
              const f = ev.target.files?.[0];
              if (!f) return;
              try {
                const raw = JSON.parse(await f.text()) as Project & { assets?: Record<string, string> };
                const assets = raw.assets ?? {};
                delete raw.assets;
                const p = migrateProject(raw);
                if (!p) throw new Error('format');
                for (const [id, url] of Object.entries(assets)) await putAsset(url, id);
                loadProject(p);
              } catch {
                alert("Ce fichier n'est pas un projet Constru'Projet valide.");
              }
              setOpen(false);
            }}
          />
        </div>
      )}
      {admin && <AdminDialog onClose={() => setAdmin(false)} />}
    </div>
  );
}
