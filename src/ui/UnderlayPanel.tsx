import { useEffect, useRef, useState } from 'react';
import { aiReadPlan } from '../ai';
import { putAsset, shrinkImage, useAsset } from '../assets';
import { dist, insertWall, newId, projectOnSegment } from '../model/geometry';
import { levelById } from '../model/levels';
import type { Opening, Wall } from '../model/types';
import { guessScale, vectorize, type Bitmap } from '../model/vectorize';
import { aiReady, useSettings } from '../settings';
import { useStore } from '../store';
import { useUi } from '../uiState';

/** Rend la première page d'un PDF dans un canvas (pdf.js n'est chargé qu'à ce moment-là). */
async function pdfToCanvas(file: File): Promise<HTMLCanvasElement> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 2400 / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function decode(dataUrl: string, maxSide: number): Promise<{ bmp: Bitmap; k: number }> {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { bmp: { width: d.width, height: d.height, data: d.data }, k };
}

function maskToDataUrl(mask: Uint8Array, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = 31;
    img.data[i * 4 + 1] = 111;
    img.data[i * 4 + 2] = 235;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Importer un plan existant (image ou PDF), l'étalonner, puis le faire retracer automatiquement. */
export function UnderlayPanel() {
  const levelId = useStore((s) => s.levelId);
  const existing = useStore((s) => s.project.existing);
  const editExisting = useStore((s) => s.editExisting);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const settings = useSettings();
  const ui = useUi();
  const level = levelById(existing, levelId);
  const ul = level?.underlay;
  const src = useAsset(ul?.assetId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realLength, setRealLength] = useState('');
  const [minThick, setMinThick] = useState(7);
  const levelWalls = existing.walls.filter((w) => w.levelId === levelId).length;

  useEffect(() => () => useUi.getState().set({ tracePreview: null, moveUnderlay: false }), []);
  useEffect(() => ui.set({ tracePreview: null }), [levelId, minThick]); // eslint-disable-line react-hooks/exhaustive-deps

  const setUl = (fn: (u: NonNullable<typeof ul>) => void) =>
    editExisting((b) => {
      const l = b.levels.find((x) => x.id === levelId);
      if (l?.underlay) fn(l.underlay);
    });

  async function onFile(file: File) {
    setError(null);
    setBusy('Lecture du plan…');
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const shrunk = await shrinkImage(isPdf ? await pdfToCanvas(file) : file, 2400, 0.86);
      const { bmp, k } = await decode(shrunk.dataUrl, 1200);
      const scale = guessScale(bmp) * k;
      const assetId = await putAsset(shrunk.dataUrl);
      editExisting((b) => {
        const l = b.levels.find((x) => x.id === levelId);
        if (!l) return;
        const walls = b.walls.filter((w) => w.levelId === levelId);
        const x0 = walls.length ? Math.min(...walls.map((w) => Math.min(w.a.x, w.b.x))) : 0;
        const y0 = walls.length ? Math.min(...walls.map((w) => Math.min(w.a.y, w.b.y))) : 0;
        l.underlay = { assetId, x: x0, y: y0, scale, width: shrunk.width, height: shrunk.height, opacity: 0.55, visible: true, calibrated: false };
      });
      setTool('calibrate');
      ui.set({ calibration: [] });
    } catch (e) {
      setError(`Impossible de lire ce fichier (${(e as Error).message}).`);
    }
    setBusy(null);
  }

  async function trace(apply: boolean) {
    if (!ul || !src) return;
    setError(null);
    setBusy(apply ? 'Retraçage…' : 'Analyse…');
    try {
      const { bmp, k } = await decode(src, 1600);
      const scale = ul.scale / k;
      const r = vectorize(bmp, { scale, minThickness: minThick / 100 });
      if (!apply) {
        ui.set({ tracePreview: maskToDataUrl(r.mask, bmp.width, bmp.height) });
        setBusy(null);
        return;
      }
      if (!r.walls.length) throw new Error('aucun mur trouvé : réduisez l’épaisseur minimale ou étalonnez le plan');
      if (levelWalls && !confirm(`Remplacer les ${levelWalls} murs déjà dessinés sur ce niveau par le retraçage ?`)) {
        setBusy(null);
        return;
      }
      const level_ = level!;
      editExisting((b) => {
        const old = new Set(b.walls.filter((w) => w.levelId === levelId).map((w) => w.id));
        b.walls = b.walls.filter((w) => !old.has(w.id));
        b.openings = b.openings.filter((o) => !old.has(o.wallId));
        const placed: { wall: Wall; openings: typeof r.openings }[] = [];
        r.walls.forEach((tw, i) => {
          const wall: Wall = {
            id: newId('w'),
            levelId,
            a: { x: tw.a.x + ul.x, y: tw.a.y + ul.y },
            b: { x: tw.b.x + ul.x, y: tw.b.y + ul.y },
            thickness: tw.thickness,
            height: level_.height,
            kind: tw.thickness >= 0.2 ? 'porteur' : 'cloison',
            finish: { gauche: null, droite: null },
          };
          insertWall(b, wall);
          placed.push({ wall, openings: r.openings.filter((o) => o.wall === i) });
        });
        // Les ouvertures sont rattachées au tronçon de mur qui les contient après découpe.
        for (const { wall, openings } of placed) {
          for (const o of openings) {
            const L = dist(wall.a, wall.b);
            const t = o.offset / L;
            const pt = { x: wall.a.x + (wall.b.x - wall.a.x) * t, y: wall.a.y + (wall.b.y - wall.a.y) * t };
            const piece = b.walls.find((w) => w.levelId === levelId && projectOnSegment(pt, w.a, w.b).d < 0.02);
            if (!piece) continue;
            const op: Opening = {
              id: newId('o'),
              wallId: piece.id,
              kind: o.kind,
              offset: dist(piece.a, pt),
              width: o.width,
              height: o.kind === 'porte' ? 2.05 : 1.25,
              sill: o.kind === 'porte' ? 0 : 0.9,
              productId: o.kind === 'porte' ? 'ex-porte-isoplane' : 'ex-fenetre-bois-simple',
            };
            b.openings.push(op);
          }
        }
      });
      ui.set({ tracePreview: null });
      setUl((u) => void (u.opacity = Math.min(u.opacity, 0.35)));
    } catch (e) {
      setError(`Retraçage impossible : ${(e as Error).message}.`);
    }
    setBusy(null);
  }

  async function aiNames() {
    if (!ul || !src) return;
    setError(null);
    setBusy("L'IA lit le plan…");
    try {
      const res = await aiReadPlan(src, ul.width, ul.height);
      editExisting((b) => {
        for (const r of res.rooms) {
          b.rooms = b.rooms.filter((x) => !(x.levelId === levelId && dist(x.at, { x: ul.x + r.x * ul.scale, y: ul.y + r.y * ul.scale }) < 0.5));
          b.rooms.push({ id: newId('r'), levelId, at: { x: ul.x + r.x * ul.scale, y: ul.y + r.y * ul.scale }, name: r.name, floorProductId: null });
        }
        // Portes et fenêtres que le retraçage n'a pas vues
        const walls = b.walls.filter((w) => w.levelId === levelId);
        for (const o of res.openings) {
          const pt = { x: ul.x + o.x * ul.scale, y: ul.y + o.y * ul.scale };
          let best: { w: Wall; d: number } | null = null;
          for (const w of walls) {
            const d = projectOnSegment(pt, w.a, w.b).d;
            if (d < 0.4 && (!best || d < best.d)) best = { w, d };
          }
          if (!best) continue;
          const offset = dist(best.w.a, projectOnSegment(pt, best.w.a, best.w.b).point);
          if (b.openings.some((x) => x.wallId === best!.w.id && Math.abs(x.offset - offset) < 0.5)) continue;
          b.openings.push({
            id: newId('o'),
            wallId: best.w.id,
            kind: o.kind,
            offset,
            width: Math.max(0.5, Math.min(3, o.width_px * ul.scale)),
            height: o.kind === 'porte' ? 2.05 : 1.25,
            sill: o.kind === 'porte' ? 0 : 0.9,
            productId: o.kind === 'porte' ? 'ex-porte-isoplane' : 'ex-fenetre-bois-simple',
          });
        }
      });
    } catch (e) {
      setError(`Lecture par l'IA impossible : ${(e as Error).message}`);
    }
    setBusy(null);
  }

  const cal = ui.calibration;
  const measured = cal.length === 2 ? dist(cal[0], cal[1]) : 0;

  return (
    <>
      <h4>Plan existant (image ou PDF)</h4>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      {!ul && (
        <>
          <p className="muted small">Importez le plan d'architecte, un scan ou une photo bien droite du plan : il s'affiche sous le dessin et peut être retracé automatiquement.</p>
          <button className="btn" onClick={() => input.current?.click()} disabled={!!busy}>
            Importer un plan…
          </button>
        </>
      )}
      {ul && (
        <div className="underlay">
          <ol className="steps-list">
            <li className={ul.calibrated ? 'is-done' : ''}>
              <strong>Mettre à l'échelle</strong>
              {tool === 'calibrate' ? (
                cal.length < 2 ? (
                  <p className="muted small">Cliquez les deux extrémités d'une cote connue sur le plan (par exemple la longueur d'une façade).</p>
                ) : (
                  <div className="inline-form">
                    <label className="field">
                      <span>Longueur réelle (m)</span>
                      <input autoFocus type="number" step={0.01} min={0.1} value={realLength} onChange={(e) => setRealLength(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                    </label>
                    <button
                      className="btn btn--primary"
                      disabled={!(Number(realLength) > 0) || measured <= 0}
                      onClick={() => {
                        const k = Number(realLength) / measured;
                        const p0 = cal[0];
                        setUl((u) => {
                          u.x = p0.x - (p0.x - u.x) * k;
                          u.y = p0.y - (p0.y - u.y) * k;
                          u.scale *= k;
                          u.calibrated = true;
                        });
                        ui.set({ calibration: [] });
                        setRealLength('');
                        setTool('select');
                      }}
                    >
                      Valider
                    </button>
                  </div>
                )
              ) : (
                <p className="muted small">
                  {ul.calibrated ? 'Échelle mesurée. ' : 'Échelle estimée d’après l’épaisseur des murs. '}
                  <button className="link" onClick={() => { setTool('calibrate'); ui.set({ calibration: [] }); }}>
                    {ul.calibrated ? 'Refaire' : 'Étalonner sur une cote'}
                  </button>
                </p>
              )}
            </li>
            <li>
              <strong>Retracer automatiquement</strong>
              <label className="field">
                <span>Épaisseur minimale d'un mur : {minThick} cm</span>
                <input type="range" min={3} max={25} value={minThick} onChange={(e) => setMinThick(Number(e.target.value))} />
              </label>
              <div className="actions">
                <button className="btn" onClick={() => void trace(false)} disabled={!!busy}>
                  Aperçu
                </button>
                <button className="btn btn--primary" onClick={() => void trace(true)} disabled={!!busy}>
                  Retracer les murs
                </button>
              </div>
              <p className="muted small">Les murs épais deviennent porteurs, les trous dans les murs des portes (vides) ou des fenêtres (traits fins). Vérifiez et corrigez ensuite à la main.</p>
            </li>
            {settings.aiEnabled && (
              <li>
                <strong>Lire le plan avec l'IA</strong>
                <p className="muted small">Nomme les pièces et ajoute les portes et fenêtres oubliées.</p>
                <button className="btn" onClick={() => void aiNames()} disabled={!!busy || !aiReady(settings)} title={aiReady(settings) ? '' : "Renseignez la clé API dans l'administration"}>
                  Analyser avec l'IA
                </button>
              </li>
            )}
          </ol>
          <div className="fields">
            <label className="field">
              <span>Opacité</span>
              <input type="range" min={0.1} max={1} step={0.05} value={ul.opacity} onChange={(e) => setUl((u) => void (u.opacity = Number(e.target.value)))} />
            </label>
            <label className="toggle">
              <input type="checkbox" checked={ul.visible} onChange={(e) => setUl((u) => void (u.visible = e.target.checked))} /> Afficher
            </label>
            <label className="toggle">
              <input type="checkbox" checked={ui.moveUnderlay} onChange={(e) => ui.set({ moveUnderlay: e.target.checked })} /> Déplacer le plan
            </label>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => input.current?.click()} disabled={!!busy}>
              Remplacer…
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                // L'image reste stockée : « Annuler » peut remettre le plan.
                editExisting((b) => {
                  const l = b.levels.find((x) => x.id === levelId);
                  if (l) delete l.underlay;
                });
                ui.set({ tracePreview: null });
              }}
            >
              Retirer le plan
            </button>
          </div>
        </div>
      )}
      {busy && <p className="muted small">{busy}</p>}
      {error && <p className="warning">{error}</p>}
    </>
  );
}
