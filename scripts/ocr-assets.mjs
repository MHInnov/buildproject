// Copie dans public/ocr/ ce qu'il faut à l'OCR local (Tesseract) : le worker, le moteur WebAssembly
// et le modèle français. Rien n'est téléchargé à l'usage : tout est servi par l'application.
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');
mkdirSync(out, { recursive: true });
const nm = join(root, 'node_modules');
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz', 'fra.traineddata.gz'],
];
for (const [from, to] of files) {
  const src = join(nm, from);
  if (!existsSync(src)) throw new Error(`OCR : fichier manquant ${src}`);
  copyFileSync(src, join(out, to));
}
