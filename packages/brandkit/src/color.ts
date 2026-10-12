import type { BasePaletteRole, Palette } from "@adc/shared";

/**
 * Кольори і контраст за WCAG 2.x.
 * Перевірка й виправлення палітри бренд-кіта: модель пропонує кольори, код гарантує читабельність.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;
const RGB_FN = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i;

/** Розбирає #RRGGBB, #RGB або rgb()/rgba(); інакше null. */
export function parseColor(input: string): Rgb | null {
  const s = input.trim();
  const h6 = HEX6.exec(s);
  if (h6?.[1]) {
    const n = Number.parseInt(h6[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const h3 = HEX3.exec(s);
  if (h3?.[1]) {
    const [r, g, b] = [...h3[1]].map((c) => Number.parseInt(c + c, 16));
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
  }
  const fn = RGB_FN.exec(s);
  if (fn) {
    const clamp = (v: string | undefined) => Math.min(255, Number(v ?? 0));
    return { r: clamp(fn[1]), g: clamp(fn[2]), b: clamp(fn[3]) };
  }
  return null;
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Нормалізує колір до #RRGGBB (верхній регістр); нерозпізнаний — null. */
export function normalizeHex(input: string): string | null {
  const rgb = parseColor(input);
  return rgb ? toHex(rgb) : null;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Відносна яскравість WCAG (0 — чорний, 1 — білий). */
export function luminance(color: string | Rgb): number {
  const rgb = typeof color === "string" ? parseColor(color) : color;
  if (!rgb) throw new Error(`невідомий колір: ${String(color)}`);
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Контраст WCAG між двома кольорами: 1…21. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Зсуває колір до чорного або білого (зберігаючи відтінок), поки контраст з `against`
 * не досягне `min`. Повертає найменш змінений колір, що проходить поріг.
 */
export function pushToContrast(
  color: string,
  against: string,
  min: number,
  toward: "dark" | "light",
): string {
  const base = parseColor(color);
  const bg = parseColor(against);
  if (!base || !bg) throw new Error(`невідомий колір: ${color} / ${against}`);
  if (contrastRatio(base, bg) >= min) return toHex(base);
  const target = toward === "dark" ? BLACK : WHITE;
  for (let step = 1; step <= 40; step++) {
    const candidate = toHex(mix(base, target, step / 40));
    if (contrastRatio(candidate, bg) >= min) return candidate;
  }
  return toHex(target);
}

export const CONTRAST = {
  /** Звичайний текст (WCAG AA). */
  text: 4.5,
  /** Великий текст і елементи інтерфейсу (WCAG AA large / 1.4.11). */
  large: 3,
} as const;

/** Еталонне темне тло (затемнене фото), якщо в палітрі немає темного кольору. */
const DARK_REFERENCE = "#222222";
/** Еталонне світле тло, якщо в палітрі немає світлого кольору. */
const LIGHT_REFERENCE = "#F5F5F5";

export const PALETTE_ROLE_UK: Record<BasePaletteRole, string> = {
  primary: "основний",
  secondary: "додатковий",
  accent: "акцентний",
  background: "фон",
  surface: "підкладка",
  textOnDark: "текст на темному",
  textOnLight: "текст на світлому",
};

export interface PaletteFixResult {
  palette: Palette;
  /** Що змінено, людською мовою. */
  fixes: string[];
}

/**
 * Перевіряє і виправляє контраст палітри:
 * - кольори нормалізуються до #RRGGBB;
 * - textOnDark має бути світлішим за textOnLight (інакше міняємо місцями);
 * - textOnLight ≥ 4.5 до найсвітлішого кольору палітри (або еталонного світлого тла);
 * - textOnDark ≥ 4.5 до найтемнішого кольору палітри (або еталонного темного тла);
 * - фон і підкладка: кращий з текстових кольорів дає ≥ 4.5; primary і accent — ≥ 3 (великий текст);
 *   інакше підсилюємо відповідний текстовий колір;
 * - accent відрізняється від фону щонайменше на 3:1, інакше зсуваємо його світлоту.
 * Брендові primary/secondary/background/surface не змінюються — лише текстові кольори та accent.
 */
export function fixPalette(input: Palette): PaletteFixResult {
  const fixes: string[] = [];
  const p = { ...input } as Palette;

  for (const role of Object.keys(PALETTE_ROLE_UK) as BasePaletteRole[]) {
    const hex = normalizeHex(p[role]);
    if (!hex) {
      const fallback = role === "textOnLight" ? "#111111" : role === "textOnDark" ? "#FFFFFF" : "#808080";
      fixes.push(`Колір «${PALETTE_ROLE_UK[role]}» (${p[role]}) не розпізнано — замінено на ${fallback}.`);
      p[role] = fallback;
    } else {
      p[role] = hex;
    }
  }

  if (luminance(p.textOnDark) < luminance(p.textOnLight)) {
    fixes.push("Кольори тексту на темному і на світлому були переплутані — поміняв місцями.");
    [p.textOnDark, p.textOnLight] = [p.textOnLight, p.textOnDark];
  }

  const surfaces = [p.background, p.surface, p.primary, p.secondary, p.accent];
  const lights = surfaces.filter((c) => luminance(c) > 0.4);
  const darks = surfaces.filter((c) => luminance(c) < 0.2);
  const lightest = lights.length
    ? lights.reduce((a, b) => (luminance(a) >= luminance(b) ? a : b))
    : LIGHT_REFERENCE;
  const darkest = darks.length
    ? darks.reduce((a, b) => (luminance(a) <= luminance(b) ? a : b))
    : DARK_REFERENCE;

  const adjust = (role: "textOnLight" | "textOnDark", against: string, min: number, why: string) => {
    const before = p[role];
    const after = pushToContrast(before, against, min, role === "textOnLight" ? "dark" : "light");
    if (after !== before) {
      p[role] = after;
      fixes.push(
        `Колір «${PALETTE_ROLE_UK[role]}» ${before} → ${after}: ${why} ` +
          `(контраст ${contrastRatio(after, against).toFixed(1)}:1).`,
      );
    }
  };

  adjust("textOnLight", lightest, CONTRAST.text, `замало контрасту зі світлим тлом ${lightest}`);
  adjust("textOnDark", darkest, CONTRAST.text, `замало контрасту з темним тлом ${darkest}`);

  const ensureReadable = (role: BasePaletteRole, min: number) => {
    const bg = p[role];
    if (Math.max(contrastRatio(p.textOnLight, bg), contrastRatio(p.textOnDark, bg)) >= min) return;
    const why = `текст на кольорі «${PALETTE_ROLE_UK[role]}» ${bg}`;
    // Поріг 0.179 — яскравість, за якої чорний і білий текст дають однаковий контраст.
    if (luminance(bg) > 0.179) adjust("textOnLight", bg, min, why);
    else adjust("textOnDark", bg, min, why);
  };
  ensureReadable("background", CONTRAST.text);
  ensureReadable("surface", CONTRAST.text);
  ensureReadable("primary", CONTRAST.large);

  if (contrastRatio(p.accent, p.background) < CONTRAST.large) {
    const before = p.accent;
    const toward = luminance(p.background) > 0.179 ? "dark" : "light";
    p.accent = pushToContrast(before, p.background, CONTRAST.large, toward);
    fixes.push(
      `Акцентний колір ${before} → ${p.accent}: зливався з фоном ${p.background} ` +
        `(контраст ${contrastRatio(p.accent, p.background).toFixed(1)}:1).`,
    );
  }
  ensureReadable("accent", CONTRAST.large);

  return { palette: p, fixes };
}

/** Найкращий контраст тексту на ключових кольорах — для тестів і діагностики. */
export function paletteReport(p: Palette): Record<string, number> {
  const best = (bg: string) => Math.max(contrastRatio(p.textOnLight, bg), contrastRatio(p.textOnDark, bg));
  return {
    background: best(p.background),
    surface: best(p.surface),
    primary: best(p.primary),
    accent: best(p.accent),
    accentVsBackground: contrastRatio(p.accent, p.background),
  };
}
