import { useMemo, useState } from 'react';
import type { Category, Product } from '../model/catalog';
import { euro } from '../model/estimate';
import { searchCatalog } from '../model/search';
import { useStore } from '../store';
import { patternUrl } from '../textures/patterns';

interface Props {
  categories: Category[];
  subcategory?: string;
  currentId?: string | null;
  onPick: (p: Product) => void;
  placeholder?: string;
  compact?: boolean;
  /** Ne propose que les produits qui passent ce filtre. */
  only?: (p: Product) => boolean;
}

const unitLabel = (p: Product) =>
  p.saleUnit === 'paquet' ? `/ paquet ${p.packSize?.toLocaleString('fr-BE')} m²` : p.saleUnit === 'pot' ? `/ pot ${p.packSize?.toLocaleString('fr-BE')} L` : '';

/** Liste de produits filtrable en langage naturel (« grand, pas trop foncé, moins de 500 € »). */
export function ProductPicker({ categories, subcategory, currentId, onPick, placeholder, compact, only }: Props) {
  const fullCatalog = useStore((s) => s.catalog);
  const step = useStore((s) => s.step);
  // Les matériaux « existants » (papier peint ancien, simple vitrage…) ne servent qu'au relevé.
  const catalog = useMemo(
    () => ({ ...fullCatalog, products: fullCatalog.products.filter((p) => (step === 'existant' || !p.existingOnly) && (!only || only(p))) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullCatalog, step],
  );
  const [query, setQuery] = useState('');

  const { results, filters } = useMemo(() => {
    const r = searchCatalog(catalog, query, categories);
    if (subcategory && !r.filters.subcategories.length) {
      r.results = [...r.results].sort(
        (a, b) => Number(b.product.subcategory === subcategory) - Number(a.product.subcategory === subcategory),
      );
    }
    return r;
  }, [catalog, query, categories, subcategory]);

  const chips: string[] = [];
  if (filters.tones.length && filters.tones.length < 3) chips.push(`teinte : ${filters.tones.join(' ou ')}`);
  if (filters.excludeTones.length) chips.push(`sans ${filters.excludeTones.join(', ')}`);
  if (filters.size) chips.push(filters.size);
  if (filters.maxPrice != null) chips.push(`≤ ${filters.maxPrice} €`);
  for (const w of filters.words) chips.push(w);

  return (
    <div className={`picker ${compact ? 'picker--compact' : ''}`}>
      <input
        className="picker__search"
        type="search"
        value={query}
        placeholder={placeholder ?? 'Décrivez ce que vous voulez : « clair, bois, moins de 40 € »'}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      {chips.length > 0 && (
        <div className="picker__chips">
          {chips.map((c) => (
            <span key={c} className="chip">{c}</span>
          ))}
        </div>
      )}
      <ul className="picker__list">
        {results.length === 0 && <li className="muted">Aucun produit ne correspond.</li>}
        {results.map(({ product: p }) => (
          <li key={p.id}>
            <button
              type="button"
              className={`picker__item ${p.id === currentId ? 'is-current' : ''}`}
              onClick={() => onPick(p)}
              title={p.tags.join(', ')}
            >
              <span className="swatch" style={{ backgroundColor: p.color, backgroundImage: p.pattern ? `url(${patternUrl(p.pattern, p.color, 48)})` : undefined }} />
              <span className="picker__name">
                {p.name}
                <small>{p.brand}</small>
              </span>
              <span className="picker__price">
                {p.existingOnly ? <small>existant</small> : euro(p.price)}
                {!p.existingOnly && <small>{unitLabel(p)}</small>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
