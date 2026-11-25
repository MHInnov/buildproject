import { mergeCatalogs, saveImported, useImported, type ImportedCatalog } from '../catalogImport';
import { DEMO_CATALOG } from '../data/catalog';
import { useStore } from '../store';

/** Enregistre la liste des catalogues importés et met à jour les choix de l'application. */
export function commitImported(next: ImportedCatalog[]): string | null {
  const warn = saveImported(next);
  useImported.setState({ list: next });
  useStore.setState({ catalog: mergeCatalogs(DEMO_CATALOG, next) });
  return warn;
}

