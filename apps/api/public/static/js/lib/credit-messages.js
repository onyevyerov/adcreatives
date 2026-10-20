// @ts-check
/**
 * Крок 0 · K4 — розпізнавання повідомлень білінгу в стрімі проєкту. Шаблони — дослівні копії
 * `packages/shared/src/i18n/uk.ts` (тест account-core звіряє їх із `t()`): бекенд шле відмови,
 * списання й повернення звичайними повідомленнями `assistant`, нових SSE-подій немає.
 */

/**
 * @typedef {(
 *   | { kind: "insufficient", need: number, have: number }
 *   | { kind: "insufficientFormats", need: number, have: number }
 *   | { kind: "chargedRevision", credits: number, balance: number }
 *   | { kind: "chargedFormats", credits: number, count: number, balance: number }
 *   | { kind: "refunded", credits: number }
 * )} CreditMessage
 */

/** Шаблони uk.ts: ключ i18n → вид повідомлення. */
export const CREDIT_TEMPLATES = /** @type {const} */ ({
  insufficientCredits:
    "Не вистачає кредитів: потрібно {need}, у вас {have}. Поповніть баланс у кабінеті — і я продовжу.",
  insufficientCreditsFormats:
    "Не вистачає кредитів на додаткові формати: потрібно {need}, у вас {have}. Поповніть баланс або лишіть один формат.",
  chargedRevision: "Списано {credits} кредитів за правку. Залишок: {balance}.",
  chargedFormats: "Списано {credits} кредитів за додаткові формати ({count}). Залишок: {balance}.",
  refundedFailure: "Не вдалося завершити ролик — {credits} кредитів повернуто на баланс.",
});

/** @type {Record<keyof typeof CREDIT_TEMPLATES, CreditMessage["kind"]>} */
const KIND = {
  insufficientCredits: "insufficient",
  insufficientCreditsFormats: "insufficientFormats",
  chargedRevision: "chargedRevision",
  chargedFormats: "chargedFormats",
  refundedFailure: "refunded",
};

/**
 * Шаблон → регексп з іменованими групами на місці `{var}` (ціле число, можливо від'ємне).
 * @param {string} template
 */
function compile(template) {
  const parts = template.split(/(\{[a-z]+\})/);
  const src = parts
    .map((p) => {
      const m = /^\{([a-z]+)\}$/.exec(p);
      return m ? `(?<${m[1]}>-?\\d+)` : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${src}$`);
}

const RULES = Object.entries(CREDIT_TEMPLATES).map(([key, template]) => ({
  kind: KIND[/** @type {keyof typeof CREDIT_TEMPLATES} */ (key)],
  re: compile(template),
}));

/**
 * Повідомлення білінгу або `null` для звичайного тексту.
 * @param {string} text
 * @returns {CreditMessage | null}
 */
export function parseCreditMessage(text) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  for (const { kind, re } of RULES) {
    const g = re.exec(value)?.groups;
    if (!g) continue;
    /** @param {string} k */
    const n = (k) => Number(g[k]);
    switch (kind) {
      case "insufficient":
      case "insufficientFormats":
        return { kind, need: n("need"), have: n("have") };
      case "chargedRevision":
        return { kind, credits: n("credits"), balance: n("balance") };
      case "chargedFormats":
        return { kind, credits: n("credits"), count: n("count"), balance: n("balance") };
      case "refunded":
        return { kind, credits: n("credits") };
      default:
        return null;
    }
  }
  return null;
}
