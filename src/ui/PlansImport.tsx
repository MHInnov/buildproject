import { useRef, useState } from 'react';
import { aiReadPlan } from '../ai';
import { putAsset, shrinkImage } from '../assets';
import { isFloorKind, PLAN_KIND_LABELS, parseDrawingScale, pdfScale, type PlanKind, type SectionReading } from '../model/plans';
import type { Bitmap, TracedWall } from '../model/vectorize';
import { decode, isPdf, nextFrame, pdfPages, type PlanPage } from '../planFiles';
import { analysePlan, classifyPages, importPlans, levelFor, type ImportReport, type PlanInput } from '../plansImport';
import { aiReady, useSettings } from '../settings';
import { useStore } from '../store';
import { applyAiReading } from '../traceApply';

interface Item {
  id: string;
  label: string;
  thumb: string;
  dataUrl: string;
  width: number;
  height: number;
  bmp: Bitmap;
  k: number;
  kind: PlanKind;
  /** Échelle d'après le PDF, en m par pixel de l'image enregistrée. */
  knownScale: number | null;
  scaleText: string | null;
  /** Le nom du fichier ou la page indiquait le niveau. */
  hinted: boolean;
  summary: string;
  /** Pourquoi la page est écartée (doublon, plan en trop). */
  note?: string;
  walls: TracedWall[];
  rooms: number;
  section: SectionReading | null;
}

const KIND_ORDER: PlanKind[] = ['cave', 'rdc', 'etage1', 'etage2', 'etage3', 'combles', 'coupe', 'implantation', 'ignorer'];

/**
 * Import de tout le dossier de plans d'un coup : plans de chaque niveau et coupes, en images ou PDF
 * de plusieurs pages. Chaque page est classée automatiquement (modifiable), puis tout est retracé ensemble.
 */
export function PlansImport({ onClose }: { onClose: () => void }) {
  const editExisting = useStore((s) => s.editExisting);
  const setLevel = useStore((s) => s.setLevel);
  const settings = useSettings();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(settings.aiEnabled && aiReady(settings));

  async function addFiles(files: File[]) {
    setError(null);
    setReport(null);
    const added: Item[] = [];
    try {
      for (const f of files) {
        setBusy(`Lecture de ${f.name}…`);
        await nextFrame();
        const pages: PlanPage[] = isPdf(f) ? await pdfPages(f) : [{ canvas: await toCanvas(f), text: '', pxPerPt: null, label: f.name }];
        for (const pg of pages) {
          setBusy(`Analyse de ${pg.label}…`);
          await nextFrame();
          const shrunk = await shrinkImage(pg.canvas, 2400, 0.86);
          const { bmp, k } = await decode(shrunk.dataUrl, 1600);
          const a = analysePlan(bmp, pg.label, pg.text);
          const denom = parseDrawingScale(pg.text);
          // pxPerPt est donné pour le canvas rendu ; l'image enregistrée a pu être réduite
          const knownScale = denom && pg.pxPerPt ? pdfScale(pg.pxPerPt * (shrunk.width / pg.canvas.width), denom) : null;
          const thumb = await shrinkImage(pg.canvas, 220, 0.7);
          const t = a.trace;
          added.push({
            id: `${Date.now()}-${added.length}`,
            label: pg.label,
            thumb: thumb.dataUrl,
            dataUrl: shrunk.dataUrl,
            width: shrunk.width,
            height: shrunk.height,
            bmp,
            k,
            kind: a.kind,
            knownScale,
            scaleText: denom ? `1/${denom}` : null,
            hinted: !!a.hint && a.hint === a.kind,
            walls: t?.walls ?? [],
            rooms: t?.rooms ?? 0,
            section: a.section,
            summary:
              a.kind === 'coupe' && a.section
                ? `${a.section.slabs.length} planchers${a.section.roof ? `, toit ${a.section.roof.type === 'plat' ? 'plat' : `en pente (${a.section.roof.pitch}°)`}` : ''}`
                : t
                  ? `${t.walls.length} murs, ${t.rooms} pièces`
                  : 'aucun mur reconnu',
          });
        }
      }
      // Les plans sans indication de niveau sont pris dans l'ordre des fichiers ; doublons et plans en trop écartés
      setBusy('Comparaison des pages…');
      await nextFrame();
      const all = [...items, ...added];
      const sorted = classifyPages(all.map((x) => ({ kind: x.kind, hinted: x.hinted || items.includes(x), name: x.label, walls: x.walls, rooms: x.rooms, section: x.section })));
      setItems(all.map((x, i) => ({ ...x, kind: sorted[i].kind, note: sorted[i].note ?? (items.includes(x) ? x.note : undefined) })));
    } catch (e) {
      setError(`Impossible de lire ce fichier (${(e as Error).message}).`);
      if (added.length) setItems([...items, ...added]);
    }
    setBusy(null);
  }

  async function run() {
    setError(null);
    const used = items.filter((x) => x.kind !== 'ignorer');
    const b0 = useStore.getState().project.existing;
    // Une seule confirmation pour tous les niveaux qui ont déjà des murs
    const replaced = new Map<string, number>();
    const probe = structuredClone(b0);
    for (const it of used.filter((x) => isFloorKind(x.kind))) {
      const l = levelFor(probe, it.kind);
      const n = b0.walls.filter((w) => w.levelId === l.id).length;
      if (n) replaced.set(l.name, n);
    }
    if (replaced.size && !confirm(`Remplacer les murs déjà dessinés (${[...replaced].map(([n, c]) => `${n} : ${c} murs`).join(', ')}) par le retraçage des plans ?`)) return;
    setBusy('Retraçage de tous les plans…');
    await nextFrame();
    try {
      const inputs: PlanInput[] = [];
      for (const it of used) {
        inputs.push({ kind: it.kind, bmp: it.bmp, k: it.k, assetId: await putAsset(it.dataUrl), width: it.width, height: it.height, name: it.label, knownScale: it.knownScale });
      }
      let rep: ImportReport | null = null;
      editExisting((b) => void (rep = importPlans(b, inputs)));
      const r = rep as ImportReport | null;
      if (!r) throw new Error('rien à importer');
      // IA facultative : noms des pièces et ouvertures manquées
      if (useAi) {
        const b1 = useStore.getState().project.existing;
        for (const it of used.filter((x) => isFloorKind(x.kind))) {
          const l = b1.levels.find((x) => x.underlay?.assetId && inputs.find((i) => i.name === it.label)?.assetId === x.underlay.assetId);
          if (!l?.underlay) continue;
          setBusy(`L'IA lit ${it.label}…`);
          try {
            const res = await aiReadPlan(it.dataUrl, it.width, it.height);
            const ul = l.underlay;
            editExisting((b) => applyAiReading(b, l.id, ul, res));
            r.lines.push(`${l.name} : ${res.rooms.length} pièces nommées par l'IA.`);
          } catch (e) {
            r.warnings.push(`IA, ${it.label} : ${(e as Error).message}`);
          }
        }
      }
      if (r.levelId) setLevel(r.levelId);
      setReport(r);
    } catch (e) {
      setError(`Import impossible : ${(e as Error).message}.`);
    }
    setBusy(null);
  }

  const floors = items.filter((x) => isFloorKind(x.kind));
  const dup = KIND_ORDER.filter((k) => isFloorKind(k) && floors.filter((x) => x.kind === k).length > 1);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plans-title" onClick={busy ? undefined : onClose}>
      <div className="modal__box modal__box--wide" onClick={(e) => e.stopPropagation()}>
        <h2 id="plans-title">Importer tous les plans</h2>
        <p className="muted small">
          Déposez d'un coup tous les plans de la maison : un plan par niveau (cave, rez-de-chaussée, étages, combles) et les coupes. Images ou PDF, même de plusieurs pages. Chaque
          page est reconnue d'après son nom, son cartouche et son dessin ; corrigez si besoin. Tout est ensuite retracé ensemble : même échelle pour tous les plans (lue sur le PDF
          quand le cartouche l'indique), étages calés sur le rez-de-chaussée, hauteurs sous plafond et toit lus sur la coupe.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/*,application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const fs = [...(e.target.files ?? [])];
            e.target.value = '';
            if (fs.length) void addFiles(fs);
          }}
        />
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const fs = [...e.dataTransfer.files].filter((f) => isPdf(f) || f.type.startsWith('image/'));
            if (fs.length) void addFiles(fs);
          }}
        >
          <button className="btn btn--primary" onClick={() => input.current?.click()} disabled={!!busy}>
            Choisir les fichiers…
          </button>
          <span className="muted small">ou glissez-les ici</span>
        </div>
        {items.length > 0 && (
          <ul className="plan-list">
            {items.map((it) => (
              <li key={it.id}>
                <img src={it.thumb} alt="" />
                <div>
                  <strong>{it.label}</strong>
                  <span className="muted small">
                    {it.summary}
                    {it.scaleText ? ` · échelle ${it.scaleText}` : ''}
                    {it.note && it.kind === 'ignorer' ? ` · écartée : ${it.note}` : ''}
                  </span>
                </div>
                <select
                  value={it.kind}
                  aria-label={`Contenu de ${it.label}`}
                  onChange={(e) => setItems(items.map((x) => (x.id === it.id ? { ...x, kind: e.target.value as PlanKind, hinted: true, note: undefined } : x)))}
                >
                  {KIND_ORDER.map((k) => (
                    <option key={k} value={k}>
                      {PLAN_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button className="link" onClick={() => setItems(items.filter((x) => x.id !== it.id))} aria-label={`Retirer ${it.label}`}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {dup.length > 0 && <p className="warning">Deux plans pour le même niveau ({dup.map((k) => PLAN_KIND_LABELS[k]).join(', ')}) : un seul sera retracé.</p>}
        {items.length > 0 && !floors.length && <p className="warning">Ajoutez au moins un plan de niveau : la coupe seule ne donne pas les murs.</p>}
        {settings.aiEnabled && (
          <label className="toggle">
            <input type="checkbox" checked={useAi} disabled={!aiReady(settings)} onChange={(e) => setUseAi(e.target.checked)} /> Nommer aussi les pièces avec l'IA (facturé sur votre compte)
          </label>
        )}
        {busy && <p className="muted small">{busy}</p>}
        {error && <p className="warning">{error}</p>}
        {report && (
          <ul className="log">
            {report.lines.map((l, i) => (
              <li key={i}>✓ {l}</li>
            ))}
            {report.warnings.map((l, i) => (
              <li key={`w${i}`}>⚠ {l}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          {report ? (
            <button className="btn btn--primary" onClick={onClose}>
              Terminer
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={!!busy}>
                Annuler
              </button>
              <button className="btn btn--primary" onClick={() => void run()} disabled={!!busy || !floors.length}>
                Retracer {floors.length > 1 ? `les ${floors.length} niveaux` : 'le niveau'}
                {items.some((x) => x.kind === 'coupe') ? ' et lire la coupe' : ''}
              </button>
            </>
          )}
        </div>
        {report && <p className="muted small">Vérifiez chaque niveau avec les onglets au-dessus du plan ; « Annuler » (Ctrl+Z) revient à l'état d'avant l'import.</p>}
      </div>
    </div>
  );
}

async function toCanvas(f: File): Promise<HTMLCanvasElement> {
  const img = await createImageBitmap(f);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return c;
}
