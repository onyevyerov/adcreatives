import { emptySubstance, type ProductSubstance } from "@adc/shared";
import { normalizeForMatch } from "./facts.ts";

/**
 * Перевірка «речовини продукту» (`BrandKit.substance`) на дослівність.
 * Кожен рядок має бути в тексті сайту, який бачив бренд-кіт (`brandkit/site-text.txt`):
 * без урахування регістру, пробілів, варіантів лапок і тире, по межах слова.
 * Знайдений рядок замінюється написанням із сайту (тоді `claims` сценарію його впізнають),
 * ненайдений — викидається зі звітом у `fixes`.
 */

/** Ліміти списків: більше сценарист не покаже, а промпт роздувається. */
export const SUBSTANCE_LIMITS = {
  steps: 8,
  checks: 12,
  exampleIssues: 6,
  planRows: 12,
  products: 8,
  comparisons: 6,
} as const satisfies Record<keyof ProductSubstance, number>;

const SECTION_UK: Record<keyof ProductSubstance, string> = {
  steps: "крок",
  checks: "що перевіряє",
  exampleIssues: "приклад результату",
  planRows: "рядок плану",
  products: "продукт",
  comparisons: "порівняння",
};

const QUOTES = "\"'«»“”„‟’‘ʼ`´";
const DASHES = "-‐‑‒–—―−";
const QUOTE_RE = new RegExp(`[${QUOTES}]`);
const DASH_RE = new RegExp(`[${DASHES}]`);
/**
 * Лапки й пунктуація, які модель могла дописати по краях рядка, і маркер демо-рядка краулера
 * («> », у site-text.txt — «› »): він не частина тексту сайту. Тире на початку лишається:
 * «−50%» не має перетворитися на «50%».
 */
const EDGE_RE = new RegExp(`^[\\s${QUOTES}>›]+|[\\s${QUOTES}.,;:!?…]+$`, "gu");

const escapeRe = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Шаблон дослівного пошуку рядка; null — рядок порожній після обрізання країв. */
function verbatimPattern(text: string): string | null {
  const core = text.normalize("NFC").replace(EDGE_RE, "");
  if (!core) return null;
  let body = "";
  let space = false;
  for (const ch of core) {
    if (/\s/u.test(ch)) {
      space = true;
      continue;
    }
    if (space) body += "\\s+";
    space = false;
    if (QUOTE_RE.test(ch)) body += `[${QUOTES}]`;
    else if (DASH_RE.test(ch)) body += `[${DASHES}]`;
    // Текст сайту в site-text.txt пройшов sanitizeForTags: < > там — ‹ ›.
    else if (ch === "<" || ch === "‹") body += "[<‹]";
    else if (ch === ">" || ch === "›") body += "[>›]";
    else body += escapeRe(ch);
  }
  return `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`;
}

/**
 * Шукач рядків у тексті сайту. Повертає написання з сайту (пробіли стиснуті) або null;
 * збіг з тим самим регістром має перевагу над збігом без урахування регістру.
 * Порожній текст сайту — нічого не знаходиться.
 */
export function substanceMatcher(siteText: string | null | undefined): (text: string) => string | null {
  const hay = (siteText ?? "").normalize("NFC");
  const cache = new Map<string, string | null>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const source = hay.trim() ? verbatimPattern(text) : null;
    // Спершу з урахуванням регістру: якщо на сайті є саме таке написання, воно й лишається.
    const m = source ? (new RegExp(source, "u").exec(hay) ?? new RegExp(source, "iu").exec(hay)) : null;
    const found = m ? m[0].replace(/\s+/g, " ").trim() : null;
    cache.set(text, found);
    return found;
  };
}

export interface SubstanceCheckResult {
  substance: ProductSubstance;
  /** Що викинуто чи обрізано, людською мовою. */
  fixes: string[];
}

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

/**
 * Залишає в `substance` лише дослівні рядки з тексту сайту.
 * Обов'язкове поле запису (назва кроку, заголовок прикладу, текст рядка плану, назва продукту,
 * усі три поля порівняння) не знайдено — запис викидається; необов'язкове — стає null.
 * Повтори прибираються, списки обрізаються до `SUBSTANCE_LIMITS`.
 */
export function verifySubstance(
  input: ProductSubstance,
  siteText: string | null | undefined,
): SubstanceCheckResult {
  const fixes: string[] = [];
  const find = substanceMatcher(siteText);
  const dropped: Record<keyof ProductSubstance, string[]> = {
    steps: [],
    checks: [],
    exampleIssues: [],
    planRows: [],
    products: [],
    comparisons: [],
  };
  const nulled: string[] = [];

  /** Обов'язковий рядок: знайдено — написання з сайту, інакше null (запис піде геть). */
  const required = (section: keyof ProductSubstance, text: string): string | null => {
    if (!text.trim()) return null;
    const found = find(text);
    if (found === null) dropped[section].push(text);
    return found;
  };
  /** Необов'язковий рядок: порожній — null мовчки, ненайдений — null зі звітом. */
  const optional = (text: string | null): string | null => {
    if (text === null || !text.trim()) return null;
    const found = find(text);
    if (found === null) nulled.push(text);
    return found;
  };

  const out = emptySubstance();
  for (const s of input.steps) {
    const name = required("steps", s.name);
    if (name !== null) out.steps.push({ name, detail: optional(s.detail) });
  }
  for (const c of input.checks) {
    const text = required("checks", c);
    if (text !== null) out.checks.push(text);
  }
  for (const e of input.exampleIssues) {
    const title = required("exampleIssues", e.title);
    if (title === null) continue;
    out.exampleIssues.push({
      title,
      severity: e.severity,
      score: optional(e.score),
      explanation: optional(e.explanation),
      fix: optional(e.fix),
      effort: optional(e.effort),
    });
  }
  for (const r of input.planRows) {
    const text = required("planRows", r.text);
    if (text !== null) out.planRows.push({ text, group: optional(r.group), effort: optional(r.effort) });
  }
  for (const p of input.products) {
    const name = required("products", p.name);
    if (name !== null) out.products.push({ name, oneLiner: optional(p.oneLiner) });
  }
  for (const c of input.comparisons) {
    const parts = [c.criterion, c.us, c.alternative].map((t) => (t.trim() ? find(t) : null));
    const [criterion, us, alternative] = parts;
    if (criterion && us && alternative) out.comparisons.push({ criterion, us, alternative });
    else dropped.comparisons.push(`${c.criterion}: ${c.us} / ${c.alternative}`);
  }

  for (const section of Object.keys(dropped) as Array<keyof ProductSubstance>) {
    const lines = dropped[section];
    if (!lines.length) continue;
    fixes.push(
      `Речовина продукту (${SECTION_UK[section]}): не знайдено дослівно в тексті сайту — прибрано ` +
        `${lines.map((l) => `«${short(l)}»`).join(", ")}.`,
    );
  }
  if (nulled.length) {
    fixes.push(
      `Речовина продукту: подробиці, яких немає дослівно в тексті сайту, прибрано: ` +
        `${nulled.map((l) => `«${short(l)}»`).join(", ")}.`,
    );
  }

  const key = (s: string) => normalizeForMatch(s);
  const dedupe = <T>(section: keyof ProductSubstance, items: T[], id: (x: T) => string): T[] => {
    const seen = new Set<string>();
    const unique = items.filter((x) => {
      const k = key(id(x));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const limit = SUBSTANCE_LIMITS[section];
    if (unique.length > limit) {
      fixes.push(
        `Речовина продукту (${SECTION_UK[section]}): ${unique.length} записів, лишено перші ${limit}.`,
      );
    }
    return unique.slice(0, limit);
  };

  return {
    substance: {
      steps: dedupe("steps", out.steps, (s) => s.name),
      checks: dedupe("checks", out.checks, (c) => c),
      exampleIssues: dedupe("exampleIssues", out.exampleIssues, (e) => e.title),
      planRows: dedupe("planRows", out.planRows, (r) => r.text),
      products: dedupe("products", out.products, (p) => p.name),
      comparisons: dedupe("comparisons", out.comparisons, (c) => c.criterion),
    },
    fixes,
  };
}
