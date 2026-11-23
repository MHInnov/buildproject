import { useMemo, useState } from 'react';
import { computeEstimate, euro, type EstimateLine } from '../model/estimate';
import { LOT_LABELS } from '../model/types';
import { useStore } from '../store';

const q = (n: number) => n.toLocaleString('fr-BE', { maximumFractionDigits: 2 });

export function useEstimate() {
  const project = useStore((s) => s.project);
  const catalog = useStore((s) => s.catalog);
  return useMemo(() => computeEstimate(project, catalog), [project, catalog]);
}

/** Étape 5 : résumé chiffré poste par poste, avec un mode détail. */
export function Summary() {
  const e = useEstimate();
  const project = useStore((s) => s.project);
  const updateProject = useStore((s) => s.updateProject);
  const [detail, setDetail] = useState(false);
  const vat = Math.round(e.vatRate * 100);

  return (
    <div className="summary">
      <header className="summary__head">
        <div>
          <h2>Résumé du projet : {project.name}</h2>
          <p className="muted">
            Estimation indicative du {new Date().toLocaleDateString('fr-BE')}. Matériaux aux prix publics TTC, main d'œuvre en fourchette avec TVA {vat} %.
          </p>
        </div>
        <div className="summary__tools no-print">
          <label className="toggle">
            <input type="checkbox" checked={detail} onChange={(ev) => setDetail(ev.target.checked)} /> Mode détail
          </label>
          <label className="toggle">
            <input type="checkbox" checked={project.olderThan10Years} onChange={(ev) => updateProject((p) => void (p.olderThan10Years = ev.target.checked))} />
            Logement de plus de 10 ans (TVA 6 %, à vérifier)
          </label>
          <button className="btn" onClick={() => window.print()}>
            Imprimer / PDF
          </button>
        </div>
      </header>

      <div className="kpis">
        <div className="kpi">
          <span>Total estimé TVAC</span>
          <strong>
            {euro(e.totalMin)} à {euro(e.totalMax)}
          </strong>
        </div>
        <div className="kpi">
          <span>Matériaux et équipements</span>
          <strong>{euro(e.materialTotal)}</strong>
        </div>
        <div className="kpi">
          <span>Main d'œuvre HTVA</span>
          <strong>
            {euro(e.laborMin)} à {euro(e.laborMax)}
          </strong>
        </div>
      </div>

      {e.warnings.map((w) => (
        <p key={w} className="warning">
          {w}
        </p>
      ))}

      {e.lots.length === 0 && (
        <p className="empty">Aucune modification pour l'instant. Passez à l'étape « Projet » pour démolir, changer un sol ou ajouter des meubles : le chiffrage apparaîtra ici.</p>
      )}

      {e.lots.map((lot) => {
        const artisanId = project.assignments[lot.lot];
        const artisan = project.artisans.find((a) => a.id === artisanId);
        return (
          <section key={lot.lot} className="lot">
            <header className="lot__head">
              <h3>{LOT_LABELS[lot.lot]}</h3>
              <span className="muted">{artisan ? `Artisan : ${artisan.name}` : 'Artisan à choisir'}</span>
              <span className="lot__total">
                {euro(lot.materialTotal + lot.laborMin * (1 + e.vatRate))} à {euro(lot.materialTotal + lot.laborMax * (1 + e.vatRate))}
              </span>
            </header>
            <table className="table">
              <thead>
                <tr>
                  <th>Poste</th>
                  <th className="num">Matériaux</th>
                  <th className="num">Main d'œuvre HTVA</th>
                </tr>
              </thead>
              <tbody>
                {lot.lines.map((l) => (
                  <LineRows key={l.id} l={l} detail={detail} />
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      <p className="muted small">
        Les prix du catalogue de démonstration sont fictifs. Les fourchettes de main d'œuvre sont indicatives et doivent être confirmées par des devis d'artisans.
      </p>
    </div>
  );
}

function LineRows({ l, detail }: { l: EstimateLine; detail: boolean }) {
  return (
    <>
      <tr className="line">
        <td>
          <strong>{l.title}</strong>
          {l.subtitle && <div className="muted small">{l.subtitle}</div>}
          {l.warnings.map((w) => (
            <div key={w} className="warning small">
              {w}
            </div>
          ))}
        </td>
        <td className="num">{l.materialTotal ? euro(l.materialTotal) : '–'}</td>
        <td className="num">
          {euro(l.laborMin)} à {euro(l.laborMax)}
        </td>
      </tr>
      {detail &&
        l.materials.map((m, i) => (
          <tr key={`m${i}`} className="detail">
            <td>
              Fourniture : {m.label}, {q(m.quantity)} {m.unit} × {euro(m.unitPrice)}
              {m.takeoff && <div className="muted small">Métré : {m.takeoff}</div>}
            </td>
            <td className="num">{euro(m.total)}</td>
            <td />
          </tr>
        ))}
      {detail &&
        l.labor.map((t, i) => (
          <tr key={`t${i}`} className="detail">
            <td>
              {t.label} : {q(t.quantity)} {t.unit}
            </td>
            <td />
            <td className="num">
              {euro(t.min)} à {euro(t.max)}
            </td>
          </tr>
        ))}
    </>
  );
}
