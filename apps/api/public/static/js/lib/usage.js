// @ts-check
/**
 * Крок 0 вкладки «Використання» · чисті хелпери (заморожено): пресети періоду й параметри запиту.
 * Межі — дні UTC (`YYYY-MM-DD`, обидві включно), як рахує бекенд (`docs/usage-api.md`).
 */

/** @typedef {import("../contracts.js").UsagePreset} UsagePreset */
/** @typedef {import("../contracts.js").UsageRange} UsageRange */
/** @typedef {import("../contracts.js").UsageState} UsageState */
/** @typedef {import("../contracts.js").UsageQuery} UsageQuery */

export const USAGE_PRESETS = /** @type {const} */ (["7d", "30d", "month", "all", "custom"]);
export const USAGE_PAGE_SIZE = 25;
export const USAGE_SEARCH_DEBOUNCE_MS = 300;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` дня UTC. @param {Date} d */
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * Пресет → межі в днях UTC. `7d` / `30d` — останні 7 / 30 днів включно із сьогоднішнім;
 * `month` — з 1-го числа поточного місяця UTC; усі три — до сьогодні включно.
 * `all` / `custom` → `{ from: null, to: null }`.
 * @param {UsagePreset} preset
 * @param {Date} now
 * @returns {UsageRange}
 */
export function presetRange(preset, now) {
  const to = isoDay(now);
  switch (preset) {
    case "7d":
      return { from: isoDay(new Date(now.getTime() - 6 * DAY_MS)), to };
    case "30d":
      return { from: isoDay(new Date(now.getTime() - 29 * DAY_MS)), to };
    case "month":
      return { from: `${to.slice(0, 7)}-01`, to };
    default:
      return { from: null, to: null };
  }
}

/**
 * Стан вкладки → параметри запиту без порожніх значень; `source=chat` не передається — це дефолт.
 * @param {Pick<UsageState, "range" | "source">} state
 * @returns {UsageQuery}
 */
export function usageQuery(state) {
  /** @type {UsageQuery} */
  const q = {};
  if (state.range.from) q.from = state.range.from;
  if (state.range.to) q.to = state.range.to;
  if (state.source !== "chat") q.source = state.source;
  return q;
}
