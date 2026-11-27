import { useEffect, useRef, useState } from 'react';
import { aiReadPlan } from '../ai';
import { putAsset, shrinkImage, useAsset } from '../assets';
import { dist } from '../model/geometry';
import { levelById } from '../model/levels';
import { autoVectorize, guessScale, WALL_STYLE_LABELS, type AutoVectorizeResult } from '../model/vectorize';
import { alignWalls, footprint, parseDrawingScale, pdfScale } from '../model/plans';
import { applyAiReading, applyTrace, groundLevel } from '../traceApply';
import { aiIsLocal, aiReady, useSettings } from '../settings';
import { reviewLevel } from '../aiReview';
import { decode, isPdf, maskToDataUrl, nextFrame, pdfPages } from '../planFiles';
import { useStore } from '../store';
import { PlansImport } from './PlansImport';
import { useUi } from '../uiState';

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
  const [found, setFound] = useState<string | null>(null);
  const [multi, setMulti] = useState(false);
  const [aiReport, setAiReport] = useState<string[]>([]);
  const levelWalls = existing.walls.filter((w) => w.levelId === levelId).length;

  useEffect(() => () => useUi.getState().set({ tracePreview: null, moveUnderlay: false }), []);
  useEffect(() => {
    ui.set({ tracePreview: null });
    setFound(null);
  }, [levelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const describe = (r: AutoVectorizeResult) =>
    `Reconnu : ${WALL_STYLE_LABELS[r.style]}, murs de ${Math.round(r.thick * 100)} cm et cloisons de ${Math.round(r.thin * 100)} cm, ` +
    `${r.walls.length} murs, ${r.openings.filter((o) => o.kind === 'porte').length} portes, ${r.openings.filter((o) => o.kind === 'fenetre').length} fenêtres, ${r.rooms} pièce${r.rooms > 1 ? 's' : ''}.`;

  const setUl = (fn: (u: NonNullable<typeof ul>) => void) =>
    editExisting((b) => {
      const l = b.levels.find((x) => x.id === levelId);
      if (l?.underlay) fn(l.underlay);
    });

  /**
   * Murs de référence pour caler ce plan : ceux déjà dessinés sur ce niveau, sinon ceux du rez-de-chaussée
   * (ou du niveau le plus proche qui en a). Les murs recopiés automatiquement d'un autre niveau comptent aussi.
   */
  const reference = (b: typeof existing) => {
    const own = b.walls.filter((w) => w.levelId === levelId);
    if (own.length) return own;
    const g = groundLevel(b);
    const ground = b.walls.filter((w) => w.levelId === g.id);
    if (ground.length) return ground;
    const any = [...b.levels].sort((m, n) => Math.abs(m.elevation - (level?.elevation ?? 0)) - Math.abs(n.elevation - (level?.elevation ?? 0)));
    for (const l of any) {
      const ws = b.walls.filter((w) => w.levelId === l.id);
      if (ws.length) return ws;
    }
    return [];
  };

  /** Même document, même résolution : on reprend l'échelle d'un plan déjà importé sur un autre niveau. */
  const sharedScale = (b: typeof existing, width: number, height: number) => {
    const others = b.levels.filter((l) => l.id !== levelId && l.underlay).map((l) => l.underlay!);
    const same = others.filter((u) => Math.abs(u.width - width) / width < 0.02 && Math.abs(u.height - height) / height < 0.02);
    return (same.find((u) => u.calibrated) ?? same[0])?.scale ?? null;
  };

  async function onFile(file: File) {
    setError(null);
    setBusy('Lecture du plan…');
    try {
      const page = isPdf(file) ? (await pdfPages(file, 2400, 1))[0] : null;
      const shrunk = await shrinkImage(page ? page.canvas : file, 2400, 0.86);
      // Échelle écrite dans le cartouche du PDF (« 1/50 ») : exacte, avec le format de la page
      const denom = page ? parseDrawingScale(page.text) : null;
      const pdfKnown = denom && page?.pxPerPt ? pdfScale(page.pxPerPt * (shrunk.width / page.canvas.width), denom) : null;
      setBusy('Analyse du dessin des murs…');
      await nextFrame();
      const { bmp, k } = await decode(shrunk.dataUrl, 1600);
      const b0 = useStore.getState().project.existing;
      const shared = sharedScale(b0, shrunk.width, shrunk.height);
      // L'aspect des murs est reconnu tout seul ; l'échelle s'en déduit (murs extérieurs ≈ 30 cm),
      // sauf si un autre niveau du même dossier a déjà la sienne.
      const estimate = autoVectorize(bmp);
      const known = shared ?? (pdfKnown && (!estimate || Math.abs(pdfKnown / (estimate.scale * k) - 1) < 0.35) ? pdfKnown : null);
      const auto = known ? autoVectorize(bmp, { scale: known / k }) : estimate;
      const scale = known ?? (auto?.scale ?? guessScale(bmp)) * k;
      const assetId = await putAsset(shrunk.dataUrl);
      // Calage sur les murs connus (ce niveau, ou le rez-de-chaussée)
      const ref = reference(b0);
      const al = auto && ref.length ? alignWalls(auto.walls, ref, !known) : null;
      const placeOk = al && al.fit > 0.25;
      editExisting((b) => {
        const l = b.levels.find((x) => x.id === levelId);
        if (!l) return;
        const fb = auto ? footprint(auto.walls) : null;
        const x = placeOk ? al!.dx : fb && !ref.length ? -fb.x0 : 0;
        const y = placeOk ? al!.dy : fb && !ref.length ? -fb.y0 : 0;
        l.underlay = { assetId, x, y, scale: scale * (placeOk ? al!.k : 1), width: shrunk.width, height: shrunk.height, opacity: 0.55, visible: true, calibrated: false };
      });
      if (auto) {
        ui.set({ tracePreview: maskToDataUrl(auto.mask, bmp.width, bmp.height) });
        setFound(describe(auto) + (denom && known === pdfKnown ? ` Échelle 1/${denom} lue sur le PDF.` : '') + (placeOk ? ` Calé sur les murs déjà connus (${Math.round(al!.fit * 100)} % se superposent).` : ''));
      } else setFound(null);
    } catch (e) {
      setError(`Impossible de lire ce fichier (${(e as Error).message}).`);
    }
    setBusy(null);
  }

  async function trace(apply: boolean) {
    if (!ul || !src) return;
    setError(null);
    setBusy(apply ? 'Retraçage…' : 'Analyse du dessin des murs…');
    try {
      await nextFrame();
      const { bmp, k } = await decode(src, 1600);
      // Le plan affiché a déjà son échelle (estimée, partagée ou étalonnée) : le retraçage la reprend.
      const r = autoVectorize(bmp, { scale: ul.scale / k });
      if (!r || !r.walls.length) {
        throw new Error('aucun mur reconnu sur ce plan. Vérifiez qu’il est bien droit et lisible (un PDF d’architecte donne le meilleur résultat), ou dessinez les murs à la main par-dessus');
      }
      setFound(describe(r));
      if (!apply) {
        ui.set({ tracePreview: maskToDataUrl(r.mask, bmp.width, bmp.height) });
        setBusy(null);
        return;
      }
      if (levelWalls && !confirm(`Remplacer les ${levelWalls} murs déjà dessinés sur ${level?.name ?? 'ce niveau'} par le retraçage ?`)) {
        setBusy(null);
        return;
      }
      editExisting((b) => applyTrace(b, levelId, r, ul.x, ul.y));
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
    setAiReport([]);
    setBusy("L'IA lit le plan…");
    try {
      const local = aiIsLocal();
      if (!local) {
        const res = await aiReadPlan(src, ul.width, ul.height);
        editExisting((b) => applyAiReading(b, levelId, ul, res));
      }
      // Relecture vue par vue : chaque ouverture, chaque façade (et les pièces sans nom avec l'IA locale)
      const rv = await reviewLevel(levelId, setBusy, { rooms: local });
      setAiReport([...rv.lines, ...rv.warnings.map((w) => `⚠ ${w}`)]);
    } catch (e) {
      setError(`Lecture par l'IA impossible : ${(e as Error).message}`);
    }
    setBusy(null);
  }

  const cal = ui.calibration;
  const measured = cal.length === 2 ? dist(cal[0], cal[1]) : 0;

  return (
    <>
      <h4>Plans existants</h4>
      {multi && <PlansImport onClose={() => setMulti(false)} />}
      <p className="muted small">
        Le plus simple : importez d'un coup tous les plans (chaque niveau et les coupes). Ils sont retracés ensemble, les étages calés sur le rez-de-chaussée.
      </p>
      <button className="btn btn--primary" onClick={() => setMulti(true)} disabled={!!busy}>
        Importer tous les plans (niveaux et coupes)…
      </button>
      <h4 className="underlay__level">
        Plan de ce niveau : <span className="tag">{level?.name ?? '—'}</span>
      </h4>
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
          <p className="muted small">
            Ou seulement le plan de {level?.name.toLowerCase() ?? 'ce niveau'} (plan d'architecte, scan ou photo bien droite) : il s'affiche sous le dessin et peut être retracé
            automatiquement. Changez de niveau avec les onglets au-dessus du plan.
          </p>
          <button className="btn" onClick={() => input.current?.click()} disabled={!!busy}>
            Importer le plan de {level?.name.toLowerCase() ?? 'ce niveau'}…
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
                  {ul.calibrated ? 'Échelle mesurée. ' : 'Échelle estimée d’après l’épaisseur des murs (facultatif : étalonner pour plus de précision). '}
                  <button className="link" onClick={() => { setTool('calibrate'); ui.set({ calibration: [] }); }}>
                    {ul.calibrated ? 'Refaire' : 'Étalonner sur une cote'}
                  </button>
                </p>
              )}
            </li>
            <li>
              <strong>Retracer automatiquement</strong>
              <div className="actions">
                <button className="btn" onClick={() => void trace(false)} disabled={!!busy}>
                  Aperçu des murs reconnus
                </button>
                <button className="btn btn--primary" onClick={() => void trace(true)} disabled={!!busy}>
                  Retracer les murs
                </button>
              </div>
              {found && <p className="small">{found}</p>}
              <p className="muted small">
                Aucun réglage : l'application reconnaît d'elle-même comment les murs sont dessinés (noirs, gris ou en couleur, hachurés, ou en double trait), leur épaisseur et les
                portes et fenêtres. Les murs épais deviennent porteurs. Vérifiez et corrigez ensuite à la main.
              </p>
            </li>
            {settings.aiEnabled && (
              <li>
                <strong>Lire le plan avec l'IA</strong>
                <p className="muted small">
                  {settings.aiProvider === 'locale' ? `IA locale (${settings.localModel}), rien n'est envoyé dehors. ` : ''}
                  Relit chaque porte et fenêtre (fausses portes, porte ou fenêtre, sens d'ouverture), cherche les baies oubliées sur les façades et nomme les pièces. Les corrections
                  douteuses sont marquées « ? » sur le plan.
                </p>
                <button className="btn" onClick={() => void aiNames()} disabled={!!busy || !aiReady(settings)} title={aiReady(settings) ? '' : "Réglez l'IA dans l'administration"}>
                  Analyser avec l'IA
                </button>
                {aiReport.length > 0 && (
                  <ul className="log">
                    {aiReport.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )}
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
