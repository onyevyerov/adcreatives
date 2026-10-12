// @ts-check
/**
 * Позиція плейхеда таймлайну (C3) і машинний час — чисті функції без DOM (B3).
 *
 * pct = (сума ваг попередніх сегментів + вага поточного × частка) / Σваг × 100.
 *
 * Частка за статусом:
 * - intake — 0; crawling — done/total з `progress` (0, якщо невідомо);
 * - brandkit / scripting / directing — done/total × 0.92 (0.5, якщо невідомо);
 * - awaiting_* — 1 (плейхед на ромбі чекпоінта);
 * - rendering — (індекс формату + done/total) / кількість форматів (див. `renderFraction`);
 * - delivered — 100%;
 * - revising / failed — плейхед лишається на останній позиції: рахується як для `prevStatus`
 *   (revising після delivered → 100%, після awaiting_X → на ромбі X; failed після directing →
 *   позиція directing). Якщо `prevStatus` невідомий або сам revising/failed — найдальша точка,
 *   яку видно зі стану: є відео → delivered, інакше останній отриманий чекпоінт, інакше intake.
 *   `progress` після state-події скинуто, тож для busy-статусу без прогресу частка — «невідома».
 */
import { AWAITING, BUSY, FORMAT_LABELS, FORMATS, SEGMENTS } from "../contracts.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {import("../contracts.js").SegmentKey} SegmentKey */
/** @typedef {import("../contracts.js").Checkpoint} Checkpoint */

/**
 * Ромб чекпоінта: `open` — ще не досягнуто, `ring` — зараз чекаємо рішення клієнта (пульсує),
 * `done` — пройдено.
 * @typedef {{ key: SegmentKey, checkpoint: Checkpoint, pct: number, state: "open" | "ring" | "done" }} TimelineDiamond
 */
/**
 * Підпис сегмента: `done` — «✓», `active` — номер кольором --accent, `todo` — приглушений.
 * @typedef {{ key: SegmentKey, label: string, num: string, weight: number, state: "done" | "active" | "todo" }} TimelineLabel
 */
/**
 * @typedef {{
 *   segIndex: number,
 *   fraction: number,
 *   pct: number,
 *   diamonds: TimelineDiamond[],
 *   labels: TimelineLabel[]
 * }} TimelinePosition
 */

/** Сума ваг сегментів (6.7). */
export const TOTAL_WEIGHT = SEGMENTS.reduce((acc, s) => acc + s.weight, 0);

/** Частка busy-сегмента, поки робота не закінчилась: ромб займає лише чекпоінт. */
const BUSY_CAP = 0.92;
/** Частка busy-сегмента без done/total. */
const BUSY_UNKNOWN = 0.5;

/** Сегмент таймлайну для «позиційного» статусу. @type {Partial<Record<ProjectStatus, number>>} */
const SEGMENT_OF = {
  intake: 0,
  crawling: 0,
  brandkit: 1,
  awaiting_brand: 1,
  scripting: 2,
  awaiting_script: 2,
  directing: 3,
  awaiting_storyboard: 3,
  rendering: 4,
  delivered: 5,
};

/** @param {number} n */
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * done/total з прогресу або `null`, якщо невідомо.
 * @param {UiState["progress"]} progress
 * @returns {number | null}
 */
function ratio(progress) {
  if (!progress || progress.done === null || progress.total === null || !(progress.total > 0)) return null;
  return clamp01(progress.done / progress.total);
}

/**
 * Позиції підписів форматів у тексті (`9:16`, `1:1`, `16:9`), у порядку появи.
 * @param {string} label
 * @returns {string[]}
 */
function formatLabelsIn(label) {
  /** @type {{ at: number, label: string }[]} */
  const found = [];
  for (const f of FORMATS) {
    const fl = FORMAT_LABELS[f];
    const m = new RegExp(`(?<![\\d:])${fl}(?![\\d:])`).exec(label);
    if (m) found.push({ at: m.index, label: fl });
  }
  return found.sort((a, b) => a.at - b.at).map((x) => x.label);
}

/**
 * Список форматів поточного рендеру (підписи `9:16`…), у порядку рендеру. Джерела за пріоритетом:
 * 1. мітка `renderStarted` у `stageLog`/`progress` — «Рендерю відео (9:16, 1:1)…» (саме те, що рендериться);
 * 2. `ui.pendingFormats`; 3. `formats` з payload чекпоінта бренду (у канонічному порядку `FORMATS`),
 *    доповнені форматами з міток «Рендерю X… N%», яких у списку немає (клієнт змінив формати в чаті);
 * 4. порожньо (= один формат).
 * @param {UiState} state
 * @returns {string[]}
 */
export function renderFormats(state) {
  const labels = [...(state.stageLog ?? []).map((e) => e.label), state.progress?.label ?? ""];
  for (const label of labels) {
    const found = formatLabelsIn(label);
    if (found.length > 1 || (found.length === 1 && label.includes("("))) return found;
  }
  const brand = state.checkpoints?.brand?.payload;
  const chosen = state.ui?.pendingFormats ?? (brand?.checkpoint === "brand" ? brand.formats : null) ?? [];
  const out = FORMATS.filter((f) => chosen.includes(f)).map((f) => FORMAT_LABELS[f]);
  for (const label of labels) for (const fl of formatLabelsIn(label)) if (!out.includes(fl)) out.push(fl);
  return out;
}

/**
 * Частка сегмента «Рендер»: (індекс формату + done/total) / кількість форматів. Індекс — позиція
 * підпису формату з мітки прогресу («Рендерю 9:16… 50%») у списку `renderFormats`; якщо мітка
 * формату не містить — 0.
 * @param {UiState} state
 * @returns {number}
 */
export function renderFraction(state) {
  const formats = renderFormats(state);
  const count = Math.max(1, formats.length);
  const current = formatLabelsIn(state.progress?.label ?? "");
  // «Рендерю відео (9:16, 1:1)…» називає всі формати одразу — це старт, а не конкретний формат.
  const index = current.length === 1 ? Math.max(0, formats.indexOf(/** @type {string} */ (current[0]))) : 0;
  return clamp01(
    (Math.min(index, count - 1) + (current.length > 1 ? 0 : (ratio(state.progress) ?? 0))) / count,
  );
}

/** @type {Partial<Record<ProjectStatus, Checkpoint>>} */
const CHECKPOINT_OF = {
  awaiting_brand: "brand",
  awaiting_script: "script",
  awaiting_storyboard: "storyboard",
};

/**
 * Статус, за яким рахується позиція: для revising/failed — попередній (див. шапку модуля).
 * @param {UiState} state
 * @returns {ProjectStatus}
 */
export function positionStatus(state) {
  const { status, prevStatus } = state;
  if (status !== "revising" && status !== "failed") return status;
  if (prevStatus && prevStatus !== "revising" && prevStatus !== "failed") return prevStatus;
  if ((state.artifacts?.videos ?? []).length > 0) return "delivered";
  const cps = state.checkpoints ?? {};
  if (cps.storyboard) return "awaiting_storyboard";
  if (cps.script) return "awaiting_script";
  if (cps.brand) return "awaiting_brand";
  return "intake";
}

/**
 * Частка поточного сегмента для «позиційного» статусу.
 * @param {ProjectStatus} status
 * @param {UiState} state
 * @param {boolean} live статус справжній (не відновлений з prevStatus) — лише тоді `progress` його
 * @returns {number}
 */
function fractionOf(status, state, live) {
  const progress = live ? state.progress : null;
  switch (status) {
    case "crawling":
      return ratio(progress) ?? 0;
    case "brandkit":
    case "scripting":
    case "directing": {
      const r = ratio(progress);
      return r === null ? BUSY_UNKNOWN : r * BUSY_CAP;
    }
    case "rendering":
      return live ? renderFraction(state) : 0;
    case "delivered":
      return 1;
    default:
      return AWAITING.includes(status) ? 1 : 0;
  }
}

/**
 * Позиція плейхеда, ромби й підписи сегментів (C3). Числа — точні (без округлення).
 * @param {UiState} state
 * @returns {TimelinePosition}
 */
export function timelinePosition(state) {
  const status = positionStatus(state);
  const live = status === state.status;
  const segIndex = SEGMENT_OF[status] ?? 0;
  const fraction = clamp01(fractionOf(status, state, live));
  const before = SEGMENTS.slice(0, segIndex).reduce((acc, s) => acc + s.weight, 0);
  const seg = SEGMENTS[segIndex];
  const pct = status === "delivered" ? 100 : ((before + (seg?.weight ?? 0) * fraction) / TOTAL_WEIGHT) * 100;
  const complete = status === "delivered";
  const awaitingNow = state.status === status ? CHECKPOINT_OF[status] : undefined;

  /** @type {TimelineDiamond[]} */
  const diamonds = [];
  /** @type {TimelineLabel[]} */
  const labels = [];
  let acc = 0;
  SEGMENTS.forEach((s, i) => {
    acc += s.weight;
    const reachedEnd = complete || i < segIndex || (i === segIndex && fraction >= 1);
    if (s.checkpoint) {
      /** @type {TimelineDiamond["state"]} */
      let dState = "open";
      if (awaitingNow === s.checkpoint) dState = "ring";
      else if (reachedEnd && !(i === segIndex && CHECKPOINT_OF[status] === s.checkpoint)) dState = "done";
      diamonds.push({ key: s.key, checkpoint: s.checkpoint, pct: (acc / TOTAL_WEIGHT) * 100, state: dState });
    }
    labels.push({
      key: s.key,
      label: s.label,
      num: String(i + 1).padStart(2, "0"),
      weight: s.weight,
      state: complete || i < segIndex ? "done" : i === segIndex ? "active" : "todo",
    });
  });

  return { segIndex, fraction, pct, diamonds, labels };
}

/**
 * Машинний час: сума busy-інтервалів + поточний інтервал, якщо статус busy.
 * @param {Pick<UiState, "status" | "busyMs" | "busySince">} state
 * @param {number} [now]
 * @returns {number}
 */
export function machineMs(state, now = Date.now()) {
  let ms = state.busyMs || 0;
  if (BUSY.includes(state.status) && state.busySince) {
    const since = Date.parse(state.busySince);
    if (Number.isFinite(since)) ms += Math.max(0, now - since);
  }
  return Math.max(0, ms);
}

/**
 * `mm:ss` (хвилини не обрізаються на 60: 75 хв → «75:00»).
 * @param {number} ms
 * @returns {string}
 */
export function formatMachineTime(ms) {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
