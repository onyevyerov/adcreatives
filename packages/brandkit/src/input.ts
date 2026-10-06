import type { Asset, DesignStats, ImageInput, SiteData, Storage } from "@adc/shared";
import {
  buildContactSheet,
  type ContactSheet,
  contactSheetLegend,
  prepareScreenshot,
} from "./contactSheet.ts";
import { compressSiteText, rankPages, sanitizeForTags } from "./text.ts";

/**
 * Збирає вхід для промпта `brandkit`: змінні шаблону + image blocks
 * (скриншоти, потім контакт-лист). Увесь вміст сайту — дані всередині тегів.
 */

export interface BrandkitInputOptions {
  /** Бюджет токенів для тексту сайту. */
  textBudgetTokens?: number;
  /** Скільки скриншотів передати (дефолт 6, мінімум за наявності — 4). */
  maxScreenshots?: number;
}

export interface BrandkitInput {
  vars: Record<string, string>;
  images: ImageInput[];
  sheet: ContactSheet | null;
  /** Номер на контакт-листі → assetId. */
  sheetNumbers: Map<number, string>;
  screenshotKeys: string[];
  textTokens: number;
  textTruncated: boolean;
}

/** JSON для вставки в промпт: `<` і `>` екрануються, щоб дані не могли закрити тег. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 1).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * Обирає 4–6 скриншотів: перший екран головної, два екрани нижче неї,
 * далі перші екрани інших сторінок за пріоритетом.
 */
export function pickScreenshots(site: SiteData, max = 6): SiteData["screenshots"] {
  const rank = new Map(rankPages(site).map((p, i) => [p.url, i]));
  const viewportOrder = { first: 0, "below-1": 1, "below-2": 2 } as const;
  const sorted = [...site.screenshots].sort(
    (a, b) =>
      (rank.get(a.pageUrl) ?? 999) - (rank.get(b.pageUrl) ?? 999) ||
      viewportOrder[a.viewport] - viewportOrder[b.viewport],
  );
  const homeUrl = rankPages(site)[0]?.url;
  // Головна дає до 3 кадрів, інші сторінки — лише перший екран.
  const picked = sorted.filter((s) => s.pageUrl === homeUrl || s.viewport === "first");
  return picked.slice(0, max);
}

/** Стисла CSS-статистика для промпта. */
export function summarizeDesign(design: DesignStats | null) {
  if (!design) return null;
  const colorish = /^(#|rgb|hsl)/i;
  const vars = Object.entries(design.cssVars)
    .filter(([k, v]) => colorish.test(v.trim()) || /font|color|brand|primary|accent/i.test(k))
    .slice(0, 40);
  const colors = [...design.colors].sort((a, b) => b.count - a.count).slice(0, 24);
  return {
    cssVars: Object.fromEntries(vars),
    colors,
    fonts: design.fonts,
    buttonRadius: design.buttonRadius,
  };
}

function siteMeta(site: SiteData) {
  return {
    source: site.source,
    url: site.url,
    finalUrl: site.finalUrl,
    language: site.language,
    languageVersions: site.languageVersions,
    partial: site.partial,
    navigation: site.navigation.slice(0, 30),
    contacts: site.contacts,
  };
}

export async function buildBrandkitInput(
  storage: Pick<Storage, "read">,
  site: SiteData,
  assets: readonly Asset[],
  opts: BrandkitInputOptions = {},
): Promise<BrandkitInput> {
  const text = compressSiteText(site, { budgetTokens: opts.textBudgetTokens ?? 12_000 });

  const images: ImageInput[] = [];
  const screenshotKeys: string[] = [];
  const shotsInfo: Array<{ image: number; pageUrl: string; viewport: string }> = [];
  for (const shot of pickScreenshots(site, opts.maxScreenshots ?? 6)) {
    try {
      const data = await prepareScreenshot(await storage.read(shot.path));
      images.push({ mediaType: "image/jpeg", data });
      screenshotKeys.push(shot.path);
      shotsInfo.push({ image: images.length, pageUrl: shot.pageUrl, viewport: shot.viewport });
    } catch {
      // Скриншот не прочитався — продовжуємо без нього.
    }
  }

  let sheet: ContactSheet | null = null;
  if (assets.length) {
    sheet = await buildContactSheet(storage, assets);
    images.push({ mediaType: "image/png", data: sheet.png });
  }
  const sheetNumbers = new Map((sheet?.cells ?? []).map((c) => [c.n, c.assetId]));

  const imagesNote = [
    shotsInfo.length
      ? shotsInfo.map((s) => `Зображення ${s.image}: скриншот ${s.pageUrl} (${s.viewport}).`).join("\n")
      : "Скриншотів немає.",
    sheet
      ? `Зображення ${images.length}: контакт-лист асетів — ${sheet.cells.length} мініатюр із підписами «номер · assetId».`
      : "Асетів (зображень) немає.",
  ].join("\n");

  const vars: Record<string, string> = {
    images_note: imagesNote,
    site_meta: safeJson(siteMeta(site)),
    site_text: text.text || "(текст сайту порожній)",
    design: safeJson(summarizeDesign(site.design)),
    assets_legend: sheet ? safeJson(contactSheetLegend(sheet, assets)) : "[]",
    language_hint: sanitizeForTags(site.language ?? "невідома"),
  };

  return {
    vars,
    images,
    sheet,
    sheetNumbers,
    screenshotKeys,
    textTokens: text.tokens,
    textTruncated: text.truncated,
  };
}
