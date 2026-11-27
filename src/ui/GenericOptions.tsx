import type { Product } from '../model/catalog';
import { euro } from '../model/estimate';
import { itemPrice, leavesOf, PALETTE, styleOf } from '../model/generic';
import type { ItemOptions } from '../model/types';
import { NumberInput } from './NumberInput';

const LEAF_LABELS: Record<number, string> = { 1: 'Simple', 2: 'Double', 3: 'Triple' };

/**
 * Réglages d'un objet générique : variante, vantaux, couleur (palette ou libre) et, pour un meuble, dimensions.
 * Le prix affiché suit les réglages.
 */
export function GenericOptions({ product, options, onChange, dims, readOnly }: { product: Product; options?: ItemOptions; onChange: (o: ItemOptions | undefined) => void; dims?: { w: number; h: number }; readOnly?: boolean }) {
  const g = product.generic;
  if (!g) return null;
  const o = options ?? {};
  const set = (patch: Partial<ItemOptions>) => {
    const next: ItemOptions = { ...o, ...patch };
    for (const k of Object.keys(next) as (keyof ItemOptions)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const style = styleOf(product, o);
  const leaves = leavesOf(product, o);
  const color = o.color ?? product.color;
  const size = o.size ?? product.size ?? { w: 1, d: 0.6, h: 0.8 };
  const clamp = (k: 'w' | 'd' | 'h', v: number) => Math.min(g.max?.[k] ?? 10, Math.max(g.min?.[k] ?? 0.05, v));
  return (
    <div className="generic" aria-disabled={readOnly}>
      {g.styles && g.styles.length > 1 && (
        <div className="condition">
          <span>Modèle</span>
          <div className="segmented segmented--small">
            {g.styles.map((st) => (
              <button key={st.id} type="button" disabled={readOnly} className={style?.id === st.id ? 'is-active' : ''} onClick={() => set({ style: st.id === g.styles![0].id ? undefined : st.id })}>
                {st.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {g.leaves && g.leaves.length > 1 && (
        <div className="condition">
          <span>{product.category === 'porte' ? 'Vantaux' : 'Ouvrants'}</span>
          <div className="segmented segmented--small">
            {[...g.leaves].sort((a, b) => a - b).map((n) => (
              <button key={n} type="button" disabled={readOnly} className={leaves === n ? 'is-active' : ''} onClick={() => set({ leaves: n === g.leaves![0] ? undefined : n })}>
                {LEAF_LABELS[n] ?? n}
              </button>
            ))}
          </div>
        </div>
      )}
      {g.color && (
        <div className="condition">
          <span>Couleur</span>
          <div className="palette">
            {PALETTE.map((c) => (
              <button
                key={c.color}
                type="button"
                disabled={readOnly}
                title={c.label}
                aria-label={c.label}
                className={`palette__chip${color.toLowerCase() === c.color ? ' is-active' : ''}`}
                style={{ background: c.color }}
                onClick={() => set({ color: c.color === product.color ? undefined : c.color })}
              />
            ))}
            <label className="palette__custom" title="Autre couleur">
              <input type="color" disabled={readOnly} value={color} onChange={(e) => set({ color: e.target.value })} />
              Autre
            </label>
          </div>
        </div>
      )}
      {g.sized && (
        <div className="fields">
          {(['w', 'd', 'h'] as const).map((k) => (
            <label key={k} className="field">
              <span>{k === 'w' ? 'Largeur (m)' : k === 'd' ? 'Profondeur (m)' : 'Hauteur (m)'}</span>
              <NumberInput value={size[k]} min={g.min?.[k]} max={g.max?.[k]} disabled={readOnly} onChange={(v) => set({ size: { ...size, [k]: clamp(k, v) } })} />
            </label>
          ))}
        </div>
      )}
      {!product.existingOnly && <p className="muted small">Prix avec ces réglages : {euro(itemPrice(product, o, dims))}</p>}
    </div>
  );
}
