import type { BrandKit, Claim, ClaimKind, ClaimsReport, Fact, Storyboard } from "@adc/shared";

/**
 * `verifyClaims(storyboard, brandkit)` — програмна перевірка тверджень у текстах сцен (розділ «Факти»):
 * кожне число (ціна, відсоток, кількість, дата/час, телефон) і кожен маркер переваги чи обіцянки
 * («№1», «найкращий», «гарантія», «best», «guarantee» …, списки для uk і en) має знаходитися
 * у `facts[]` бренд-кіта або в контактах/графіку. Непідтверджене → `unverified[]`.
 */

/** Твердження, знайдене в тексті (до звірки). */
export interface ExtractedClaim {
  text: string;
  kind: ClaimKind;
  /** Нормалізоване значення: число («75», «4.8»), дата/час («10:00», «1.05»), цифри телефону. */
  value: string | null;
  /** Для маркерів — основа слова в нижньому регістрі («найкращ», «best», «№1»). */
  marker: string | null;
  /** Телефон (звіряється з контактами за цифрами). */
  phone?: boolean;
}

const L = "\\p{L}\\p{M}ʼ'’";
const NB = `(?<![${L}\\d])`; // ліва межа слова (Unicode)
const NA = `(?![${L}\\d])`; // права межа слова
const NUM = "\\d{1,3}(?:[ \\u00A0\\u202F]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?";
const CURRENCY_AFTER =
  "грн\\.?|гривень|гривні|гривня|гривен|₴|uah|usd|eur|euro|євро|доларів|долари|долар|\\$|€|£|zł|pln";
const MONTHS_UK =
  "січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|січень|лютий|березень|квітень|травень|червень|липень|серпень|вересень|жовтень|листопад|грудень";
const MONTHS_EN =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

/** Маркери переваги (superlative) і обіцянок (guarantee); `stem` — як шукати у фактах. */
interface MarkerRule {
  re: RegExp;
  kind: "superlative" | "guarantee";
  stem: (match: string) => string;
}

const firstStem = (len: number) => (m: string) => {
  const w = m.toLowerCase();
  return w.length - 3 >= len ? w.slice(0, w.length - 3) : w.slice(0, Math.min(w.length, len));
};
const literal = (s: string) => () => s;

export const MARKER_RULES: readonly MarkerRule[] = [
  // №1 / #1 / номер один / number one / top-1
  {
    re: new RegExp(
      `(?:№\\s?1|#\\s?1|${NB}no\\.?\\s?1|${NB}номер\\s+(?:один|1)|${NB}number\\s+(?:one|1)|${NB}(?:top|топ)[-\\s]?1)${NA}`,
      "giu",
    ),
    kind: "superlative",
    stem: literal("№1"),
  },
  // uk: найкращий, найсвіжіша, найдешевше… (крім «найм-»: наймати)
  { re: new RegExp(`${NB}най(?!м)[${L}]{3,}`, "giu"), kind: "superlative", stem: firstStem(5) },
  {
    re: new RegExp(`${NB}(?:кращ|неперевершен|лідер|єдин|унікальн|топов)[${L}]*`, "giu"),
    kind: "superlative",
    stem: firstStem(4),
  },
  {
    re: new RegExp(`${NB}(?:гаранті|гарантов|гарантуєм|гаранту)[${L}]*`, "giu"),
    kind: "guarantee",
    stem: literal("гарант"),
  },
  { re: new RegExp(`${NB}безкоштовн[${L}]*`, "giu"), kind: "guarantee", stem: literal("безкоштовн") },
  // en
  {
    re: new RegExp(
      `${NB}(?:best|finest|greatest|cheapest|lowest|fastest|largest|biggest|freshest|tastiest|leading|leader|unbeatable|unmatched|unrivall?ed|unique|award[-\\s]winning|top[-\\s]rated|world[-\\s]class|the\\s+only|better\\s+than|most\\s+[${L}]+)${NA}`,
      "giu",
    ),
    kind: "superlative",
    stem: (m) => m.toLowerCase().replace(/\s+/g, " "),
  },
  {
    re: new RegExp(`${NB}(?:guarantee[ds]?|guaranteed|warrant(?:y|ies|ed))${NA}`, "giu"),
    kind: "guarantee",
    stem: literal("guarantee"),
  },
  { re: new RegExp(`(?<![-${L}\\d])free${NA}(?!-)`, "giu"), kind: "guarantee", stem: literal("free") },
];

const PHONE = /\+?\(?\d[\d\s\-().]{7,}\d/g;
const PRICE = new RegExp(
  `(?:[$€£₴]\\s?(?:${NUM})|${NB}(?:${NUM})\\s?(?:${CURRENCY_AFTER})(?![${L}]))`,
  "giu",
);
const PERCENT = new RegExp(`[-–−+]?${NB}(?:${NUM})\\s?(?:%|відсот[${L}]*|percent|per\\s+cent)`, "giu");
const TIME = new RegExp(`${NB}\\d{1,2}:\\d{2}${NA}`, "gu");
const DATE_NUM = new RegExp(`${NB}\\d{1,2}[./]\\d{2}(?:[./]\\d{2,4})?${NA}`, "gu");
const DATE_WORD = new RegExp(
  `${NB}(?:\\d{1,2}\\s+(?:${MONTHS_UK}|${MONTHS_EN})|(?:${MONTHS_EN})\\.?\\s+\\d{1,2})${NA}`,
  "giu",
);
const YEAR = new RegExp(`${NB}(?:19|20)\\d{2}${NA}`, "gu");
const NUMBER = new RegExp(`${NB}(?:${NUM})(?!\\d)`, "gu");

export function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(/[\s  ]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? String(n) : cleaned;
}

function numberIn(s: string): string | null {
  const m = new RegExp(NUM, "u").exec(s);
  return m ? normalizeNumber(m[0]) : null;
}

function normalizeTime(s: string): string {
  const [h, m] = s.split(":");
  return `${Number(h)}:${m}`;
}

function normalizeDate(s: string): string {
  const lower = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^\d/.test(lower) && /[./]/.test(lower)) {
    return lower
      .split(/[./]/)
      .map((p) => String(Number(p)))
      .join(".");
  }
  const nums = lower.match(/\d+/g) ?? [];
  const word = lower.replace(/[\d.\s]+/g, "").slice(0, 3);
  return `${nums.map((n) => String(Number(n))).join(".")} ${word}`.trim();
}

const digitsOnly = (s: string) => s.replace(/\D/g, "");
/** Останні 9 цифр — однаково для +380 67… і 067…. */
const phoneKey = (s: string) => digitsOnly(s).slice(-9);

/** Витягує твердження з тексту. Знайдені фрагменти маскуються, щоб «№1» не дав ще й число 1. */
export function extractClaims(text: string): ExtractedClaim[] {
  const out: Array<ExtractedClaim & { index: number }> = [];
  let masked = text;
  const take = (re: RegExp, make: (m: string) => ExtractedClaim | null) => {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re)) {
      const raw = m[0];
      const claim = make(raw.trim());
      if (!claim) continue;
      const index = m.index ?? 0;
      masked = masked.slice(0, index) + " ".repeat(raw.length) + masked.slice(index + raw.length);
      out.push({ ...claim, index });
    }
  };

  for (const rule of MARKER_RULES) {
    take(rule.re, (m) => ({ text: m, kind: rule.kind, value: null, marker: rule.stem(m) }));
  }
  take(PHONE, (m) =>
    digitsOnly(m).length >= 9
      ? { text: m, kind: "number", value: digitsOnly(m), marker: null, phone: true }
      : null,
  );
  take(PRICE, (m) => ({ text: m, kind: "price", value: numberIn(m), marker: null }));
  take(PERCENT, (m) => ({ text: m, kind: "percent", value: numberIn(m), marker: null }));
  take(TIME, (m) => ({ text: m, kind: "date", value: normalizeTime(m), marker: null }));
  take(DATE_NUM, (m) => ({ text: m, kind: "date", value: normalizeDate(m), marker: null }));
  take(DATE_WORD, (m) => ({ text: m, kind: "date", value: normalizeDate(m), marker: null }));
  take(YEAR, (m) => ({ text: m, kind: "date", value: m, marker: null }));
  take(NUMBER, (m) => ({ text: m, kind: "number", value: normalizeNumber(m), marker: null }));

  return out.sort((a, b) => a.index - b.index).map(({ index: _i, ...c }) => c);
}

interface Corpus {
  values: Set<string>;
  percents: Set<string>;
  phones: Set<string>;
  lower: string;
}

function corpusOf(texts: ReadonlyArray<string | null | undefined>): Corpus {
  const joined = texts.filter((t): t is string => Boolean(t)).join("\n");
  const values = new Set<string>();
  const percents = new Set<string>();
  const phones = new Set<string>();
  for (const c of extractClaims(joined)) {
    if (c.phone && c.value) phones.add(phoneKey(c.value));
    if (c.value !== null) values.add(c.value);
    if (c.kind === "percent" && c.value !== null) percents.add(c.value);
  }
  return { values, percents, phones, lower: joined.toLowerCase() };
}

function matches(claim: ExtractedClaim, corpus: Corpus): boolean {
  if (claim.marker !== null) return corpus.lower.includes(claim.marker);
  if (claim.value === null) return false;
  if (claim.phone) return corpus.phones.has(phoneKey(claim.value)) || corpus.values.has(claim.value);
  if (claim.kind === "percent") return corpus.percents.has(claim.value);
  return corpus.values.has(claim.value);
}

export interface VerifyClaimsOptions {
  now?: Date;
  /** Версія бренд-кіта для звіту (дефолт — `brandkit.version` або 0). */
  brandkitVersion?: number;
}

export function verifyClaims(
  storyboard: Pick<Storyboard, "scenes">,
  brandkit: BrandKit & { version?: number },
  opts: VerifyClaimsOptions = {},
): ClaimsReport {
  // Факти клієнта мають пріоритет над фактами сайту (якщо розходяться — перемагає клієнт).
  const facts = [...brandkit.facts].sort(
    (a, b) => (a.source === "client" ? 0 : 1) - (b.source === "client" ? 0 : 1),
  );
  const factCorpus = new Map<string, Corpus>(facts.map((f: Fact) => [f.id, corpusOf([f.text, f.quote])]));
  const contacts = corpusOf([
    brandkit.identity.name,
    brandkit.location.hours,
    brandkit.location.address,
    brandkit.location.city,
    brandkit.identity.city,
    ...brandkit.contacts.phones,
    ...brandkit.contacts.emails,
    brandkit.contacts.website,
  ]);

  const verified: Claim[] = [];
  const unverified: Claim[] = [];
  for (const scene of storyboard.scenes) {
    const preferred = new Set(scene.factIds);
    const order = [...facts.filter((f) => preferred.has(f.id)), ...facts.filter((f) => !preferred.has(f.id))];
    for (const field of ["headline", "sub"] as const) {
      const text = scene.text[field];
      if (!text) continue;
      for (const c of extractClaims(text)) {
        const fact = order.find((f) => matches(c, factCorpus.get(f.id) as Corpus)) ?? null;
        const matchedContact = fact === null && matches(c, contacts);
        const claim: Claim = {
          sceneId: scene.id,
          field,
          itemId: null,
          text: c.text,
          kind: c.kind,
          factId: fact?.id ?? null,
          matchedContact,
          matchedSite: false,
        };
        (fact || matchedContact ? verified : unverified).push(claim);
      }
    }
  }
  return {
    checkedAt: (opts.now ?? new Date()).toISOString(),
    brandkitVersion: opts.brandkitVersion ?? brandkit.version ?? 0,
    verified,
    unverified,
  };
}
