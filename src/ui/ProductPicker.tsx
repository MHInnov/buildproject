import { useMemo, useState } from 'react';
import type { Category, Product } from '../model/catalog';
import { euro } from '../model/estimate';
import { searchCatalog } from '../model/search';
import { useStore } from '../store';

interface Props {
  categories: Category[];
  subcategory?: string;
  currentId?: string | null;
  onPick: (p: Product) => void;
  placeholder?: string;
  compact?: boolean;
}

const unitLabel = (p: Product) =>
  p.saleUnit === 'paquet' ? `/ paquet ${p.packSize?.toLocaleString('fr-BE')} m²` : p.saleUnit === 'pot' ? `/ pot ${p.packSize?.toLocaleString('fr-BE')} L` : '';

/** Liste de produits filtrable en langage naturel (« grand, pas trop foncé, moins de 500 € »). */
export function ProductPicker({ categories, subcategory, currentId, onPick, placeholder, compact }: Props) {
  const catalog = useStore((s) => s.catalog);
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
              <span className="swatch" style={{ background: p.color }} />
              <span className="picker__name">
                {p.name}
                <small>{p.brand}</small>
              </span>
              <span className="picker__price">
                {euro(p.price)}
                <small>{unitLabel(p)}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
