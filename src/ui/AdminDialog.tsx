import { useRef, useState } from 'react';
import { aiCheck } from '../ai';
import { CSV_TEMPLATE, parseCatalogFile, useImported } from '../catalogImport';
import { commitImported } from './catalogs';
import { ConnectorsPanel } from './ConnectorsPanel';
import { newId } from '../model/geometry';
import { AI_MODELS, useSettings } from '../settings';

/** Catalogues fournisseurs : import d'un fichier CSV ou JSON. */
function CatalogImport() {
  const list = useImported((s) => s.list);
  const [report, setReport] = useState<string[]>([]);
  const [brand, setBrand] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const commit = commitImported;
  return (
    <section>
      <h3>Catalogues fournisseurs</h3>
      <p className="muted small">
        Importez le catalogue d'une marque (meubles, sols, peintures…) au format CSV (Excel) ou JSON : ses produits apparaissent ensuite dans les choix de l'application, avec leur prix,
        leur couleur et leurs dimensions. IKEA et Quick-Step ne publient pas de catalogue ouvert : il faut le fichier produits fourni par la marque ou par un distributeur partenaire.
      </p>
      <div className="inline-form">
        <input placeholder="Marque par défaut (ex. Quick-Step)" value={brand} onChange={(e) => setBrand(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn btn--primary" onClick={() => file.current?.click()}>
          Importer un fichier…
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".csv,.json,.txt,text/csv,application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const name = brand.trim() || f.name.replace(/\.[^.]+$/, '');
          const r = parseCatalogFile(await f.text(), f.name, name);
          const lines = [`${r.products.length} produit(s) importé(s) depuis « ${f.name} ».`, ...r.errors.slice(0, 8)];
          if (r.errors.length > 8) lines.push(`… et ${r.errors.length - 8} autre(s) ligne(s) ignorée(s).`);
          if (r.products.length) {
            const warn = commit([...list, { id: newId('cat'), name, importedAt: new Date().toISOString().slice(0, 10), products: r.products }]);
            if (warn) lines.push(warn);
          }
          setReport(lines);
        }}
      />
      <p className="small">
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + CSV_TEMPLATE)}`} download="modele-catalogue.csv">
          Télécharger le modèle CSV
        </a>{' '}
        <span className="muted">(colonnes : référence, nom, marque, catégorie, prix, unité, m² par paquet, couleur, dimensions en cm, aspect du sol…)</span>
      </p>
      {report.length > 0 && (
        <ul className="log">
          {report.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <ul className="vp-list">
          {list.map((c) => (
            <li key={c.id} className="inline-form">
              <span>
                <strong>{c.name}</strong> · {c.products.length} produits · importé le {new Date(c.importedAt).toLocaleDateString('fr-FR')}
              </span>
              <button className="btn btn--small btn--danger" onClick={() => commit(list.filter((x) => x.id !== c.id))}>
                Retirer
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Panneau d'administration : choix avec ou sans IA. */
export function AdminDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const [status, setStatus] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <h2 id="admin-title">Administration</h2>
        <section>
          <h3>Intelligence artificielle</h3>
          <div className="segmented">
            <button className={!s.aiEnabled ? 'is-active' : ''} onClick={() => s.update({ aiEnabled: false })}>
              Sans IA
            </button>
            <button className={s.aiEnabled ? 'is-active' : ''} onClick={() => s.update({ aiEnabled: true })}>
              Avec IA
            </button>
          </div>
          <p className="muted small">
            <strong>Sans IA</strong> : tout fonctionne dans le navigateur, gratuitement. Le retraçage des plans se fait par analyse d'image, les photos des points de vue se relèvent par clics.
            <br />
            <strong>Avec IA</strong> : Claude lit en plus les plans (noms des pièces, portes et fenêtres oubliées) et reconnaît sols, murs, menuiseries et meubles sur les photos. Chaque analyse est facturée sur votre compte Anthropic (de l'ordre de quelques centimes par image).
          </p>
          {s.aiEnabled && (
            <>
              <label className="field">
                <span>Clé API Anthropic</span>
                <div className="inline-form">
                  <input type={show ? 'text' : 'password'} value={s.apiKey} placeholder="sk-ant-…" autoComplete="off" onChange={(e) => s.update({ apiKey: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                  <button className="btn" type="button" onClick={() => setShow(!show)}>
                    {show ? 'Masquer' : 'Afficher'}
                  </button>
                </div>
              </label>
              <label className="field">
                <span>Modèle</span>
                <select value={s.model} onChange={(e) => s.update({ model: e.target.value })}>
                  {AI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button
                  className="btn"
                  onClick={async () => {
                    setStatus('Vérification…');
                    try {
                      setStatus(`✓ Clé valide, modèle disponible : ${await aiCheck()}`);
                    } catch (e) {
                      setStatus(`⚠ ${(e as Error).message}`);
                    }
                  }}
                >
                  Tester la clé
                </button>
              </div>
              {status && <p className="small">{status}</p>}
              <p className="warning small">
                La clé est enregistrée dans ce navigateur uniquement et n'est envoyée qu'à l'API d'Anthropic. Pour un usage partagé (plusieurs utilisateurs), il faudra passer par un petit serveur qui garde la clé.
              </p>
            </>
          )}
        </section>
        <CatalogImport />
        <ConnectorsPanel />
        <div className="actions">
          <button className="btn btn--primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
