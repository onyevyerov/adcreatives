import type { Fact, FactKind, SiteData } from "@adc/shared";

/**
 * Факти бренд-кіта: перевірка цитат із сайту, нумерація, факти від клієнта.
 * Факт із сайту живе лише тоді, коли його цитата дослівно (з точністю до пробілів, лапок і тире)
 * є в тексті, який зібрав краулер, і всі числа з `text` є в цитаті.
 */

/** Нормалізація для пошуку цитати: регістр, пробіли, лапки, апострофи, тире. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[  -​  　]/g, " ")
    .replace(/[’‘ʼ`´']/g, "'")
    .replace(/[«»“”„‟"]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Числа в тексті (1 200, 10%, 4.8 → «1200», «10», «4.8»). */
export function extractNumbers(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\d[\d\s  ]*(?:[.,]\d+)?/g)) {
    const n = m[0]
      .replace(/[\s  ]/g, "")
      .replace(",", ".")
      .replace(/\.$/, "");
    if (n) out.push(n);
  }
  return out;
}

export interface SourceText {
  url: string | null;
  /** Нормалізований текст сторінки. */
  norm: string;
}

/** Увесь текст, який зібрав краулер, по сторінках (включно з ручним текстом клієнта, url = null). */
export function siteSources(site: SiteData): SourceText[] {
  const out: SourceText[] = site.pages.map((p) => ({
    url: p.url,
    norm: normalizeForMatch(
      [
        p.title,
        p.description ?? "",
        ...p.headings.map((h) => h.text),
        p.text,
        ...p.buttons,
        JSON.stringify(p.jsonLd),
        ...Object.values(p.og),
      ].join("\n"),
    ),
  }));
  if (site.manualText) out.push({ url: null, norm: normalizeForMatch(site.manualText) });
  return out;
}

function trimQuote(q: string): string {
  return normalizeForMatch(q).replace(/^[\s"'.,;:!?…-]+|[\s"'.,;:!?…-]+$/g, "");
}

/** Де знайдено цитату: спершу на заявленій сторінці, потім деінде. undefined — ніде. */
export function locateQuote(
  quote: string,
  sources: readonly SourceText[],
  preferredUrl: string | null,
): SourceText | undefined {
  const q = trimQuote(quote);
  if (q.length < 3) return undefined;
  const preferred = sources.find((s) => preferredUrl !== null && sameUrl(s.url, preferredUrl));
  if (preferred?.norm.includes(q)) return preferred;
  return sources.find((s) => s.norm.includes(q));
}

function sameUrl(a: string | null, b: string): boolean {
  if (a === null) return false;
  const n = (u: string) =>
    u
      .replace(/[#?].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  return n(a) === n(b);
}

export interface FactsCheckResult {
  facts: Fact[];
  /** Факти, відкинуті під час перевірки, з причиною. */
  dropped: Array<{ fact: Fact; reason: string }>;
  fixes: string[];
}

/**
 * Перевіряє факти з сайту: цитата є в зібраному тексті, числа з `text` є в цитаті.
 * Без цитати, але з `text`, дослівно знайденим на сайті, — цитатою стає `text`.
 * Невідповідну `sourceUrl` виправляє на сторінку, де знайдено цитату.
 * Для ручного режиму (текст від клієнта) факти отримують `source: "client"`.
 */
export function verifySiteFacts(facts: readonly Fact[], site: SiteData | null): FactsCheckResult {
  const sources = site ? siteSources(site) : [];
  const out: Fact[] = [];
  const dropped: FactsCheckResult["dropped"] = [];
  const fixes: string[] = [];

  for (const fact of facts) {
    if (fact.source === "client") {
      out.push({ ...fact });
      continue;
    }
    if (!site) {
      // Немає site.json (не мав би статись) — нема чим перевірити, залишаємо як є.
      out.push({ ...fact });
      continue;
    }
    const quote = fact.quote?.trim() ? fact.quote : fact.text;
    const found = locateQuote(quote, sources, fact.sourceUrl);
    if (!found) {
      dropped.push({ fact, reason: "цитату не знайдено на сайті" });
      continue;
    }
    const quoteNums = new Set(extractNumbers(quote));
    const missing = extractNumbers(fact.text).filter((n) => !quoteNums.has(n));
    if (missing.length) {
      dropped.push({ fact, reason: `числа ${missing.join(", ")} відсутні в цитаті` });
      continue;
    }
    if (found.url === null) {
      out.push({ ...fact, source: "client", sourceUrl: null, quote: quote.trim() });
      continue;
    }
    if (fact.sourceUrl && !sameUrl(fact.sourceUrl, found.url)) {
      fixes.push(`Факт «${fact.text}»: джерело виправлено на ${found.url}.`);
    }
    out.push({ ...fact, sourceUrl: found.url, quote: quote.trim() });
  }
  for (const d of dropped) fixes.push(`Факт «${d.fact.text}» прибрано: ${d.reason}.`);
  return { facts: out, dropped, fixes };
}

function nextId(prefix: "f" | "c", used: Set<string>): string {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

/**
 * Призначає id: факти сайту — f1, f2…, клієнта — c1, c2….
 * `keep` — id, які вже існують у попередній версії й мають лишитися стабільними (на них посилається сценарій).
 */
export function assignFactIds(facts: readonly Fact[], keep: ReadonlySet<string> = new Set()): Fact[] {
  const used = new Set<string>();
  const ok = (f: Fact) => {
    const prefix = f.source === "site" ? "f" : "c";
    return keep.has(f.id) && new RegExp(`^${prefix}\\d+$`).test(f.id) && !used.has(f.id);
  };
  const kept = facts.map((f) => {
    if (!ok(f)) return null;
    used.add(f.id);
    return f.id;
  });
  return facts.map((f, i) => ({ ...f, id: kept[i] ?? nextId(f.source === "site" ? "f" : "c", used) }));
}

/** Прибирає дублікати за нормалізованим текстом (перший виграє). */
export function dedupeFacts(facts: readonly Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = normalizeForMatch(f.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const STOP = new Set([
  "який",
  "яка",
  "яке",
  "також",
  "тільки",
  "лише",
  "щодня",
  "with",
  "from",
  "only",
  "your",
  "this",
  "that",
  "every",
]);

/** Змістовні основи слів (перші 5 літер слів від 4 літер) — для пошуку «того самого» факту. */
function topicStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeForMatch(text).match(/\p{L}{4,}/gu) ?? []) {
    if (!STOP.has(w)) out.add(w.slice(0, 5));
  }
  return out;
}

/** Факт клієнта суперечить факту сайту: той самий вид, спільна тема, інші числа. */
export function conflicts(site: Fact, client: { kind: FactKind; text: string }): boolean {
  if (site.kind !== client.kind) return false;
  const a = topicStems(site.text);
  const shared = [...topicStems(client.text)].some((s) => a.has(s));
  if (!shared) return false;
  const na = extractNumbers(site.text).join(",");
  const nb = extractNumbers(client.text).join(",");
  return na !== nb;
}

export interface ClientFactsResult {
  facts: Fact[];
  added: Fact[];
  replaced: Fact[];
  fixes: string[];
}

/**
 * Додає факти від клієнта. Якщо факт клієнта суперечить факту сайту — факт сайту прибирається
 * (перемагає клієнт). Дублікати не додаються. Існуючі id не змінюються.
 */
export function addClientFacts(
  facts: readonly Fact[],
  incoming: ReadonlyArray<{ kind: FactKind; text: string }>,
): ClientFactsResult {
  let current = [...facts];
  const added: Fact[] = [];
  const replaced: Fact[] = [];
  const fixes: string[] = [];
  const used = new Set(current.map((f) => f.id));

  for (const c of incoming) {
    const text = c.text.trim();
    if (!text) continue;
    if (current.some((f) => normalizeForMatch(f.text) === normalizeForMatch(text))) continue;
    const conflicting = current.filter((f) => f.source === "site" && conflicts(f, { kind: c.kind, text }));
    if (conflicting.length) {
      current = current.filter((f) => !conflicting.includes(f));
      replaced.push(...conflicting);
    }
    const fact: Fact = {
      id: nextId("c", used),
      kind: c.kind,
      text,
      source: "client",
      sourceUrl: null,
      quote: null,
    };
    current.push(fact);
    added.push(fact);
    for (const r of conflicting) {
      fixes.push(`Факт сайту ${r.id} «${r.text}» замінено фактом клієнта ${fact.id} «${fact.text}».`);
    }
  }
  return { facts: current, added, replaced, fixes };
}
