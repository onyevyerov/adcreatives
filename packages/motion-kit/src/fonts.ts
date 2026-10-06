import type { FontInfo } from "@remotion/google-fonts/base";
import { loadFontFromInfo } from "@remotion/google-fonts/from-info";

/**
 * Шрифти бренду з Google Fonts.
 *
 * Метадані шрифту (`FontInfo`, лише URL-и файлів) резолвить рендер на боці Node і передає в
 * inputProps — так у бандл не потрапляють ~1800 модулів `@remotion/google-fonts`.
 * У браузері `loadFontFromInfo` реєструє `@font-face` і чекає файли (`delayRender` усередині).
 */

export type { FontInfo };

/** Потрібні підмножини: українська й англійська. */
export const FONT_SUBSETS = ["latin", "cyrillic"] as const;

export const FALLBACK_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** CSS font-family з резервним стеком. */
export function fontStack(family: string): string {
  return `"${family.replace(/"/g, "")}", ${FALLBACK_STACK}`;
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
  /** null — шрифту немає серед переданих метаданих (рендеримо резервним стеком). */
  info: FontInfo | null;
}

/** Ваги і підмножини, які реально є в шрифті. */
export function planFont(family: string, wanted: readonly number[], infos: readonly FontInfo[]): FontPlan {
  const info = infos.find((i) => i.fontFamily === family) ?? null;
  if (!info) return { family, weights: [...new Set(wanted)].sort((a, b) => a - b), subsets: [], info: null };
  const normal = info.fonts.normal ?? {};
  const available = Object.keys(normal)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const weights = [...new Set(wanted.map((w) => nearestWeight(w, available)))].sort((a, b) => a - b);
  const subsets = FONT_SUBSETS.filter((s) => info.subsets.includes(s));
  return { family, weights, subsets, info };
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
  if (!plan.info || plan.subsets.length === 0) return;
  const loaded = loadFontFromInfo(plan.info, "normal", {
    weights: plan.weights.map(String),
    subsets: plan.subsets,
    ignoreTooManyRequestsWarning: true,
  });
  await loaded.waitUntilDone();
}
