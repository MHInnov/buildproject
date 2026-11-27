import { useRef, useState } from 'react';
import { aiCheck, localPull } from '../ai';
import { CSV_TEMPLATE, parseCatalogFile, useImported } from '../catalogImport';
import { commitImported } from './catalogs';
import { ConnectorsPanel } from './ConnectorsPanel';
import { newId } from '../model/geometry';
import { AI_MODELS, DEFAULT_LOCAL_URL, LOCAL_MODELS, useBundledAi, useSettings, validApiUrl, validLocalUrl } from '../settings';

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
  const [pull, setPull] = useState<string | null>(null);
  const bundled = useBundledAi((x) => x.info);
  const local = s.aiProvider === 'locale';
  const localInfo = LOCAL_MODELS.find((m) => m.id === s.localModel.trim());
  const test = async () => {
    setStatus('Vérification…');
    try {
      setStatus(`✓ ${local ? 'IA locale prête' : 'Clé valide'}, modèle disponible : ${await aiCheck()}`);
    } catch (e) {
      setStatus(`⚠ ${(e as Error).message}`);
    }
  };
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
            <strong>Avec IA</strong> : une IA de vision relit en plus les plans vue par vue (fausses portes, porte ou fenêtre, sens d'ouverture, baies oubliées, noms des pièces),
            les cotes des coupes (hauteurs sous plafond, allèges, linteaux) et reconnaît sols, murs, menuiseries et meubles sur les photos. Le résultat reste à valider dans l'inspecteur.
          </p>
          {s.aiEnabled && (
            <>
              <div className="segmented segmented--small" role="radiogroup" aria-label="IA utilisée">
                <button type="button" role="radio" aria-checked={local} className={local ? 'is-active' : ''} onClick={() => (setStatus(null), s.update({ aiProvider: 'locale' }))}>
                  IA locale (open source)
                </button>
                <button type="button" role="radio" aria-checked={!local} className={!local ? 'is-active' : ''} onClick={() => (setStatus(null), s.update({ aiProvider: 'claude' }))}>
                  Claude (API Anthropic)
                </button>
              </div>
              {local ? (
                <>
                  <p className="muted small">
                    Un modèle de vision open source tourne sur votre machine (ou un serveur de votre réseau) avec Ollama : les plans ne quittent pas votre réseau et rien n'est facturé.
                    L'application reste une page web ; seule l'IA tourne à côté. Le plus simple : l'image Docker avec IA (étiquette « -ia », voir le README). Il faut de préférence une
                    carte graphique NVIDIA avec 8 Go de mémoire pour le modèle conseillé ; sans carte graphique, cela marche aussi mais de 5 à 20 fois plus lentement.
                  </p>
                  {bundled && (
                    <p className="small">
                      IA livrée avec l'application : {bundled.model || 'aucun modèle'}, {bundled.gpu ? 'avec carte graphique' : 'sans carte graphique (lent : relancez avec --gpus all)'}
                      {bundled.status === 'telechargement' ? ', modèle en cours de téléchargement' : bundled.status === 'pret' ? ', prête' : bundled.status === 'erreur' ? ', téléchargement du modèle impossible' : ''}.
                    </p>
                  )}
                  <label className="field">
                    <span>Adresse du serveur Ollama</span>
                    <input value={s.localUrl} placeholder={DEFAULT_LOCAL_URL} onChange={(e) => s.update({ localUrl: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                  </label>
                  <p className="muted small">
                    <code>{DEFAULT_LOCAL_URL}</code> (par défaut) : le relais de l'application vers le service Ollama de docker compose. Un autre serveur : son adresse, par exemple
                    http://192.168.1.20:11434 (il doit alors autoriser cette page avec OLLAMA_ORIGINS).
                  </p>
                  {s.localUrl.trim() !== '' && !validLocalUrl(s.localUrl) && <p className="warning small">Adresse invalide : /chemin, http:// ou https://.</p>}
                  <label className="field">
                    <span>Modèle de vision</span>
                    <select value={localInfo ? s.localModel.trim() : ''} onChange={(e) => e.target.value && s.update({ localModel: e.target.value })}>
                      {LOCAL_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                      <option value="">Autre (saisi ci-dessous)</option>
                    </select>
                  </label>
                  <input aria-label="Nom du modèle Ollama" value={s.localModel} onChange={(e) => s.update({ localModel: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                  <p className="muted small">{localInfo ? localInfo.vram : 'Tout modèle Ollama qui accepte des images (vision).'}</p>
                  <div className="actions">
                    <button className="btn" onClick={() => void test()}>
                      Tester
                    </button>
                    <button
                      className="btn"
                      disabled={!!pull}
                      onClick={async () => {
                        setStatus(null);
                        setPull('Téléchargement…');
                        try {
                          await localPull(s.localModel.trim(), (st, part) => setPull(`${st}${part != null ? ` ${Math.round(part * 100)} %` : ''}`));
                          setPull(null);
                          await test();
                        } catch (e) {
                          setPull(null);
                          setStatus(`⚠ ${(e as Error).message}`);
                        }
                      }}
                    >
                      Télécharger le modèle
                    </button>
                  </div>
                  {pull && <p className="small">{pull}</p>}
                  {status && <p className="small">{status}</p>}
                </>
              ) : (
                <>
                  <p className="muted small">Chaque analyse est facturée sur votre compte Anthropic (de l'ordre de quelques centimes par image) ; les images sont envoyées à l'API.</p>
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
                    <span>Adresse de l'API (facultatif)</span>
                    <input type="url" value={s.apiUrl} placeholder="https://api.anthropic.com" onChange={(e) => s.update({ apiUrl: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                  </label>
                  <p className="muted small">
                    Vide : l'API d'Anthropic, avec la clé ci-dessus. Pour passer par un serveur de l'entreprise (compatible avec l'API d'Anthropic) qui garde la clé, indiquez son adresse : la clé devient facultative.
                  </p>
                  {s.apiUrl.trim() !== '' && !validApiUrl(s.apiUrl) && <p className="warning small">Adresse invalide : elle doit commencer par http:// ou https://.</p>}
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
                    <button className="btn" onClick={() => void test()}>
                      Tester la clé
                    </button>
                  </div>
                  {status && <p className="small">{status}</p>}
                  <p className="warning small">
                    La clé est enregistrée dans ce navigateur uniquement et n'est envoyée qu'à l'API indiquée ci-dessus. Pour un usage partagé (plusieurs utilisateurs), indiquez plutôt l'adresse d'un serveur de l'entreprise qui garde la clé.
                  </p>
                </>
              )}
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
