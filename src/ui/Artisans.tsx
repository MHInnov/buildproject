import { useState } from 'react';
import { newId } from '../model/geometry';
import { LOT_LABELS, LOT_ORDER, type Artisan, type Lot } from '../model/types';
import { useStore } from '../store';
import { useEstimate } from './Summary';
import { euro } from '../model/estimate';

const blank = (): Omit<Artisan, 'id'> => ({ name: '', lots: [], city: '', phone: '', email: '', notes: '' });

/**
 * Étape 4 : choix des artisans par poste.
 * MVP : carnet d'adresses local et lien de recherche ; l'annuaire automatique (BCE + Google Places) viendra en phase 3.
 */
export function Artisans() {
  const project = useStore((s) => s.project);
  const updateProject = useStore((s) => s.updateProject);
  const e = useEstimate();
  const [draft, setDraft] = useState(blank());
  const neededLots = e.lots.map((l) => l.lot);
  const lots = neededLots.length ? neededLots : LOT_ORDER;

  const searchUrl = (lot: Lot) =>
    `https://www.google.com/maps/search/${encodeURIComponent(`${LOT_LABELS[lot]} entrepreneur ${project.postalCode || 'Belgique'}`)}`;

  return (
    <div className="artisans">
      <section>
        <h2>Artisans par poste</h2>
        <p className="muted">
          Choisissez un artisan pour chaque poste du projet. Un même artisan peut couvrir plusieurs postes.
        </p>
        <label className="field field--inline">
          <span>Code postal du chantier</span>
          <input value={project.postalCode} onChange={(ev) => updateProject((p) => void (p.postalCode = ev.target.value))} placeholder="ex. 1300" />
        </label>
        <table className="table">
          <thead>
            <tr>
              <th>Poste</th>
              <th className="num">Budget estimé</th>
              <th>Artisan retenu</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lots.map((lot) => {
              const s = e.lots.find((l) => l.lot === lot);
              const candidates = project.artisans.filter((a) => a.lots.includes(lot));
              return (
                <tr key={lot}>
                  <td>{LOT_LABELS[lot]}</td>
                  <td className="num">{s ? `${euro(s.materialTotal + s.laborMin * (1 + e.vatRate))} à ${euro(s.materialTotal + s.laborMax * (1 + e.vatRate))}` : '–'}</td>
                  <td>
                    <select
                      value={project.assignments[lot] ?? ''}
                      onChange={(ev) => updateProject((p) => void (p.assignments[lot] = ev.target.value || undefined))}
                    >
                      <option value="">{candidates.length ? 'Choisir…' : 'Aucun artisan pour ce poste'}</option>
                      {candidates.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} {a.city && `(${a.city})`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <a href={searchUrl(lot)} target="_blank" rel="noreferrer">
                      Chercher à proximité
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="artisans__book">
        <h3>Mon carnet d'artisans</h3>
        <form
          className="artisan-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!draft.name.trim() || !draft.lots.length) return;
            updateProject((p) => void p.artisans.push({ ...draft, id: newId('a') }));
            setDraft(blank());
          }}
        >
          <input placeholder="Nom de l'entreprise" value={draft.name} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })} />
          <input placeholder="Commune" value={draft.city} onChange={(ev) => setDraft({ ...draft, city: ev.target.value })} />
          <input placeholder="Téléphone" value={draft.phone} onChange={(ev) => setDraft({ ...draft, phone: ev.target.value })} />
          <input placeholder="E-mail" value={draft.email} onChange={(ev) => setDraft({ ...draft, email: ev.target.value })} />
          <div className="checks">
            {LOT_ORDER.map((lot) => (
              <label key={lot} className="toggle">
                <input
                  type="checkbox"
                  checked={draft.lots.includes(lot)}
                  onChange={(ev) => setDraft({ ...draft, lots: ev.target.checked ? [...draft.lots, lot] : draft.lots.filter((l) => l !== lot) })}
                />
                {LOT_LABELS[lot]}
              </label>
            ))}
          </div>
          <button className="btn btn--primary" type="submit" disabled={!draft.name.trim() || !draft.lots.length}>
            Ajouter l'artisan
          </button>
        </form>
        <ul className="artisan-list">
          {project.artisans.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.name}</strong> {a.city && <span className="muted">· {a.city}</span>}
                <div className="muted small">{a.lots.map((l) => LOT_LABELS[l]).join(', ')}</div>
                <div className="small">{[a.phone, a.email].filter(Boolean).join(' · ')}</div>
              </div>
              <button
                className="btn btn--ghost"
                onClick={() =>
                  updateProject((p) => {
                    p.artisans = p.artisans.filter((x) => x.id !== a.id);
                    for (const k of Object.keys(p.assignments) as Lot[]) if (p.assignments[k] === a.id) delete p.assignments[k];
                  })
                }
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
