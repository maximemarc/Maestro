/**
 * Lecture des jetons de couleur du design system depuis un canvas.
 *
 * Un canvas ne connaît pas les variables CSS : `AgentGraph` et `RadarScope`
 * recopiaient donc une vingtaine de littéraux hexadécimaux. À la première
 * recalibration de la palette, trois d'entre eux se sont retrouvés désynchronisés
 * du reste de l'interface, sans que rien ne le signale. Ici, la feuille de style
 * reste la source unique.
 *
 * La lecture est faite une fois et mémorisée : `getComputedStyle` force un
 * recalcul de style, on ne l'appelle pas à chaque image.
 */

export interface CanvasTokens {
  border: string;
  borderStrong: string;
  bgElevated: string;
  bgHover: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  ok: string;
  /** Composantes rgb de l'accent, pour décliner plusieurs alphas. */
  accentRgb: string;
}

let cache: CanvasTokens | null = null;

function hexToRgb(hex: string): string {
  const clean = hex.trim().replace('#', '');
  if (clean.length !== 6) return '34, 211, 238';
  const n = Number.parseInt(clean, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function canvasTokens(): CanvasTokens {
  if (cache) return cache;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };

  const accent = read('--accent', '#22d3ee');
  cache = {
    border: read('--border', '#1f2937'),
    borderStrong: read('--border-strong', '#2b3648'),
    bgElevated: read('--bg-elevated', '#161d2b'),
    bgHover: read('--bg-hover', '#1b2434'),
    text: read('--text', '#e2e8f0'),
    textMuted: read('--text-muted', '#9aa7bd'),
    textFaint: read('--text-faint', '#7e8ca5'),
    accent,
    ok: read('--ok', '#34d399'),
    accentRgb: hexToRgb(accent),
  };
  return cache;
}

/**
 * Pile de polices du design system, sous la forme attendue par
 * `CanvasRenderingContext2D.font`.
 */
export function canvasFont(sizePx: number, emoji = false): string {
  const style = getComputedStyle(document.documentElement);
  const family = style.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
  const emojiStack = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
  return emoji ? `${sizePx}px ${emojiStack}, ${family}` : `${sizePx}px ${family}`;
}
