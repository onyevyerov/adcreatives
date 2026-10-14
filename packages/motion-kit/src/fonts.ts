import type { LocalFont } from "@adc/shared/types/video";
import { loadFont } from "@remotion/fonts";
import type { FontInfo } from "@remotion/google-fonts/base";
import { loadFontFromInfo } from "@remotion/google-fonts/from-info";
import { staticFile } from "remotion";

/**
 * Шрифти бренду: з Google Fonts або локальні файли сайту.
 *
 * Метадані шрифту (`FontInfo`, лише URL-и файлів) резолвить рендер на боці Node і передає в
 * inputProps — так у бандл не потрапляють ~1800 модулів `@remotion/google-fonts`.
 * У браузері `loadFontFromInfo` реєструє `@font-face` і чекає файли (`delayRender` усередині).
 *
 * Сімейства з `origin: "local"` (шрифт сайту, якого немає в Google Fonts) приходять як `LocalFont[]`:
 * файли лежать у `public/fonts/` задачі, `loadFont` з `@remotion/fonts` реєструє їх через `staticFile`.
 */

export type { FontInfo, LocalFont };

/** Потрібні підмножини: українська й англійська. */
export const FONT_SUBSETS = ["latin", "cyrillic"] as const;

export const FALLBACK_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** CSS font-family з резервним стеком. */
export function fontStack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${FALLBACK_STACK}`;
}

/** Моношрифт бренд-кіта без `typography.mono` (старі версії); ім'я узгоджене з fonts.json бренд-кіта. */
export const MONO_FAMILY = "JetBrains Mono";

/** Ваги моношрифту за замовчуванням: цифри й мітки (400) і акцентні числа (700). */
export const MONO_WEIGHTS: readonly number[] = [400, 700];

/** Системний моноширинний стек: резерв, поки моношрифт не завантажено або якщо його немає. */
export const MONO_FALLBACK_STACK = "ui-monospace, monospace";

/** CSS font-family моношрифту з системним моноширинним резервом. */
export function monoStack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${MONO_FALLBACK_STACK}`;
}

/**
 * Моношрифт бренду: `typography.mono` або `JetBrains Mono` 400/700. Завантажується, як heading і body,
 * якщо рендер передав його метадані (`FontInfo`); інакше — системний моноширинний стек.
 */
export function monoChoice(typography: { mono?: { family: string; weights: number[] } | null }): {
  family: string;
  weights: number[];
} {
  const mono = typography.mono;
  return mono
    ? { family: mono.family, weights: [...mono.weights] }
    : { family: MONO_FAMILY, weights: [...MONO_WEIGHTS] };
}

/** Найближча доступна вага (для 700 при наявних 600/800 — 600, при рівності — важча). */
export function nearestWeight(wanted: number, available: readonly number[]): number {
  if (available.length === 0) return wanted;
  return [...available].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || b - a)[0] as number;
}

export interface FontPlan {
  family: string;
  /** Фактичні ваги, які буде завантажено (≤ запитаних, дедуплікація). */
  weights: number[];
  subsets: string[];
  /** null — шрифту немає серед переданих метаданих Google Fonts. */
  info: FontInfo | null;
  /**
   * Локальні файли сімейства (лише коли `info` null): по одному на фактичну вагу.
   * Порожньо разом з `info: null` — рендеримо резервним стеком.
   */
  local: LocalFont[];
}

/**
 * Ваги і підмножини, які реально є в шрифті. Спершу шукає серед метаданих Google Fonts, далі —
 * серед локальних файлів сайту (`localFonts`).
 */
export function planFont(
  family: string,
  wanted: readonly number[],
  infos: readonly FontInfo[],
  localFonts: readonly LocalFont[] = [],
): FontPlan {
  const info = infos.find((i) => i.fontFamily === family) ?? null;
  if (!info) {
    const files = localFonts.filter((f) => f.family === family);
    if (files.length === 0)
      return {
        family,
        weights: [...new Set(wanted)].sort((a, b) => a - b),
        subsets: [],
        info: null,
        local: [],
      };
    const available = files.map((f) => f.weight);
    const weights = [...new Set(wanted.map((w) => nearestWeight(w, available)))].sort((a, b) => a - b);
    // Одна вага — один файл (перший; формати рендер уже відібрав).
    const local = weights.map((w) => files.find((f) => f.weight === w) as LocalFont);
    return { family, weights, subsets: [], info: null, local };
  }
  const normal = info.fonts.normal ?? {};
  const available = Object.keys(normal)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const weights = [...new Set(wanted.map((w) => nearestWeight(w, available)))].sort((a, b) => a - b);
  const subsets = FONT_SUBSETS.filter((s) => info.subsets.includes(s));
  return { family, weights, subsets, info, local: [] };
}

/**
 * Обрізає FontInfo до стилю normal, потрібних ваг і підмножин latin+cyrillic —
 * щоб inputProps лишались компактними.
 */
export function pruneFontInfo(info: FontInfo, wanted: readonly number[]): FontInfo {
  const plan = planFont(info.fontFamily, wanted, [info]);
  const normal = info.fonts.normal ?? {};
  const fonts: FontInfo["fonts"] = { normal: {} };
  const keep = new Set<string>(plan.subsets);
  for (const w of plan.weights) {
    const bySubset = normal[String(w)];
    if (!bySubset) continue;
    const kept: Record<string, string> = {};
    for (const [subset, url] of Object.entries(bySubset)) if (keep.has(subset)) kept[subset] = url;
    (fonts.normal as Record<string, Record<string, string>>)[String(w)] = kept;
  }
  const unicodeRanges: Record<string, string> = {};
  for (const [subset, range] of Object.entries(info.unicodeRanges))
    if (keep.has(subset)) unicodeRanges[subset] = range;
  const { variable: _variable, ...rest } = info;
  return { ...rest, fonts, unicodeRanges, subsets: info.subsets.filter((s) => keep.has(s)) };
}

/** Завантажує шрифт у документ; повертає промис готовності. */
export async function loadPlannedFont(plan: FontPlan): Promise<void> {
  if (plan.local.length > 0) {
    // `loadFont` сам тримає `delayRender` на кожен файл; помилка завантаження скасовує рендер,
    // тому до браузера доходять лише файли, які підготовка задачі справді поклала в public/.
    await Promise.all(
      plan.local.map((f) =>
        loadFont({ family: plan.family, url: staticFile(f.src), weight: String(f.weight), format: f.format }),
      ),
    );
    return;
  }
  if (!plan.info || plan.subsets.length === 0) return;
  const loaded = loadFontFromInfo(plan.info, "normal", {
    weights: plan.weights.map(String),
    subsets: plan.subsets,
    ignoreTooManyRequestsWarning: true,
  });
  await loaded.waitUntilDone();
}
