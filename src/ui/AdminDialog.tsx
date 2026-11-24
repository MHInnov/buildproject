import { useState } from 'react';
import { aiCheck } from '../ai';
import { AI_MODELS, useSettings } from '../settings';

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
        <div className="actions">
          <button className="btn btn--primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
