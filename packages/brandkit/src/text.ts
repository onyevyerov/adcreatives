import type { PageData, SiteData } from "@adc/shared";

/**
 * Детерміноване стиснення тексту сайту до бюджету токенів.
 * Пріоритет сторінок: головна → про нас → послуги/меню/ціни → решта; рядки з фактами
 * (ціни, числа, знижки, гарантії) беруться раніше за звичайний текст.
 */

/** Груба оцінка токенів: кирилиця ≈ 2.5 символа на токен, решта ≈ 4. */
export function estimateTokens(text: string): number {
  let cyr = 0;
  for (const ch of text) if (/[Ѐ-ӿ]/.test(ch)) cyr++;
  return Math.ceil(cyr / 2.5 + (text.length - cyr) / 4);
}

const PAGE_PRIORITY: Array<{ score: number; re: RegExp }> = [
  {
    score: 90,
    re: /about|pro-nas|pro_nas|about-us|company|o-nas|history|історія|про-нас|team|komanda|команда/i,
  },
  {
    score: 80,
    re: /services?|poslug|послуг|products?|tovar|товар|menu|меню|pricing|prices?|price-list|tsiny|ціни|прайс|catalog|каталог/i,
  },
  { score: 60, re: /offer|akci|акці|sale|promo|знижк|discount|special/i },
  { score: 50, re: /reviews?|vidguk|відгук|testimonials?|portfolio|портфоліо|cases?|кейс/i },
  { score: 40, re: /contacts?|kontakt|контакт|location|address|адрес|delivery|доставк/i },
];

/** Рядок, імовірно, містить факт: число, ціну, відсоток, гарантію, рейтинг. */
const FACT_LINE =
  /\d|грн|₴|\$|€|uah|usd|%|гаранті|guarantee|warranty|знижк|discount|акці|безкоштовн|free|рок(ів|и)|years?|клієнт|customers?|рейтинг|rating|відгук|reviews?|№\s?1|найкращ|best/i;

const MAX_LINE = 400;

export interface CompressOptions {
  /** Бюджет токенів для тексту сайту (дефолт 12 000). */
  budgetTokens?: number;
}

export interface CompressedText {
  text: string;
  tokens: number;
  /** Частину тексту відкинуто через бюджет. */
  truncated: boolean;
  /** URL сторінок, від яких щось потрапило в текст, у порядку пріоритету. */
  pages: string[];
}

function urlPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

function isHome(page: PageData, site: SiteData): boolean {
  const home = site.finalUrl ?? site.url;
  if (home && stripSlash(page.url) === stripSlash(home)) return true;
  const p = urlPath(page.url).replace(/\/+$/, "");
  return p === "" || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(p) || /^\/index\.(html?|php)$/i.test(p);
}

function stripSlash(u: string): string {
  return u.replace(/[#?].*$/, "").replace(/\/+$/, "");
}

/** Сторінки за пріоритетом; стабільно для однакових балів. */
export function rankPages(site: SiteData): PageData[] {
  const scored = site.pages.map((page, i) => {
    let score = 0;
    if (isHome(page, site)) score = 100;
    else {
      const hay = `${urlPath(page.url)} ${page.title}`;
      for (const { score: s, re } of PAGE_PRIORITY) if (re.test(hay)) score = Math.max(score, s);
    }
    return { page, score, i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.page);
}

/** Розбиває текст на речення/рядки, нормалізуючи пробіли. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n+/)) {
    const clean = block.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    // Речення: межа після . ! ? … перед великою літерою/цифрою/лапкою.
    const parts = clean.split(/(?<=[.!?…])\s+(?=[\p{Lu}\d«"“])/u);
    for (const part of parts) {
      const p = part.trim();
      if (!p) continue;
      out.push(p.length > MAX_LINE ? `${p.slice(0, MAX_LINE)}…` : p);
    }
  }
  return out;
}

/** Нейтралізує кутові дужки, щоб текст сайту не міг закрити чи відкрити наші теги-обгортки. */
export function sanitizeForTags(text: string): string {
  return text.replaceAll("<", "‹").replaceAll(">", "›");
}

const normLine = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

interface Chunk {
  pageIdx: number;
  order: number;
  text: string;
  tokens: number;
  pass: 0 | 1 | 2;
}

function jsonLdBrief(jsonLd: readonly unknown[]): string | null {
  if (!jsonLd.length) return null;
  const s = JSON.stringify(jsonLd);
  return s.length > 1200 ? `${s.slice(0, 1200)}…` : s;
}

/**
 * Стискає текст сайту до бюджету. Три проходи жадібного відбору:
 * 0 — заголовки, описи, кнопки, JSON-LD (за пріоритетом сторінок);
 * 1 — рядки з фактами всіх сторінок; 2 — решта тексту.
 * Повтори між сторінками (шапки, футери) прибираються. Рендер — по сторінках у вихідному порядку рядків.
 */
export function compressSiteText(site: SiteData, opts: CompressOptions = {}): CompressedText {
  const budget = opts.budgetTokens ?? 12_000;
  const pages = rankPages(site);
  const chunks: Chunk[] = [];
  const seen = new Set<string>();

  const push = (pageIdx: number, order: number, text: string, pass: Chunk["pass"]) => {
    const key = normLine(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const safe = sanitizeForTags(text);
    chunks.push({ pageIdx, order, text: safe, tokens: estimateTokens(safe) + 1, pass });
  };

  if (site.manualText?.trim()) {
    splitLines(site.manualText).forEach((line, i) => {
      push(-1, i, line, 0);
    });
  }

  pages.forEach((page, pi) => {
    let order = 0;
    if (page.description) push(pi, order++, `Опис: ${page.description}`, 0);
    for (const h of page.headings.slice(0, 12)) push(pi, order++, `${"#".repeat(h.level)} ${h.text}`, 0);
    if (page.buttons.length)
      push(pi, order++, `Кнопки: ${[...new Set(page.buttons)].slice(0, 10).join(" | ")}`, 0);
    const ld = jsonLdBrief(page.jsonLd);
    if (ld) push(pi, order++, `JSON-LD: ${ld}`, 0);
    for (const line of splitLines(page.text)) push(pi, order++, line, FACT_LINE.test(line) ? 1 : 2);
  });

  const headerTokens = (pi: number) => {
    const page = pi < 0 ? null : pages[pi];
    return page ? estimateTokens(`<page url="${page.url}" title="${page.title}">`) + 4 : 8;
  };

  let used = 0;
  const chosen: Chunk[] = [];
  const opened = new Set<number>();
  let truncated = false;
  for (const pass of [0, 1, 2] as const) {
    const list = chunks
      .filter((c) => c.pass === pass)
      .sort((a, b) => a.pageIdx - b.pageIdx || a.order - b.order);
    for (const c of list) {
      const extra = opened.has(c.pageIdx) ? 0 : headerTokens(c.pageIdx);
      if (used + c.tokens + extra > budget) {
        truncated = true;
        continue;
      }
      used += c.tokens + extra;
      opened.add(c.pageIdx);
      chosen.push(c);
    }
  }

  const byPage = new Map<number, Chunk[]>();
  for (const c of chosen) byPage.set(c.pageIdx, [...(byPage.get(c.pageIdx) ?? []), c]);
  const sections: string[] = [];
  const usedPages: string[] = [];
  for (const pi of [...byPage.keys()].sort((a, b) => a - b)) {
    const lines = (byPage.get(pi) ?? []).sort((a, b) => a.order - b.order).map((c) => c.text);
    if (pi < 0) {
      sections.push(`<client_text>\n${lines.join("\n")}\n</client_text>`);
      continue;
    }
    const page = pages[pi];
    if (!page) continue;
    usedPages.push(page.url);
    const attr = (s: string) => sanitizeForTags(s).replaceAll('"', "'");
    sections.push(`<page url="${attr(page.url)}" title="${attr(page.title)}">\n${lines.join("\n")}\n</page>`);
  }
  const text = sections.join("\n\n");
  return { text, tokens: estimateTokens(text), truncated, pages: usedPages };
}
