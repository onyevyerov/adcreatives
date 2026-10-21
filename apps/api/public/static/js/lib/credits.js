// @ts-check
/**
 * Крок 0 · K1 — кредити в інтерфейсі: плюралізація, формат чисел, підказки й розрахунки.
 * Валюти в інтерфейсі немає: усі суми — цілі кредити. Плюралізація — лише через ці функції.
 */

/** @typedef {import("../contracts.js").CreditPrices} CreditPrices */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {import("../contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../contracts.js").ProjectCredits} ProjectCredits */

const NBSP = " ";
const MINUS = "−";

/** @type {[string, string, string]} */
const CREDIT_FORMS = ["кредит", "кредити", "кредитів"];

/**
 * Українська множина: 1 (крім 11) · 2–4 (крім 12–14) · решта.
 * @param {number} n
 * @param {[string, string, string]} forms
 * @returns {string}
 */
export function plural(n, forms) {
  const abs = Math.abs(Math.trunc(n));
  const d = abs % 10;
  const dd = abs % 100;
  if (d === 1 && dd !== 11) return forms[0];
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return forms[1];
  return forms[2];
}

/**
 * @param {number} n
 * @returns {"кредит" | "кредити" | "кредитів"}
 */
export function creditWord(n) {
  return /** @type {"кредит" | "кредити" | "кредитів"} */ (plural(n, CREDIT_FORMS));
}

/**
 * Ціле з тисячами через U+00A0; від'ємне — з U+2212: «1 250», «−10».
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  const digits = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return v < 0 ? `${MINUS}${digits}` : digits;
}

/**
 * «1 250 кредитів» (U+00A0 між тисячами і перед словом).
 * @param {number} n
 * @returns {string}
 */
export function formatCredits(n) {
  return `${formatNumber(n)}${NBSP}${creditWord(n)}`;
}

/**
 * Зміна зі знаком: «−10» (U+2212) · «+25» · «0».
 * @param {number} n
 * @returns {string}
 */
export function signed(n) {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  if (v === 0) return "0";
  return v > 0 ? `+${formatNumber(v)}` : formatNumber(v);
}

/** @param {number} n @param {number} price */
const times = (n, price) => (price > 0 ? Math.floor(Math.max(0, n) / price) : 0);

/**
 * На що вистачить `n` кредитів: «1 ролик або 4 правки» · «4 правки, на ролик — ні» ·
 * «ні на ролик, ні на правку» (U+00A0 між числом і словом). Префікс («вистачить на» /
 * «не вистачить») — справа view.
 * @param {number} n
 * @param {CreditPrices} prices
 * @returns {string}
 */
export function enoughFor(n, prices) {
  const videos = times(n, prices.video);
  const revisions = times(n, prices.revision);
  const rev = `${formatNumber(revisions)}${NBSP}${plural(revisions, ["правку", "правки", "правок"])}`;
  if (videos > 0)
    return `${formatNumber(videos)}${NBSP}${plural(videos, ["ролик", "ролики", "роликів"])} або ${rev}`;
  if (revisions > 0) return `${rev}, на ролик — ні`;
  return "ні на ролик, ні на правку";
}

/**
 * Низький баланс: менше половини ціни ролика.
 * @param {number} balance
 * @param {CreditPrices} prices
 */
export function isLow(balance, prices) {
  return balance < prices.video * 0.5;
}

/**
 * Пакет, що закриває нестачу: найменший з `credits ≥ short`, інакше найбільший.
 * @param {CreditPackage[]} packages непорожній список
 * @param {number} short
 * @returns {CreditPackage}
 */
export function closingPackage(packages, short) {
  const bySize = [...packages].sort((a, b) => a.credits - b.credits);
  const pkg = bySize.find((p) => p.credits >= short) ?? bySize.at(-1);
  if (!pkg) throw new Error("closingPackage: порожній список пакетів");
  return pkg;
}

/**
 * Своя сума, що закриває нестачу: не менше мінімуму.
 * @param {number} short
 * @param {{ min: number }} custom
 */
export function customFor(short, custom) {
  return Math.max(short, custom.min);
}

/**
 * Доплата за формати: перший — у ціні ролика, решта — по `prices.extraFormat`, крім уже оплачених.
 * @param {readonly Format[]} formats обрані, у канонічному порядку
 * @param {readonly Format[]} paid оплачені раніше (`paidFormats`)
 * @param {CreditPrices} prices
 * @returns {{ need: number, extra: Format[], paid: Format[] }}
 */
export function extraFormatsCharge(formats, paid, prices) {
  const rest = formats.slice(1);
  const extra = rest.filter((f) => !paid.includes(f));
  return {
    need: extra.length * prices.extraFormat,
    extra,
    paid: rest.filter((f) => paid.includes(f)),
  };
}

/**
 * Формати, за які вже списано (частини `credits.parts` з `kind: "format"`).
 * Приймає рядок проєкту або `UiState.projectCredits`.
 * @param {ProjectRow | ProjectCredits | null | undefined} row
 * @returns {Format[]}
 */
export function paidFormats(row) {
  const credits = row && "parts" in row ? row : (row?.credits ?? null);
  /** @type {Format[]} */
  const out = [];
  for (const part of credits?.parts ?? []) {
    if (part.kind === "format" && part.format && !out.includes(part.format)) out.push(part.format);
  }
  return out;
}
