import type { Pattern } from '../model/catalog';

/**
 * Textures dessinées à la volée dans un canvas : aucune image à télécharger,
 * l'application reste légère. Chaque texture représente un « module » qui se répète
 * (ex. 2 × 2 carreaux, 4 lames de parquet) ; sa taille réelle en mètres est renvoyée.
 */
export interface PatternTile {
  canvas: HTMLCanvasElement;
  /** Taille réelle du module, en mètres. */
  w: number;
  h: number;
}

const cache = new Map<string, PatternTile>();

/** Générateur pseudo-aléatoire déterministe : la même texture à chaque chargement. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

/** Variante d'une couleur : k > 1 éclaircit, k < 1 assombrit. */
export function tint(hex: string, k: number): string {
  const [r, g, b] = parse(hex);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k >= 1 ? c + (255 - c) * (k - 1) : c * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function noise(ctx: CanvasRenderingContext2D, W: number, H: number, amount: number, rand: () => number, size = 1) {
  if (amount <= 0) return;
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let y = 0; y < H; y += size) {
    for (let x = 0; x < W; x += size) {
      const n = (rand() - 0.5) * amount;
      for (let yy = y; yy < Math.min(H, y + size); yy++) {
        for (let xx = x; xx < Math.min(W, x + size); xx++) {
          const i = (yy * W + xx) * 4;
          d[i] += n;
          d[i + 1] += n;
          d[i + 2] += n;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Veinage du bois dans un rectangle. */
function woodGrain(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, base: string, rand: () => number, vertical: boolean) {
  ctx.fillStyle = tint(base, 0.9 + rand() * 0.2);
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const lines = 6 + Math.floor(rand() * 6);
  for (let i = 0; i < lines; i++) {
    ctx.strokeStyle = tint(base, 0.78 + rand() * 0.12);
    ctx.globalAlpha = 0.25 + rand() * 0.3;
    ctx.lineWidth = 0.6 + rand() * 1.4;
    ctx.beginPath();
    const off = rand();
    const amp = 1 + rand() * 3;
    if (vertical) {
      const cx = x + off * w;
      ctx.moveTo(cx, y);
      for (let t = 0; t <= 1; t += 0.1) ctx.lineTo(cx + Math.sin(t * 6 + off * 10) * amp, y + t * h);
    } else {
      const cy = y + off * h;
      ctx.moveTo(x, cy);
      for (let t = 0; t <= 1; t += 0.1) ctx.lineTo(x + t * w, cy + Math.sin(t * 6 + off * 10) * amp);
    }
    ctx.stroke();
  }
  // Quelques nœuds
  if (rand() < 0.35) {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = tint(base, 0.65);
    ctx.beginPath();
    ctx.ellipse(x + rand() * w, y + rand() * h, vertical ? 2 : 5, vertical ? 5 : 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/**
 * Dessine le module d'une texture.
 * @param px résolution en pixels par mètre (le module fait au plus 512 px de côté).
 */
export function patternTile(pattern: Pattern | undefined, color: string, px = 256): PatternTile {
  const kind = pattern?.kind ?? 'smooth';
  const key = `${kind}|${pattern?.w}|${pattern?.h}|${pattern?.joint}|${pattern?.accent}|${color}|${px}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rand = rng(hashStr(key));
  const canvas = document.createElement('canvas');
  let w = 1;
  let h = 1;
  const pw = pattern?.w ?? 0.2;
  const ph = pattern?.h ?? 0.2;
  switch (kind) {
    case 'planks':
      w = pw * 4;
      h = ph;
      break;
    case 'parquet':
      w = ph * 2;
      h = ph * 2;
      break;
    case 'tiles':
      w = pw * 2;
      h = ph * 2;
      break;
    case 'bricks':
      w = pw * 2;
      h = ph * 4;
      break;
    case 'paneling':
      w = pw * 4;
      h = 1;
      break;
    case 'rooftiles':
    case 'slate':
      w = pw * 4;
      h = ph * 4;
      break;
    case 'zinc':
      w = pw * 2;
      h = 1;
      break;
    case 'concrete':
      w = pw;
      h = ph;
      break;
    case 'wallpaper':
      w = 0.53;
      h = 0.53;
      break;
    default:
      w = 1;
      h = 1;
  }
  const scale = Math.min(px, 512 / Math.max(w, h));
  const W = Math.max(16, Math.round(w * scale));
  const H = Math.max(16, Math.round(h * scale));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  const joint = pattern?.joint ?? tint(color, 0.7);
  const accent = pattern?.accent;

  switch (kind) {
    case 'planks': {
      // 4 lames décalées, joints de bout en quinconce
      const lw = W / 4;
      for (let i = 0; i < 4; i++) {
        const cut = ((i * 0.37 + 0.2) % 1) * H;
        woodGrain(ctx, i * lw, 0, lw, cut, color, rand, true);
        woodGrain(ctx, i * lw, cut, lw, H - cut, color, rand, true);
        ctx.fillStyle = tint(color, 0.6);
        ctx.fillRect(i * lw, cut - 0.5, lw, 1);
        ctx.fillRect(i * lw, 0, 1, H);
      }
      noise(ctx, W, H, 10, rand);
      break;
    }
    case 'parquet': {
      // Bâtons rompus : 2 × 2 carrés de lames alternées
      const c = W / 2;
      const n = Math.max(2, Math.round(ph / (pattern?.w ?? 0.09)));
      for (let gx = 0; gx < 2; gx++) {
        for (let gy = 0; gy < 2; gy++) {
          const vertical = (gx + gy) % 2 === 0;
          for (let k = 0; k < n; k++) {
            const s = c / n;
            if (vertical) woodGrain(ctx, gx * c + k * s, gy * c, s, c, color, rand, true);
            else woodGrain(ctx, gx * c, gy * c + k * s, c, s, color, rand, false);
            ctx.fillStyle = tint(color, 0.62);
            if (vertical) ctx.fillRect(gx * c + k * s, gy * c, 1, c);
            else ctx.fillRect(gx * c, gy * c + k * s, c, 1);
          }
        }
      }
      noise(ctx, W, H, 8, rand);
      break;
    }
    case 'tiles': {
      const jw = Math.max(1, Math.round(scale * 0.004));
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const x = (i * W) / 2;
          const y = (j * H) / 2;
          ctx.fillStyle = tint(color, 0.94 + rand() * 0.1);
          ctx.fillRect(x, y, W / 2, H / 2);
          if (accent) {
            // Motif de carreau de ciment ou veine de marbre
            ctx.strokeStyle = accent;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = Math.max(1, W / 60);
            if ((pattern?.w ?? 0.2) <= 0.25) {
              ctx.beginPath();
              ctx.arc(x + W / 4, y + H / 4, W / 9, 0, Math.PI * 2);
              ctx.moveTo(x, y + H / 4);
              ctx.lineTo(x + W / 4, y);
              ctx.lineTo(x + W / 2, y + H / 4);
              ctx.lineTo(x + W / 4, y + H / 2);
              ctx.closePath();
              ctx.stroke();
            } else {
              ctx.beginPath();
              ctx.moveTo(x + rand() * W * 0.5, y);
              for (let t = 0; t < 6; t++) ctx.lineTo(x + rand() * W * 0.5, y + ((t + 1) * H) / 12);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }
        }
      }
      noise(ctx, W, H, 6, rand);
      ctx.fillStyle = joint;
      for (let i = 0; i < 2; i++) {
        ctx.fillRect((i * W) / 2, 0, jw, H);
        ctx.fillRect(0, (i * H) / 2, W, jw);
      }
      break;
    }
    case 'bricks': {
      const rows = 4;
      const rh = H / rows;
      const bw = W / 2;
      const jw = Math.max(1, Math.round(scale * 0.008));
      ctx.fillStyle = joint;
      ctx.fillRect(0, 0, W, H);
      for (let r = 0; r < rows; r++) {
        const off = r % 2 ? bw / 2 : 0;
        for (let c = -1; c < 3; c++) {
          ctx.fillStyle = tint(color, 0.85 + rand() * 0.3);
          ctx.fillRect(c * bw + off + jw / 2, r * rh + jw / 2, bw - jw, rh - jw);
        }
      }
      noise(ctx, W, H, 16, rand);
      break;
    }
    case 'stone': {
      ctx.fillStyle = joint;
      ctx.fillRect(0, 0, W, H);
      const n = 9;
      for (let i = 0; i < n * 2; i++) {
        const cx = rand() * W;
        const cy = rand() * H;
        const rx = W * (0.08 + rand() * 0.1);
        const ry = H * (0.06 + rand() * 0.07);
        ctx.fillStyle = tint(color, 0.8 + rand() * 0.4);
        for (const dx of [-W, 0, W]) {
          for (const dy of [-H, 0, H]) {
            ctx.beginPath();
            ctx.ellipse(cx + dx, cy + dy, rx, ry, rand(), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      noise(ctx, W, H, 22, rand);
      break;
    }
    case 'wallpaper': {
      const a = accent ?? tint(color, 0.8);
      ctx.fillStyle = a;
      ctx.strokeStyle = a;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(1, W / 120);
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const x = (i + (j % 2) * 0.5) * (W / 2) + W / 4;
          const y = j * (H / 2) + H / 4;
          for (let k = 0; k < 5; k++) {
            const ang = (k / 5) * Math.PI * 2;
            ctx.beginPath();
            ctx.ellipse(x + Math.cos(ang) * W * 0.05, y + Math.sin(ang) * W * 0.05, W * 0.05, W * 0.02, ang, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.moveTo(x, y + W * 0.06);
          ctx.quadraticCurveTo(x + W * 0.05, y + H * 0.15, x - W * 0.02, y + H * 0.22);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      noise(ctx, W, H, 6, rand);
      break;
    }
    case 'paneling': {
      const lw = W / 4;
      for (let i = 0; i < 4; i++) {
        woodGrain(ctx, i * lw, 0, lw, H, color, rand, true);
        ctx.fillStyle = tint(color, 0.6);
        ctx.fillRect(i * lw, 0, Math.max(1, lw * 0.04), H);
      }
      noise(ctx, W, H, 6, rand);
      break;
    }
    case 'rooftiles': {
      const cols = 4;
      const rows = 4;
      const cw = W / cols;
      const rh = H / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const g = ctx.createLinearGradient(c * cw, 0, (c + 1) * cw, 0);
          const base = tint(color, 0.85 + rand() * 0.25);
          g.addColorStop(0, tint(color, 0.7));
          g.addColorStop(0.5, base);
          g.addColorStop(1, tint(color, 0.75));
          ctx.fillStyle = g;
          ctx.fillRect(c * cw, r * rh, cw, rh);
        }
        ctx.fillStyle = tint(color, 0.5);
        ctx.fillRect(0, (r + 1) * rh - Math.max(1, rh * 0.08), W, Math.max(1, rh * 0.08));
      }
      noise(ctx, W, H, 14, rand);
      break;
    }
    case 'slate': {
      const cols = 4;
      const rows = 4;
      const cw = W / cols;
      const rh = H / rows;
      for (let r = 0; r < rows; r++) {
        const off = r % 2 ? cw / 2 : 0;
        for (let c = -1; c < cols + 1; c++) {
          ctx.fillStyle = tint(color, 0.85 + rand() * 0.3);
          ctx.fillRect(c * cw + off + 1, r * rh, cw - 2, rh);
        }
        ctx.fillStyle = tint(color, 0.55);
        ctx.fillRect(0, (r + 1) * rh - 1.5, W, 1.5);
      }
      noise(ctx, W, H, 12, rand);
      break;
    }
    case 'zinc': {
      noise(ctx, W, H, 6, rand);
      ctx.fillStyle = tint(color, 1.25);
      ctx.fillRect(0, 0, Math.max(2, W * 0.03), H);
      ctx.fillRect(W / 2, 0, Math.max(2, W * 0.03), H);
      ctx.fillStyle = tint(color, 0.7);
      ctx.fillRect(Math.max(2, W * 0.03), 0, 1, H);
      ctx.fillRect(W / 2 + Math.max(2, W * 0.03), 0, 1, H);
      break;
    }
    case 'concrete':
      noise(ctx, W, H, 18, rand, 2);
      noise(ctx, W, H, 8, rand);
      break;
    case 'carpet':
      noise(ctx, W, H, 26, rand);
      break;
    case 'plaster':
      noise(ctx, W, H, 7, rand, 2);
      break;
    default:
      noise(ctx, W, H, 3, rand);
  }
  const tile = { canvas, w, h };
  cache.set(key, tile);
  return tile;
}

const urlCache = new Map<string, string>();
/** Image de la texture en data URL (pour le plan SVG et les pastilles du catalogue). */
export function patternUrl(pattern: Pattern | undefined, color: string, px = 96): string {
  const key = `${JSON.stringify(pattern ?? {})}|${color}|${px}`;
  let u = urlCache.get(key);
  if (!u) {
    u = patternTile(pattern, color, px).canvas.toDataURL('image/png');
    urlCache.set(key, u);
  }
  return u;
}
