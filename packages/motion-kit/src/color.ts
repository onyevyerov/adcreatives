/**
 * Робота з кольорами: розбір, змішування, відносна яскравість і контраст за WCAG 2.x.
 * Чисті функції — працюють і в браузері, і в Node (тести, QA).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** Розбирає `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(…)`, `rgba(…)`. Невідомий формат → null. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn?.[1]) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    const nums = parts.map((p) => (p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number(p)));
    const [r, g, b] = nums;
    if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) return null;
    const rawAlpha = parts[3];
    const alpha =
      rawAlpha === undefined
        ? 1
        : rawAlpha.endsWith("%")
          ? Number.parseFloat(rawAlpha) / 100
          : Number(rawAlpha);
    return { r, g, b, a: Number.isNaN(alpha) ? 1 : alpha };
  }
  return null;
}

export function toHex({ r, g, b }: Pick<Rgb, "r" | "g" | "b">): string {
  return `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Колір із прозорістю у форматі `rgba(…)`. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Лінійне змішування: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const k = Math.max(0, Math.min(1, t));
  return toHex({ r: ca.r + (cb.r - ca.r) * k, g: ca.g + (cb.g - ca.g) * k, b: ca.b + (cb.b - ca.b) * k });
}

/** Середній колір списку (для градієнтів — оцінка фону під текстом). */
export function averageColor(colors: readonly string[]): string {
  const parsed = colors.map(parseColor).filter((c): c is Rgb => c !== null);
  if (parsed.length === 0) return "#808080";
  const sum = parsed.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), {
    r: 0,
    g: 0,
    b: 0,
  });
  return toHex({ r: sum.r / parsed.length, g: sum.g / parsed.length, b: sum.b / parsed.length });
}

/** Відносна яскравість WCAG (0 — чорний, 1 — білий). */
export function relativeLuminance(color: string): number {
  const c = parseColor(color);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Контраст WCAG між двома кольорами: 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isDark(color: string): boolean {
  return relativeLuminance(color) < 0.4;
}

/** Мінімальний контраст тексту: великий текст (≥ 36 px у кадрі 1080) — 3:1, інший — 4.5:1. */
export function minContrastFor(fontSizePx: number): number {
  return fontSizePx >= 36 ? 3 : 4.5;
}

const DEFAULT_ON_DARK = "#FFFFFF";
const DEFAULT_ON_LIGHT = "#111111";

/**
 * Колір тексту з достатнім контрастом для фону: обирає контрастніший з
 * `palette.textOnDark` / `palette.textOnLight` (без палітри — білий / майже чорний).
 */
export function readableOn(
  background: string,
  palette?: { textOnDark: string; textOnLight: string },
): string {
  const onDark = palette?.textOnDark ?? DEFAULT_ON_DARK;
  const onLight = palette?.textOnLight ?? DEFAULT_ON_LIGHT;
  const cd = contrastRatio(background, onDark);
  const cl = contrastRatio(background, onLight);
  if (Math.max(cd, cl) < 3) {
    // Палітра не дає контрасту — повертаємося до чистих білого/чорного.
    return contrastRatio(background, DEFAULT_ON_DARK) >= contrastRatio(background, DEFAULT_ON_LIGHT)
      ? DEFAULT_ON_DARK
      : DEFAULT_ON_LIGHT;
  }
  return cd >= cl ? onDark : onLight;
}
