import { useState } from 'react';
import { useImported } from '../catalogImport';
import { CONNECTORS, connectorReady, foundToProducts, searchConnector, useConnectors, type ConnectorId, type FoundProduct } from '../connectors';
import type { Category } from '../model/catalog';
import { newId } from '../model/geometry';
import { commitImported } from './catalogs';

const CATEGORY_CHOICES: { id: Category; label: string }[] = [
  { id: 'meuble', label: 'Meubles' },
  { id: 'sol', label: 'Sols' },
  { id: 'peinture', label: 'Peintures' },
  { id: 'mur', label: 'Revêtements muraux' },
  { id: 'faience', label: 'Faïence' },
  { id: 'porte', label: 'Portes' },
  { id: 'fenetre', label: 'Fenêtres' },
];

function SecretField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="inline-form">
        <input type={show ? 'text' : 'password'} value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn" type="button" onClick={() => setShow(!show)}>
          {show ? 'Masquer' : 'Afficher'}
        </button>
      </div>
    </label>
  );
}

/** Connecteurs vers des catalogues en ligne : chaque service utilise la clé de l'utilisateur. */
export function ConnectorsPanel() {
  const c = useConnectors();
  const list = useImported((s) => s.list);
  const ready = CONNECTORS.filter((x) => connectorReady(x.id, c));
  const [source, setSource] = useState<ConnectorId>('ikea');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('meuble');
  const [max, setMax] = useState(20);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundProduct[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  // Sections ouvertes au départ si le connecteur n'est pas configuré (et qui ne se referment pas pendant la saisie)
  const [openAtStart] = useState(() => ({ ikea: !connectorReady('ikea', c), brico: !connectorReady('brico', c) }));
  const active = ready.some((x) => x.id === source) ? source : (ready[0]?.id ?? source);

  const search = async () => {
    setBusy(true);
    setStatus(null);
    setFound(null);
    try {
      const r = await searchConnector(active, query.trim(), max, category);
      setFound(r);
      setPicked(new Set(r.filter((f) => f.price !== null).map((f) => f.key)));
      if (!r.length) setStatus('Aucun produit reconnu dans la réponse du service.');
    } catch (e) {
      setStatus(`⚠ ${(e as Error).message}`);
    }
    setBusy(false);
  };

  const add = () => {
    if (!found) return;
    const chosen = found.filter((f) => picked.has(f.key));
    const { products, errors } = foundToProducts(chosen);
    const label = CONNECTORS.find((x) => x.id === active)!.source;
    if (products.length) {
      const warn = commitImported([...list, { id: newId('cat'), name: `${label} · ${query.trim()}`, importedAt: new Date().toISOString().slice(0, 10), products }]);
      setStatus([`✓ ${products.length} produit(s) ajouté(s) au catalogue.`, ...errors.slice(0, 3), warn].filter(Boolean).join(' '));
      setFound(null);
    } else setStatus(`⚠ Rien à ajouter. ${errors.slice(0, 3).join(' ')}`);
  };

  return (
    <section>
      <h3>Connecteurs de catalogues</h3>
      <p className="muted small">
        Recherchez des produits directement chez un fournisseur et ajoutez-les au catalogue. Chaque connecteur utilise votre propre compte : rien n'est appelé tant que sa clé n'est pas
        renseignée, et les recherches sont facturées par le service sur votre compte. Les clés restent dans ce navigateur.
      </p>

      <details open={openAtStart.ikea || undefined}>
        <summary>
          <strong>IKEA</strong> via Apify {connectorReady('ikea', c) ? '✓' : '(non configuré)'}
        </summary>
        <p className="muted small">
          Compte sur apify.com, puis Settings › API &amp; Integrations › jeton personnel. Acteur communautaire « mynewhome/ikea » (environ 0,01 $ pour 1 000 produits, hors abonnement Apify).
          Ce n'est pas un service officiel d'IKEA : les données sont relevées sur le site d'IKEA, à vous de vérifier que cet usage vous convient.
        </p>
        <SecretField label="Jeton API Apify" value={c.apifyToken} placeholder="apify_api_…" onChange={(v) => c.update({ apifyToken: v })} />
        <label className="field">
          <span>Acteur</span>
          <input value={c.apifyActor} onChange={(e) => c.update({ apifyActor: e.target.value.replace('/', '~') })} onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </details>

      <details open={openAtStart.brico || undefined}>
        <summary>
          <strong>Brico.be</strong> via Writ {connectorReady('brico', c) ? '✓' : '(non configuré)'}
        </summary>
        <p className="muted small">
          Compte sur usewrit.app (offre Pro requise pour cette recherche), puis une clé API « wt_ ». 2 crédits par recherche réussie. Service tiers, non affilié à Brico.
        </p>
        <SecretField label="Clé API Writ" value={c.writKey} placeholder="wt_…" onChange={(v) => c.update({ writKey: v })} />
      </details>

      <details>
        <summary>
          <strong>Diffusion Menuiserie</strong> (Quick-Step) : pas de connecteur possible
        </summary>
        <p className="muted small">
          Ce revendeur ne propose ni API ni export de son catalogue : seules des pages web, dont la reprise automatique n'est pas autorisée. Demandez-leur (ou à Quick-Step) le fichier produits
          en CSV ou Excel et importez-le ci-dessus.
        </p>
      </details>

      {ready.length > 0 && (
        <div className="connector-search">
          <div className="inline-form">
            <select value={active} onChange={(e) => setSource(e.target.value as ConnectorId)} aria-label="Fournisseur">
              {ready.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)} aria-label="Ranger dans">
              {CATEGORY_CHOICES.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
            <select value={max} onChange={(e) => setMax(Number(e.target.value))} aria-label="Nombre de résultats">
              {[10, 20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} résultats
                </option>
              ))}
            </select>
          </div>
          <div className="inline-form">
            <input
              placeholder="Rechercher (ex. « bibliothèque blanche », « stratifié chêne »)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && query.trim() && !busy) void search();
              }}
            />
            <button className="btn btn--primary" disabled={!query.trim() || busy} onClick={() => void search()}>
              {busy ? 'Recherche…' : 'Rechercher'}
            </button>
          </div>
        </div>
      )}
      {status && <p className="small">{status}</p>}
      {found && found.length > 0 && (
        <>
          <ul className="found-list">
            {found.map((f) => (
              <li key={f.key}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(f.key)}
                    disabled={f.price === null}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(f.key);
                      else n.delete(f.key);
                      setPicked(n);
                    }}
                  />
                  {f.image ? <img src={f.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="found-list__noimg" />}
                  <span className="found-list__name">
                    {f.name}
                    <small>{f.brand}</small>
                  </span>
                  <strong>{f.price === null ? 'prix ?' : `${f.price.toLocaleString('fr-BE')} €`}</strong>
                </label>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button className="btn btn--primary" disabled={!picked.size} onClick={add}>
              Ajouter au catalogue ({picked.size})
            </button>
          </div>
        </>
      )}
    </section>
  );
}
