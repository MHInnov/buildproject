import { useEffect, useState } from 'react';

/**
 * Champ numérique qui laisse taper librement (virgule ou point, « 2, » en cours de saisie)
 * et n'enregistre la valeur qu'à la validation (Entrée ou sortie du champ) :
 * une seule étape d'annulation par modification.
 */
export function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  digits = 2,
  disabled,
  autoFocus,
  ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  digits?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
  title?: string;
}) {
  const show = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits).replace('.', ',') : '');
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.trim().replace(/\s/g, '').replace(',', '.'));
    setDraft(null);
    if (draft.trim() === '' || !Number.isFinite(v)) return;
    const c = Math.min(max, Math.max(min, v));
    if (Math.abs(c - value) > 1e-9) onChange(c);
  };
  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoFocus={autoFocus}
      disabled={disabled}
      value={draft ?? show(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') setDraft(null);
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = e.shiftKey ? 0.1 : 0.01;
          onChange(Math.min(max, Math.max(min, Math.round((value + (e.key === 'ArrowUp' ? step : -step)) * 1000) / 1000)));
        }
      }}
    />
  );
}
