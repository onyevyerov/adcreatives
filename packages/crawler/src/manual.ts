import { SiteData } from "@adc/shared";
import { mergeContacts } from "./contacts.ts";

/** Мова тексту клієнта: українська, російська, англійська або null. */
export function guessLanguage(input: string): string | null {
  // Адреси, email і домени не кажуть про мову тексту.
  const text = input.replace(/\S+@\S+|(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, " ");
  const cyr = (text.match(/[а-яґєіїё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  if (cyr === 0 && lat === 0) return null;
  if (cyr >= lat) {
    const uk = (text.match(/[ґєії']/gi) ?? []).length;
    const ru = (text.match(/[ёыэъ]/gi) ?? []).length;
    return ru > uk ? "ru" : "uk";
  }
  return "en";
}

/**
 * Мінімальний `site.json` для ручного режиму (сайту немає або він недоступний):
 * текст клієнта як є, контакти з тексту, без сторінок і дизайну.
 */
export function buildManualSiteData(manualText: string, now: Date = new Date()): SiteData {
  const text = manualText.trim();
  const contacts = mergeContacts([{ phones: [], emails: [], socials: [], addresses: [], bodyText: text }]);
  return SiteData.parse({
    source: "manual",
    url: null,
    finalUrl: null,
    crawledAt: now.toISOString(),
    partial: false,
    language: guessLanguage(text),
    languageVersions: [],
    pages: [],
    navigation: [],
    contacts,
    design: null,
    screenshots: [],
    manualText: text,
    stats: { pagesVisited: 0, pagesFailed: 0, durationMs: 0 },
  });
}
