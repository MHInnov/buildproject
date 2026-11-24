import { useRef, useState } from 'react';
import { removeViewpoint, updateViewpoint } from '../actions';
import { aiReadPhoto, type AiPhotoElement } from '../ai';
import { putAsset, shrinkImage, useAsset } from '../assets';
import { productById, type Product } from '../model/catalog';
import { aiReady, useSettings } from '../settings';
import { useStore } from '../store';
import { useUi } from '../uiState';
import { closestByColor, placeFromPhoto, sampleColor, TARGET_LABELS, type PhotoTarget } from '../viewpoints';
import { patternUrl } from '../textures/patterns';

interface Mark {
  u: number;
  v: number;
  color: string;
}

/**
 * Point de vue : la photo est placée et orientée sur le plan.
 * Un clic sur la photo désigne un élément ; l'application calcule où il se trouve dans la maison
 * (rayon depuis le point de vue jusqu'au mur ou au sol) et le place, avec le matériau le plus proche en couleur.
 */
export function ViewpointPanel({ id }: { id: string }) {
  const v = useStore((s) => s.project.viewpoints.find((x) => x.id === id));
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const catalog = useStore((s) => s.catalog);
  const settings = useSettings();
  const photo = useAsset(v?.assetId);
  const input = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [mark, setMark] = useState<Mark | null>(null);
  const [target, setTarget] = useState<PhotoTarget>('sol');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<AiPhotoElement[] | null>(null);
  if (!v) return null;
  const isExisting = step === 'existant';
  const aspect = img.current && img.current.naturalHeight ? img.current.naturalWidth / img.current.naturalHeight : 4 / 3;
  const candidates: Product[] = mark ? closestByColor(catalog, target, mark.color, isExisting).slice(0, 6) : [];

  const apply = (product: Product, u: number, w: number, t: PhotoTarget, apparentWidth?: number) => {
    const r = placeFromPhoto(v, u, w, aspect, t, product, apparentWidth);
    setLog((l) => [`${r.ok ? '✓' : '⚠'} ${r.message}`, ...l].slice(0, 6));
    return r.ok;
  };

  return (
    <div className="panel">
      <h3>Point de vue</h3>
      <input
        className="title-input"
        placeholder="Légende (ex. « séjour vers la cuisine »)"
        value={v.caption}
        onChange={(e) => updateViewpoint(id, (x) => void (x.caption = e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const s = await shrinkImage(f, 1600, 0.82);
          const assetId = await putAsset(s.dataUrl);
          updateViewpoint(id, (x) => void (x.assetId = assetId));
        }}
      />
      {!photo ? (
        <>
          <p className="muted small">Ajoutez la photo prise depuis cet endroit. Placez le point sur le plan et tournez la poignée dans la direction de la prise de vue.</p>
          <button className="btn btn--primary" onClick={() => input.current?.click()}>
            Ajouter la photo…
          </button>
        </>
      ) : (
        <>
          <div className="photo" onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const u = (e.clientX - r.left) / r.width;
            const w = (e.clientY - r.top) / r.height;
            setMark({ u, v: w, color: img.current ? sampleColor(img.current, u, w) : '#888888' });
          }}>
            <img ref={img} src={photo} alt={v.caption || 'Photo du point de vue'} />
            {mark && <span className="photo__mark" style={{ left: `${mark.u * 100}%`, top: `${mark.v * 100}%` }} />}
            {found?.map((f, i) => (
              <span key={i} className="photo__found" style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%` }} title={f.description}>
                {i + 1}
              </span>
            ))}
          </div>
          <p className="muted small">Cliquez sur un sol, un mur, une porte, une fenêtre ou un meuble de la photo pour le reporter sur le plan.</p>
          {mark && (
            <div className="photo-pick">
              <div className="segmented segmented--small">
                {(Object.keys(TARGET_LABELS) as PhotoTarget[]).map((t) => (
                  <button key={t} className={target === t ? 'is-active' : ''} onClick={() => setTarget(t)}>
                    {TARGET_LABELS[t]}
                  </button>
                ))}
              </div>
              <p className="muted small">
                Couleur relevée <span className="swatch swatch--inline" style={{ background: mark.color }} /> : produits les plus proches
              </p>
              <ul className="picker__list">
                {candidates.map((p) => (
                  <li key={p.id}>
                    <button
                      className="picker__item"
                      onClick={() => {
                        if (apply(p, mark.u, mark.v, target)) setMark(null);
                      }}
                    >
                      <span className="swatch" style={{ backgroundColor: p.color, backgroundImage: p.pattern ? `url(${patternUrl(p.pattern, p.color, 48)})` : undefined }} />
                      <span className="picker__name">
                        {p.name}
                        <small>{p.brand}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {settings.aiEnabled && (
            <div className="actions">
              <button
                className="btn"
                disabled={busy || !aiReady(settings)}
                title={aiReady(settings) ? '' : "Renseignez la clé API dans l'administration"}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const list = catalog.products
                      .filter((p) => ['sol', 'peinture', 'mur', 'faience', 'porte', 'fenetre', 'meuble'].includes(p.category) && (isExisting || !p.existingOnly))
                      .map((p) => ({ id: p.id, name: p.name, kind: p.category }));
                    setFound(await aiReadPhoto(photo, list));
                  } catch (e) {
                    setLog((l) => [`⚠ Analyse impossible : ${(e as Error).message}`, ...l]);
                  }
                  setBusy(false);
                }}
              >
                {busy ? 'Analyse en cours…' : "Analyser la photo avec l'IA"}
              </button>
            </div>
          )}
          {found && (
            <div className="found">
              <h4>Éléments reconnus ({found.length})</h4>
              <ol>
                {found.map((f, i) => {
                  const p = productById(catalog, f.productId);
                  return (
                    <li key={i}>
                      <span>
                        <strong>{TARGET_LABELS[f.kind]}</strong> : {f.description}
                        {p ? ` → ${p.name}` : ''}
                      </span>
                      {p && (
                        <button className="btn btn--small" onClick={() => apply(p, f.x, f.y, f.kind, f.width)}>
                          Placer
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
              <button
                className="btn"
                onClick={() => {
                  for (const f of found) {
                    const p = productById(catalog, f.productId);
                    if (p) apply(p, f.x, f.y, f.kind, f.width);
                  }
                  setFound(null);
                }}
              >
                Tout placer
              </button>
            </div>
          )}
          {log.length > 0 && (
            <ul className="log">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="fields">
        <label className="field">
          <span>Direction (°)</span>
          <input type="number" value={v.direction} onChange={(e) => updateViewpoint(id, (x) => void (x.direction = Number(e.target.value) % 360))} />
        </label>
        <label className="field">
          <span>Angle de vue (°)</span>
          <input type="number" min={30} max={120} value={v.fov} onChange={(e) => updateViewpoint(id, (x) => void (x.fov = Math.min(120, Math.max(30, Number(e.target.value)))))} />
        </label>
        <label className="field">
          <span>Hauteur de l'appareil (m)</span>
          <input type="number" step={0.05} min={0.3} max={2.5} value={v.eye} onChange={(e) => updateViewpoint(id, (x) => void (x.eye = Number(e.target.value)))} />
        </label>
      </div>
      <p className="muted small">
        Les distances déduites d'une photo restent approximatives : les dimensions des pièces se mesurent sur le plan. Smartphone : environ 66° en mode normal, 100° en grand-angle.
      </p>
      <div className="actions">
        {photo && (
          <button
            className="btn"
            onClick={() => {
              useUi.getState().set({ viewFrom: id });
              setStep('visite');
            }}
          >
            Comparer en 3D
          </button>
        )}
        {photo && (
          <button className="btn" onClick={() => input.current?.click()}>
            Changer la photo
          </button>
        )}
        <button className="btn btn--danger" onClick={() => removeViewpoint(id)}>
          Supprimer
        </button>
      </div>
    </div>
  );
}
