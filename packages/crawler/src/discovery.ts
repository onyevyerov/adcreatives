import type { LanguageVersion } from "@adc/shared";
import { isSameSite, isSkippableUrl, langPrefixOf, normalizeLang, pageKey, parseUrl } from "./url.ts";

/** Посилання-кандидат на сторінку для краулінгу. */
export interface LinkCandidate {
  url: string;
  /** Текст анкора (для sitemap — порожній). */
  text: string;
  /** Посилання з навігації (header/nav). */
  inNav: boolean;
  source: "home" | "sitemap";
}

/**
 * Ключові слова сторінок, які найкраще описують бізнес (англ., укр., рос., транслітерація).
 * Вага більша — сторінка важливіша.
 */
const PAGE_KEYWORDS: Array<{ weight: number; words: string[] }> = [
  {
    weight: 10,
    words: ["about", "about-us", "who-we-are", "про-нас", "pro-nas", "o-nas", "о-нас", "про нас", "о нас"],
  },
  {
    weight: 9,
    words: ["services", "service", "послуги", "послуга", "poslugy", "uslugi", "услуги", "что-мы-делаем"],
  },
  {
    weight: 9,
    words: [
      "products",
      "product",
      "shop",
      "catalog",
      "catalogue",
      "товари",
      "продукція",
      "продукция",
      "каталог",
    ],
  },
  { weight: 9, words: ["menu", "меню", "kitchen", "кухня"] },
  {
    weight: 8,
    words: [
      "pricing",
      "prices",
      "price",
      "tariffs",
      "ціни",
      "прайс",
      "вартість",
      "цены",
      "тарифи",
      "tsiny",
      "ceny",
    ],
  },
  {
    weight: 7,
    words: ["portfolio", "works", "projects", "cases", "gallery", "портфоліо", "роботи", "галерея", "кейси"],
  },
  { weight: 7, words: ["reviews", "testimonials", "відгуки", "отзывы", "vidguky", "otzyvy"] },
  { weight: 6, words: ["team", "staff", "doctors", "команда", "лікарі", "врачи", "komanda"] },
  { weight: 6, words: ["contact", "contacts", "контакти", "контакты", "kontakty", "where", "location"] },
  {
    weight: 4,
    words: ["faq", "delivery", "доставка", "питання", "вопросы", "offers", "акції", "акции", "promo"],
  },
];

/** Сторінки, які майже ніколи не допомагають рекламі. */
const LOW_VALUE =
  /(privacy|policy|terms|cookie|gdpr|oferta|оферта|політика|конфіденц|legal|sitemap|blog\/.+|news\/.+)/i;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Оцінка пріоритету сторінки за ключами в URL і анкорі. */
export function scoreCandidate(candidate: LinkCandidate): number {
  const url = parseUrl(candidate.url);
  if (!url) return Number.NEGATIVE_INFINITY;
  const pathText = decode(url.pathname).toLowerCase();
  const segments = pathText.split("/").filter(Boolean);
  const anchor = candidate.text.toLowerCase().trim();
  let best = 0;
  for (const { weight, words } of PAGE_KEYWORDS) {
    for (const w of words) {
      const inPath = segments.some(
        (s) => s === w || s.startsWith(`${w}-`) || s.endsWith(`-${w}`) || s === `${w}.html`,
      );
      const inAnchor = anchor.length > 0 && anchor.length < 40 && anchor.includes(w.replaceAll("-", " "));
      if (inPath || inAnchor) best = Math.max(best, weight);
    }
  }
  let score = best * 10;
  if (candidate.inNav) score += 15;
  if (candidate.source === "home") score += 5;
  // Мілкі сторінки зазвичай розділи, глибокі — окремі записи.
  score -= Math.max(0, segments.length - 1) * 4;
  if (LOW_VALUE.test(pathText)) score -= 40;
  return score;
}

export interface SelectPagesInput {
  /** Адреса головної (після редиректів). */
  home: string;
  candidates: LinkCandidate[];
  /** Скільки сторінок узяти, крім головної. */
  limit: number;
  /** Мовна версія введеного URL (null — без префікса). */
  lang: string | null;
  /** Адреси інших мовних версій (їх і їхні підсторінки не краулимо). */
  otherVersions: string[];
}

/**
 * Обирає сторінки для краулінгу: той самий сайт, без пропусків, лише мовна версія
 * введеної адреси, без дублів, за пріоритетом.
 */
export function selectPages(input: SelectPagesInput): string[] {
  const home = parseUrl(input.home);
  if (!home) return [];
  const homeKey = pageKey(home);
  const homePrefix = langPrefixOf(home);
  const otherPrefixes = input.otherVersions
    .map((u) => parseUrl(u, home))
    .filter((u): u is URL => u !== null && isSameSite(u, home))
    .map((u) => versionPrefix(u))
    .filter((p) => p !== "/" && p !== versionPrefix(home));

  const best = new Map<string, { url: string; score: number; order: number }>();
  input.candidates.forEach((c, order) => {
    const url = parseUrl(c.url, home);
    if (!url || !isSameSite(url, home) || isSkippableUrl(url)) return;
    const key = pageKey(url);
    if (key === homeKey) return;
    const prefix = langPrefixOf(url);
    // Інша мовна версія за префіксом: краулимо лише версію введеної адреси.
    if (prefix && prefix !== homePrefix) return;
    // Якщо введена адреса має префікс (/en/), сторінки без нього — інша версія.
    if (homePrefix && prefix !== homePrefix) return;
    const lowerPath = url.pathname.toLowerCase();
    if (otherPrefixes.some((p) => lowerPath === p.replace(/\/$/, "") || lowerPath.startsWith(p))) return;
    const score = scoreCandidate(c);
    const existing = best.get(key);
    if (!existing || existing.score < score) {
      best.set(key, { url: stripHash(url), score, order: existing?.order ?? order });
    }
  });
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, input.limit))
    .map((x) => x.url);
}

function stripHash(url: URL): string {
  const u = new URL(url.href);
  u.hash = "";
  return u.href;
}

/** Префікс шляху мовної версії: `/en/` для `https://x/en/…`, `/de-at/` тощо, інакше `/`. */
function versionPrefix(url: URL): string {
  const first = (url.pathname.split("/")[1] ?? "").toLowerCase();
  return /^[a-z]{2}(?:[-_][a-z]{2})?$/.test(first) ? `/${first}/` : "/";
}

/**
 * Розбирає sitemap.xml: повертає адреси сторінок (`<url><loc>`) і вкладені карти
 * (`<sitemap><loc>`, для sitemap index).
 */
export function parseSitemap(xml: string, limit = 500): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const blockRe = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of xml.matchAll(blockRe)) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(m[2] ?? "")?.[1];
    if (!loc) continue;
    const value = decodeXml(loc);
    if ((m[1] ?? "").toLowerCase() === "sitemap") sitemaps.push(value);
    else if (pages.length < limit) pages.push(value);
  }
  return { pages, sitemaps };
}

function decodeXml(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

export interface HreflangLink {
  hreflang: string;
  href: string;
}

/**
 * Мовні версії сайту: з `hreflang` і з посилань із мовними префіксами (`/uk/`, `/ua/`,
 * `/en/`, `/ru/`). Повертає поточну мову і всі версії (порожній список, якщо версія одна).
 */
export function detectLanguageVersions(input: {
  home: string;
  htmlLang: string | null;
  hreflang: HreflangLink[];
  links: string[];
}): { language: string | null; versions: LanguageVersion[] } {
  const home = parseUrl(input.home);
  if (!home) return { language: normalizeLang(input.htmlLang), versions: [] };
  const homePrefix = langPrefixOf(home);
  const language = homePrefix ?? normalizeLang(input.htmlLang);
  const byLang = new Map<string, string>();

  for (const h of input.hreflang) {
    if (h.hreflang.toLowerCase() === "x-default") continue;
    const lang = normalizeLang(h.hreflang);
    const url = parseUrl(h.href, home);
    if (!lang || !url || !isSameSiteOrSub(url, home)) continue;
    if (!byLang.has(lang)) byLang.set(lang, url.href);
  }
  for (const href of input.links) {
    const url = parseUrl(href, home);
    if (!url || !isSameSite(url, home)) continue;
    const lang = langPrefixOf(url);
    if (!lang || byLang.has(lang)) continue;
    const first = url.pathname.split("/")[1] ?? lang;
    byLang.set(lang, new URL(`/${first}/`, url).href);
  }
  if (language && !byLang.has(language)) byLang.set(language, home.href);
  const versions = [...byLang.entries()].map(([lang, url]) => ({ lang, url }));
  if (versions.length < 2) return { language, versions: [] };
  // Поточна мова першою, решта — за алфавітом.
  versions.sort((a, b) =>
    a.lang === language ? -1 : b.lang === language ? 1 : a.lang.localeCompare(b.lang),
  );
  return { language, versions };
}

/** hreflang іноді веде на мовний піддомен (en.example.com) — його теж записуємо. */
function isSameSiteOrSub(url: URL, home: URL): boolean {
  if (isSameSite(url, home)) return true;
  const base = home.hostname.replace(/^www\./, "");
  return url.hostname.endsWith(`.${base}`) && /^[a-z]{2}\./.test(url.hostname);
}
