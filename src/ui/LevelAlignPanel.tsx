import { useState } from 'react';
import { autoAlignLevel, shiftLevel, turnLevel } from '../model/levelAlign';
import { levelBelow } from '../model/levels';
import { useStore } from '../store';
import { useUi } from '../uiState';

const STEPS = [0.01, 0.05, 0.1, 0.5];

/**
 * Calage de l'étage affiché sur le niveau du dessous (dessiné en couleur sous le plan) : flèches, quart de
 * tour, recalage automatique, puis validation par l'utilisateur. Après un import, chaque étage est « à vérifier ».
 */
export function LevelAlignPanel() {
  const b = useStore((s) => s.project.existing);
  const levelId = useStore((s) => s.levelId);
  const editExisting = useStore((s) => s.editExisting);
  const showRef = useUi((s) => s.alignLevel);
  const setUi = useUi((s) => s.set);
  const [step, setStep] = useState(0.05);
  const [note, setNote] = useState<string | null>(null);
  const level = b.levels.find((l) => l.id === levelId);
  const below = levelBelow(b, levelId);
  if (!level || !below || !b.walls.some((w) => w.levelId === levelId) || !b.walls.some((w) => w.levelId === below.id)) return null;
  const todo = level.alignment === 'a-verifier';
  const move = (dx: number, dy: number) => {
    setNote(null);
    editExisting((x) => shiftLevel(x, levelId, dx, dy));
  };
  const fmt = (v: number) => `${v < 0.1 ? Math.round(v * 100) : (v * 100).toFixed(0)} cm`;
  return (
    <div className={`align-panel ${todo ? 'is-todo' : ''}`}>
      <h4>Calage sur {below.name.toLowerCase()}</h4>
      <p className="muted small">
        {todo
          ? `Vérifiez que « ${level.name} » est bien posé sur « ${below.name} » : ses façades doivent tomber sur celles du dessous (en orange). Déplacez l'étage si besoin, puis validez.`
          : level.alignment === 'valide'
            ? 'Calage validé. Vous pouvez encore le retoucher.'
            : `Les murs du dessous apparaissent en orange : déplacez l'étage pour que ses façades tombent dessus.`}
      </p>
      <label className="check small">
        <input type="checkbox" checked={showRef} onChange={(e) => setUi({ alignLevel: e.target.checked })} /> Voir le niveau du dessous en couleur
      </label>
      <div className="align-pad" role="group" aria-label="Déplacer l'étage">
        <span />
        <button className="btn" onClick={() => move(0, -step)} aria-label="Vers le haut du plan" title="Vers le haut du plan">
          ↑
        </button>
        <span />
        <button className="btn" onClick={() => move(-step, 0)} aria-label="Vers la gauche" title="Vers la gauche">
          ←
        </button>
        <select value={step} onChange={(e) => setStep(Number(e.target.value))} aria-label="Pas du déplacement">
          {STEPS.map((s) => (
            <option key={s} value={s}>
              {fmt(s)}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => move(step, 0)} aria-label="Vers la droite" title="Vers la droite">
          →
        </button>
        <span />
        <button className="btn" onClick={() => move(0, step)} aria-label="Vers le bas du plan" title="Vers le bas du plan">
          ↓
        </button>
        <span />
      </div>
      <div className="actions">
        <button
          className="btn"
          onClick={() => {
            let r: ReturnType<typeof autoAlignLevel> = null;
            editExisting((x) => void (r = autoAlignLevel(x, levelId)));
            const res = r as ReturnType<typeof autoAlignLevel>;
            setNote(res ? `Recalé : ${Math.round(res.fit * 100)} % des murs tombent sur ceux du dessous.` : 'Pas de recalage possible : trop peu de murs en commun.');
          }}
        >
          Recaler automatiquement
        </button>
        <button className="btn" onClick={() => editExisting((x) => turnLevel(x, levelId))} title="Si le plan de l'étage était tourné">
          Quart de tour
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
      <div className="actions">
        <button
          className={`btn ${todo ? 'btn--primary' : ''}`}
          disabled={level.alignment === 'valide'}
          onClick={() =>
            editExisting((x) => {
              const l = x.levels.find((m) => m.id === levelId);
              if (l) l.alignment = 'valide';
            })
          }
        >
          {level.alignment === 'valide' ? 'Calage validé' : 'Valider le calage'}
        </button>
      </div>
    </div>
  );
}
