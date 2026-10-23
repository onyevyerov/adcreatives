// @ts-check
/**
 * B5 · Сцена: робочі стани (X5, X6, робочі стани прототипу).
 *
 * Шапка — eyebrow «0N — Сегмент» (сегмент таймлайну C3) і заголовок `display-l` з пульсуючою
 * крапкою `--accent`. Тіло — за статусом:
 * - intake — хост і рядок «готую сканування»;
 * - crawling (X5) — хост `display-m` замість заголовка, `numeral` done/total, смуга, мітка,
 *   під ними чекліст підкроків;
 * - brandkit / scripting — чекліст підкроків `STAGE_STEPS[status]`;
 * - directing — дві гілки «Сцени» і «Музика» з чеклістом кожної, під ними спільні кроки
 *   (звук, рецензія);
 * - rendering — `numeral` відсоток, смуга, «9:16 · 1080×1920 · h264 · формат N з M», чекліст
 *   форматів;
 * - revising — «Вношу правки» + цитата останнього повідомлення клієнта + чекліст «Розбираю
 *   правку» і кроків, що реально прийшли.
 *
 * Чекліст (ТЗ chat-interface-fixes, B6): ✓ виконані, спінер на поточному (+ done/total), сірі
 * майбутні; `optional` — лише якщо почались. Крок події — `step`, інакше перший крок, у якого
 * `stages` містить `stage` (старі події). Крок, на який перестрибнули, — ✓ без часу. Тривалість
 * кроку — різниця `at` подій, що його почали й закінчили; у стрічці редьюсер зливає рядки одного
 * stage, тож ці моменти чекліст бачить лише наживо (після перезавантаження — ✓ без часу).
 *
 * Тіло перебудовується лише при зміні статусу; лічильники, смуги й мітки патчаться на місці.
 */
import { FORMAT_LABELS, FORMATS, SEGMENTS, STAGE_STEPS, STATUS_LABELS } from "../contracts.js";
import { h, lines, text } from "../dom.js";
import { renderFormats, timelinePosition } from "../lib/timeline.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").FeedItem} FeedItem */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {Extract<FeedItem, { kind: "progress" }>} ProgressItem */
/** Тіло робочого стану: вузол і патч. @typedef {{ el: HTMLElement, update(state: UiState): void }} Body */

/** Заголовки робочих станів (display-l). @type {Partial<Record<ProjectStatus, string>>} */
const TITLES = {
  intake: "Приймаю проєкт",
  brandkit: "Збираю бренд-кіт",
  scripting: "Пишу сценарій",
  directing: "Генерую сцени і музику",
  rendering: "Рендерю відео",
  revising: "Вношу правки",
};

/** Стадії гілки «Сцени» в directing (X6); `author` — агентний режим (ADC_GENERATION_MODE=agent). */
export const SCENE_STAGES = ["codegen", "author", "check", "fix", "qa"];
/** Стадія гілки «Музика». */
export const MUSIC_STAGE = "audio";

/**
 * Розмір кадру за форматом (= `FORMAT_SIZE` у packages/shared/src/schemas/common.ts) і кодек
 * рендеру (packages/render/src/engine.ts: `codec: "h264"`).
 * @type {Record<Format, string>}
 */
export const FORMAT_SIZES = { vertical: "1080×1920", square: "1080×1080", landscape: "1920×1080" };
const CODEC = "h264";

/** Бюджет часу краулера (packages/crawler/src/crawl.ts: `timeBudgetMs: 120_000`). */
const CRAWL_LIMIT_S = 120;

/** @param {string} s */
const capitalize = (s) => s.charAt(0).toLocaleUpperCase("uk") + s.slice(1);

/** @param {number} n */
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * done/total або `null`, якщо невідомо.
 * @param {{ done: number | null, total: number | null } | null | undefined} p
 * @returns {number | null}
 */
export function ratioOf(p) {
  if (!p || p.done === null || p.total === null || !(p.total > 0)) return null;
  return clamp01(p.done / p.total);
}

/**
 * «0N — Сегмент» для поточного стану (той самий сегмент, що активний на таймлайні).
 * @param {UiState} state
 */
export function eyebrowFor(state) {
  const i = timelinePosition(state).segIndex;
  return `${String(i + 1).padStart(2, "0")} — ${SEGMENTS[i]?.label ?? ""}`;
}

/**
 * Рядки progress поточного busy-стану (у порядку стрічки). Межа — `busySince` (початок busy-
 * відрізка за `at` state-події); без нього — останній чекпоінт або помилка в стрічці (між двома
 * заходами в directing завжди є одне з них).
 * @param {UiState} state
 * @returns {ProgressItem[]}
 */
export function currentProgressItems(state) {
  const since = state.busySince ? Date.parse(state.busySince) : Number.NaN;
  /** @type {ProgressItem[]} */
  const out = [];
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const item = state.feed[i];
    if (!item) continue;
    if (item.kind === "checkpoint" || item.kind === "error") break;
    if (item.kind !== "progress") continue;
    if (Number.isFinite(since) && Date.parse(item.at) < since) break;
    out.unshift(item);
  }
  return out;
}

/**
 * Стан гілки directing.
 * @typedef {{
 *   state: "pending" | "running" | "done" | "kept",
 *   label: string,
 *   done: number | null,
 *   total: number | null,
 *   ratio: number | null
 * }} Branch
 */

/**
 * Дві гілки directing. Рядки progress у стрічці чергуються (codegen → audio → codegen…): редьюсер
 * закриває рядок при зміні stage, тож останній рядок кожної гілки — її поточний стан, а
 * `state.progress` описує лише ту гілку, що прозвітувала останньою.
 * - «Сцени»: останній рядок зі stage ∈ codegen/check/fix/qa — мітка й done/total; смуга — done/total
 *   цього рядка (без лічильника — останній відомий у гілці).
 * - «Музика»: «готово», коли останній рядок audio має done = total або прийшов artifact music (і
 *   audio зараз не пишеться заново); у ревізії без audio, якщо музика вже є в чекпоінті 3, — «без змін».
 * @param {UiState} state
 * @returns {{ scenes: Branch, music: Branch }}
 */
export function directingBranches(state) {
  const items = currentProgressItems(state);
  const sceneItems = items.filter((i) => SCENE_STAGES.includes(i.stage));
  const musicItems = items.filter((i) => i.stage === MUSIC_STAGE);

  const lastScene = sceneItems.at(-1);
  const knownScene = [...sceneItems].reverse().find((i) => ratioOf(i) !== null);
  /** @type {Branch} */
  const scenes = lastScene
    ? {
        state: "running",
        label: lastScene.label,
        done: lastScene.done,
        total: lastScene.total,
        ratio: ratioOf(lastScene) ?? ratioOf(knownScene),
      }
    : { state: "pending", label: "Чекаю на старт…", done: null, total: null, ratio: null };

  const lastMusic = musicItems.at(-1);
  const musicDone = Boolean(lastMusic && lastMusic.total !== null && lastMusic.done === lastMusic.total);
  const musicRunning = Boolean(lastMusic && !musicDone);
  const sbPayload = state.checkpoints.storyboard?.payload;
  const keptMusic = sbPayload?.checkpoint === "storyboard" ? sbPayload.music : null;
  /** @type {Branch} */
  let music;
  if (musicDone || (!musicRunning && state.artifacts.music)) {
    music = { state: "done", label: lastMusic?.label ?? "Музику записано", done: 1, total: 1, ratio: 1 };
  } else if (lastMusic) {
    music = {
      state: "running",
      label: lastMusic.label,
      done: lastMusic.done,
      total: lastMusic.total,
      ratio: ratioOf(lastMusic),
    };
  } else if (keptMusic && state.prevStatus === "revising") {
    music = { state: "kept", label: "Музика з попередньої ревізії", done: null, total: null, ratio: 1 };
  } else {
    music = { state: "pending", label: "Чекаю на старт…", done: null, total: null, ratio: null };
  }
  return { scenes, music };
}

/**
 * Формати поточного рендеру, у порядку рендеру.
 *
 * Джерело — `renderFormats` з lib/timeline.js (той самий список, що рахує плейхед): мітка старту
 * рендеру «Рендерю відео (9:16, 1:1)…» = `project.formats` бекенду, далі — `ui.pendingFormats` і
 * формати з чекпоінта бренду. Чекпоінт бренду знає лише формати на момент чекпоінта (клієнт
 * міняє їх повідомленням «Формати: …»), тож, якщо мітки старту немає (перепідключення посеред
 * рендеру), довіряємо довшому зі списків: цей або чекпоінт 3 — `primaryFormat` + формати
 * аркушів `sheets` (бекенд робить аркуш на кожен неосновний формат проєкту).
 * @param {UiState} state
 * @returns {Format[]}
 */
export function renderFormatList(state) {
  const byLabel = /** @type {Record<string, Format>} */ (
    Object.fromEntries(FORMATS.map((f) => [FORMAT_LABELS[f], f]))
  );
  /** @type {Format[]} */
  const fromTimeline = [];
  for (const label of renderFormats(state)) {
    const f = byLabel[label];
    if (f && !fromTimeline.includes(f)) fromTimeline.push(f);
  }
  const sb = state.checkpoints.storyboard?.payload;
  /** @type {Format[]} */
  const fromBoard = [];
  if (sb?.checkpoint === "storyboard") {
    for (const f of [sb.primaryFormat, ...sb.sheets.map((s) => s.format)])
      if (!fromBoard.includes(f)) fromBoard.push(f);
  }
  const list = fromBoard.length > fromTimeline.length ? fromBoard : fromTimeline;
  return list.length > 0 ? list : ["vertical"];
}

/**
 * Поточний формат рендеру: підпис формату в мітці «Рендерю 9:16… 50%»; мітка старту («Рендерю
 * відео (9:16, 1:1)…») або її відсутність — перший формат.
 * @param {UiState} state
 * @returns {{ format: Format, index: number, count: number, percent: number }}
 */
export function renderInfo(state) {
  const formats = renderFormatList(state);
  const label = state.progress?.label ?? "";
  const named = formats.filter((f) => new RegExp(`(?<![\\d:])${FORMAT_LABELS[f]}(?![\\d:])`).test(label));
  const format = named.length === 1 && named[0] ? named[0] : (formats[0] ?? "vertical");
  const index = Math.max(0, formats.indexOf(format));
  const r = named.length === 1 ? ratioOf(state.progress) : null;
  return { format, index, count: formats.length, percent: Math.round((r ?? 0) * 100) };
}

/**
 * Останнє повідомлення клієнта у стрічці.
 * @param {UiState} state
 * @returns {string | null}
 */
export function lastClientMessage(state) {
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const item = state.feed[i];
    if (item?.kind === "message" && item.role === "user") return item.text;
  }
  return null;
}

// ───────────── Чекліст підкроків ─────────────

/** @typedef {(typeof STAGE_STEPS)["directing"][number]} StageStep */

/**
 * Рядок чекліста. `implicit` — активний без жодної події (стадія щойно почалась): спінер є, але
 * старт кроку ще не відомий. `note` — підпис праворуч у виконаного кроку замість тривалості.
 * @typedef {{
 *   key: string,
 *   label: string,
 *   state: "done" | "active" | "pending",
 *   implicit?: boolean,
 *   count?: string,
 *   note?: string
 * }} StepRow
 */

/** Ревізія: власного списку в `STAGE_STEPS` немає, перший крок — розбір правки (stage `revise`). */
export const REVISE_STEP = { id: "revise", label: "Розбираю правку", stages: ["revise"] };

/** Усі кроки всіх стадій (id унікальні між стадіями) — для ревізії, де стадії довільні. */
const ALL_STEPS = /** @type {readonly { id: string, label: string, stages: readonly string[] }[]} */ ([
  REVISE_STEP,
  ...Object.values(STAGE_STEPS).flat(),
]);

/**
 * Крок події в переліку: `step`, якщо він там є, інакше — перший крок, у якого `stages` містить
 * `stage` (старі події без `step`).
 * @template {{ id: string, stages: readonly string[] }} S
 * @param {readonly S[]} steps
 * @param {{ stage: string, step?: string }} item
 * @returns {S | null}
 */
export function stepOf(steps, item) {
  const byId = item.step ? steps.find((s) => s.id === item.step) : undefined;
  return byId ?? steps.find((s) => s.stages.includes(item.stage)) ?? null;
}

/**
 * Кроки, що вже почались у поточному busy-стані. Рядки стрічки одного stage злиті (кожен знає
 * лише останній `step`), тож доповнюємо кроками, які чекліст бачив активними наживо (`seen`).
 * @param {readonly StageStep[]} steps
 * @param {UiState} state
 * @param {Iterable<string>} seen
 * @returns {Set<string>}
 */
export function visitedSteps(steps, state, seen) {
  const out = new Set(seen);
  for (const item of currentProgressItems(state)) {
    const s = stepOf(steps, item);
    if (s) out.add(s.id);
  }
  return out;
}

/**
 * Останній рядок стрічки поточного busy-стану, чий крок є в `steps`.
 * @param {readonly StageStep[]} steps
 * @param {ProgressItem[]} items
 * @returns {{ step: StageStep, item: ProgressItem } | null}
 */
function lastStep(steps, items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const step = item ? stepOf(steps, item) : null;
    if (item && step) return { step, item };
  }
  return null;
}

/** @param {{ done: number | null, total: number | null }} p */
const countOf = (p) => (p.done !== null && p.total !== null ? `${p.done}/${p.total}` : "");

/**
 * Лінійний чекліст: до поточного — ✓, поточний — спінер, далі — сірі (крок після поточного, що
 * вже був, — ✓: повторна перевірка після виправлення). Без поточного перший крок — неявно
 * активний (`implicitFirst`); `allDone` — гілку закінчено.
 * @param {readonly StageStep[]} steps
 * @param {{ step: StageStep, item: ProgressItem } | null} current
 * @param {Set<string>} visited
 * @param {{ implicitFirst?: boolean, allDone?: boolean }} [opts]
 * @returns {StepRow[]}
 */
function linearRows(steps, current, visited, { implicitFirst = true, allDone = false } = {}) {
  const cur = current ? steps.indexOf(current.step) : -1;
  /** @type {StepRow[]} */
  const rows = [];
  steps.forEach((s, i) => {
    if (s.optional && i !== cur && !visited.has(s.id)) return;
    /** @type {StepRow["state"]} */
    let state = "pending";
    if (allDone || i < cur) state = "done";
    else if (i === cur) state = "active";
    else if (cur >= 0 && visited.has(s.id)) state = "done";
    rows.push({
      key: s.id,
      label: s.label,
      state,
      ...(i === cur && current ? { count: countOf(current.item) } : {}),
    });
  });
  const first = rows[0];
  if (cur < 0 && !allDone && implicitFirst && first) rows[0] = { ...first, state: "active", implicit: true };
  return rows;
}

/**
 * Чекліст лінійної стадії (crawling / brandkit / scripting).
 * @param {readonly StageStep[]} steps
 * @param {UiState} state
 * @param {Iterable<string>} [seen] кроки, які чекліст бачив активними
 * @returns {StepRow[]}
 */
export function stageRows(steps, state, seen = []) {
  return linearRows(steps, lastStep(steps, currentProgressItems(state)), visitedSteps(steps, state, seen));
}

/**
 * Чекліст directing: гілки «Сцени» і «Музика» за `branch`, спільні кроки (звук, рецензія) — без
 * гілки. Коли почався спільний крок, обидві гілки закінчено. Музика — за `directingBranches`
 * (готово й за artifact music; «без змін» — у ревізії без audio).
 * @param {UiState} state
 * @param {Iterable<string>} [seen]
 * @returns {{ scenes: StepRow[], music: StepRow[], shared: StepRow[] }}
 */
export function directingRows(state, seen = []) {
  const all = STAGE_STEPS.directing;
  const scenesSteps = all.filter((s) => s.branch === "scenes");
  const musicSteps = all.filter((s) => s.branch === "music");
  const sharedSteps = all.filter((s) => !s.branch);
  // Крок — за всім переліком directing (не за гілкою), щоб чужий `step` не впав у гілку за stage.
  const resolved = currentProgressItems(state).flatMap((item) => {
    const step = stepOf(all, item);
    return step ? [{ step, item }] : [];
  });
  const visited = visitedSteps(all, state, seen);
  /** Останній рядок, чий крок належить `steps`. @param {readonly StageStep[]} steps */
  const lastIn = (steps) => [...resolved].reverse().find((r) => steps.includes(r.step)) ?? null;
  const shared = lastIn(sharedSteps);
  const finished = shared !== null;

  const music = directingBranches(state).music;
  const musicStep = musicSteps[0];
  /** @type {StepRow[]} */
  const musicRows = musicStep
    ? [
        {
          key: musicStep.id,
          label: musicStep.label,
          state:
            finished || music.state === "done" || music.state === "kept"
              ? "done"
              : music.state === "running"
                ? "active"
                : "pending",
          ...(music.state === "running" ? { count: countOf(music) } : {}),
          ...(music.state === "kept" ? { note: "без змін" } : {}),
        },
      ]
    : [];

  return {
    scenes: linearRows(scenesSteps, lastIn(scenesSteps), visited, { allDone: finished }),
    music: musicRows,
    shared: linearRows(sharedSteps, shared, visited, { implicitFirst: false }),
  };
}

/**
 * Чекліст рендеру: рядок на кожен формат (`renderFormatList`), поточний — з відсотком; формат,
 * що дійшов до 100%, — ✓.
 * @param {UiState} state
 * @returns {StepRow[]}
 */
export function renderRows(state) {
  const info = renderInfo(state);
  return renderFormatList(state).map((f, i) => {
    const done = i < info.index || (i === info.index && info.percent >= 100);
    /** @type {StepRow["state"]} */
    const st = done ? "done" : i === info.index ? "active" : "pending";
    return {
      key: `render:${f}`,
      label: `${FORMAT_LABELS[f]} · ${FORMAT_SIZES[f]}`,
      state: st,
      ...(st === "active" ? { count: `${info.percent}%` } : {}),
      ...(st === "active" && !state.progress ? { implicit: true } : {}),
    };
  });
}

/**
 * Чекліст ревізії — динамічний: «Розбираю правку» (stage `revise`) і кроки тих стадій, що реально
 * прийшли, у порядку появи; останній — поточний.
 * @param {UiState} state
 * @param {readonly string[]} [seen] кроки, які чекліст бачив активними, у порядку появи
 * @returns {StepRow[]}
 */
export function revisingRows(state, seen = []) {
  const items = currentProgressItems(state);
  /** @type {{ id: string, label: string, item: ProgressItem }[]} */
  const arrived = [];
  for (const item of items) {
    const s = stepOf(ALL_STEPS, item);
    if (s) arrived.push({ id: s.id, label: s.label, item });
  }
  const current = arrived.at(-1);
  if (!current) return [{ key: REVISE_STEP.id, label: REVISE_STEP.label, state: "active", implicit: true }];
  // Злиті рядки стрічки гублять проміжні кроки — їх доповнює `seen` (спостереження наживо, у
  // порядку появи); кроки зі стрічки, яких чекліст не бачив, були до монтування — вони першими.
  // Поточний — завжди останній.
  /** @type {string[]} */
  const order = [];
  for (const id of [...arrived.map((a) => a.id).filter((id) => !seen.includes(id)), ...seen])
    if (id !== current.id && !order.includes(id)) order.push(id);
  order.push(current.id);
  return order.map((id) => {
    const step = ALL_STEPS.find((s) => s.id === id);
    const active = id === current.id;
    return {
      key: id,
      label: step?.label ?? id,
      state: active ? "active" : "done",
      ...(active ? { count: countOf(current.item) } : {}),
    };
  });
}

/**
 * «12 с», «1 хв 05 с».
 * @param {number} ms
 */
export function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, "0")} с`;
}

/**
 * Час останньої події progress поточного busy-стану (мс) або `null`.
 * @param {UiState} state
 */
function latestProgressAt(state) {
  const times = currentProgressItems(state)
    .map((i) => Date.parse(i.at))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

// ───────────── Будівельні блоки ─────────────

/**
 * Смуга прогресу (`.bar`); `null` — невідомо (біжить смужка).
 * @param {string} [cls]
 */
function makeBar(cls = "") {
  const fill = h("div", { class: "bar__fill" });
  const bar = h(
    "div",
    { class: `bar sp-bar ${cls}`.trim(), role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" },
    fill,
  );
  /** @param {number | null} value */
  const set = (value) => {
    const unknown = value === null;
    bar.classList.toggle("sp-bar--unknown", unknown);
    const v = unknown ? "" : String(clamp01(value));
    if (bar.style.getPropertyValue("--bar-value") !== v) {
      if (unknown) bar.style.removeProperty("--bar-value");
      else bar.style.setProperty("--bar-value", v);
    }
    if (unknown) bar.removeAttribute("aria-valuenow");
    else bar.setAttribute("aria-valuenow", String(Math.round(clamp01(value) * 100)));
  };
  return { el: bar, set };
}

/**
 * `numeral` з одиницею (`7/25`, `50%`).
 */
function makeNumeral() {
  const value = document.createTextNode("");
  const unit = h("span", { class: "numeral__unit" });
  const el = h("div", { class: "numeral sp-numeral" }, value, unit);
  /** @param {string} v @param {string} u */
  const set = (v, u) => {
    text(value, v);
    text(unit, u);
    unit.hidden = !u;
  };
  return { el, set };
}

/**
 * Список міток `stageLog`: попередні з ✓, остання зі спінером (+ done/total, якщо є).
 * Рядки патчаться за індексом: нова мітка додає рядок, попередній стає «✓».
 * @param {string} placeholder мітка, поки progress ще не приходив
 */
function makeLog(placeholder) {
  const list = h("ol", { class: "sp-log", "aria-live": "polite" });
  /** @type {{ li: HTMLLIElement, mark: HTMLSpanElement, label: HTMLSpanElement, count: HTMLSpanElement, key: string }[]} */
  const rows = [];

  /** @param {string} key */
  const makeRow = (key) => {
    const mark = h("span", { class: "sp-log__mark", "aria-hidden": "true" });
    const label = h("span", { class: "sp-log__label" });
    const count = h("span", { class: "sp-log__count mono" });
    const li = h("li", { class: "sp-log__row" }, mark, label, count);
    return { li, mark, label, count, key };
  };

  /** @param {UiState} state */
  const update = (state) => {
    const entries = state.stageLog.length > 0 ? state.stageLog.map((e) => e.label) : [placeholder];
    entries.forEach((label, i) => {
      const key = `${i}:${label}`;
      let row = rows[i];
      if (!row || row.key !== key) {
        const fresh = makeRow(key);
        if (row) row.li.replaceWith(fresh.li);
        else list.append(fresh.li);
        rows[i] = fresh;
        row = fresh;
      }
      const last = i === entries.length - 1;
      const kind = last ? "active" : "done";
      if (row.li.dataset.state !== kind) {
        row.li.dataset.state = kind;
        row.mark.className = last ? "sp-log__mark spinner" : "sp-log__mark";
        text(row.mark, last ? "" : "✓");
      }
      text(row.label, label);
      const p = state.progress;
      const showCount = last && state.stageLog.length > 0 && p && p.done !== null && p.total !== null;
      text(row.count, showCount && p ? `${p.done}/${p.total}` : "");
    });
    while (rows.length > entries.length) rows.pop()?.li.remove();
  };
  return { el: list, update };
}

/**
 * Чекліст кроків (`StepRow`): ✓ виконані з тривалістю, спінер на поточному з лічильником, сірі
 * майбутні. Рядки — за ключем, вузли патчаться на місці.
 *
 * Тривалість = `at` події, з якою крок став виконаним, мінус `at` події, з якою він став активним.
 * Обидва моменти чекліст ловить сам між оновленнями (перше оновлення — лише точка відліку), тож
 * крок, на який перестрибнули або який почався до монтування, — ✓ без часу.
 * @param {string} [cls]
 */
function makeChecklist(cls = "") {
  const list = h("ol", { class: `sp-steps ${cls}`.trim(), "aria-live": "polite" });
  /** @type {Map<string, { li: HTMLLIElement, mark: HTMLSpanElement, label: HTMLSpanElement, meta: HTMLSpanElement }>} */
  const nodes = new Map();
  /** Стан рядка на попередньому оновленні; неявний активний рахується як pending. */
  /** @type {Map<string, StepRow["state"]>} */
  const was = new Map();
  /** @type {Map<string, number>} */
  const startAt = new Map();
  /** @type {Map<string, number>} */
  const endAt = new Map();
  /** Ключі, що бували активними (не неявно), у порядку появи. @type {Set<string>} */
  const seen = new Set();
  let primed = false;

  /** @param {StepRow[]} rows @param {number | null} now час останньої події progress */
  const update = (rows, now) => {
    const keys = new Set(rows.map((r) => r.key));
    for (const [key, node] of nodes) {
      if (keys.has(key)) continue;
      node.li.remove();
      nodes.delete(key);
    }
    rows.forEach((row, i) => {
      let node = nodes.get(row.key);
      if (!node) {
        const mark = h("span", { class: "sp-step__mark", "aria-hidden": "true" });
        const label = h("span", { class: "sp-step__label" });
        const meta = h("span", { class: "sp-step__meta mono" });
        node = {
          li: h("li", { class: "sp-step", "data-step": row.key }, mark, label, meta),
          mark,
          label,
          meta,
        };
        nodes.set(row.key, node);
      }
      if (list.children[i] !== node.li) list.insertBefore(node.li, list.children[i] ?? null);

      const real = row.implicit ? "pending" : row.state;
      const before = was.get(row.key) ?? "pending";
      if (primed && now !== null && real !== before) {
        if (real === "active" && !startAt.has(row.key)) startAt.set(row.key, now);
        if (real === "done" && before === "active" && !endAt.has(row.key)) endAt.set(row.key, now);
      }
      was.set(row.key, real);
      if (real === "active") seen.add(row.key);

      if (node.li.dataset.state !== row.state) {
        node.li.dataset.state = row.state;
        node.mark.className = row.state === "active" ? "sp-step__mark spinner" : "sp-step__mark";
        text(node.mark, row.state === "done" ? "✓" : "");
      }
      text(node.label, row.label);
      const start = startAt.get(row.key);
      const end = endAt.get(row.key);
      /** @type {string} */
      let meta = "";
      if (row.state === "active") meta = row.count ?? "";
      else if (row.state === "done")
        meta = start !== undefined && end !== undefined ? formatDuration(end - start) : (row.note ?? "");
      text(node.meta, meta);
    });
    primed = true;
  };
  return { el: list, update, seen: () => [...seen] };
}

// ───────────── Тіла станів ─────────────

/** @returns {Body} */
function intakeBody() {
  const host = h("div", { class: "display-m sp-host" });
  const log = makeLog("Готую сканування сайту…");
  const el = h("div", { class: "sp-body" }, host, log.el);
  return {
    el,
    update(state) {
      text(host, state.site ?? "");
      host.hidden = !state.site;
      log.update(state);
    },
  };
}

/** X5: лічильник done/total, смуга, мітка; під ними — чекліст підкроків. @returns {Body} */
function crawlingBody() {
  const numeral = makeNumeral();
  const bar = makeBar();
  const label = h("div", { class: "sp-caption mono" });
  const steps = makeChecklist();
  const el = h("div", { class: "sp-body" }, numeral.el, bar.el, label, steps.el);
  return {
    el,
    update(state) {
      const p = state.progress;
      numeral.set(String(p?.done ?? 0), p?.total !== null && p?.total !== undefined ? `/${p.total}` : "");
      bar.set(ratioOf(p));
      text(label, `${p?.label ?? "Сканую сайт…"} · ліміт ${CRAWL_LIMIT_S} с`);
      steps.update(stageRows(STAGE_STEPS.crawling, state, steps.seen()), latestProgressAt(state));
    },
  };
}

/** brandkit / scripting: чекліст підкроків стадії. @param {readonly StageStep[]} list @returns {Body} */
function stepsBody(list) {
  const steps = makeChecklist();
  const el = h("div", { class: "sp-body" }, steps.el);
  return {
    el,
    update: (state) => steps.update(stageRows(list, state, steps.seen()), latestProgressAt(state)),
  };
}

/** Будь-який інший статус без окремого вигляду. @param {string} placeholder @returns {Body} */
function logBody(placeholder) {
  const log = makeLog(placeholder);
  const el = h("div", { class: "sp-body" }, log.el);
  return { el, update: (state) => log.update(state) };
}

/** @type {Record<Branch["state"], string>} */
const BRANCH_STATUS = { pending: "очікує", running: "", done: "готово", kept: "без змін" };

/**
 * Гілка directing: назва, статус, смуга і чекліст кроків гілки.
 * @param {"scenes" | "music"} key
 * @param {string} name
 */
function makeBranch(key, name) {
  const status = h("span", { class: "sp-branch__status mono" });
  const spinner = h("span", { class: "spinner", "aria-hidden": "true" });
  const bar = makeBar();
  const steps = makeChecklist("sp-steps--branch");
  const el = h(
    "section",
    { class: "sp-branch", "data-branch": key },
    h(
      "div",
      { class: "sp-branch__head" },
      h("h2", { class: "display-s sp-branch__name", text: name }),
      h("span", { class: "sp-branch__right" }, spinner, status),
    ),
    bar.el,
    steps.el,
  );
  /** @param {Branch} b @param {StepRow[]} rows @param {number | null} now */
  const set = (b, rows, now) => {
    if (el.dataset.state !== b.state) el.dataset.state = b.state;
    spinner.hidden = b.state !== "running";
    const counter =
      b.done !== null && b.total !== null && b.state === "running" ? `${b.done}/${b.total}` : "";
    text(status, BRANCH_STATUS[b.state] || counter);
    bar.set(b.state === "pending" ? 0 : b.ratio);
    steps.update(rows, now);
  };
  return { el, set, seen: steps.seen };
}

/** Дві гілки: «Сцени» і «Музика»; під ними — спільні кроки (звук, рецензія). @returns {Body} */
function directingBody() {
  const scenes = makeBranch("scenes", "Сцени");
  const music = makeBranch("music", "Музика");
  const shared = makeChecklist();
  const tail = h(
    "section",
    { class: "sp-shared" },
    h("h2", { class: "display-s sp-shared__name", text: "Звук і рецензія" }),
    shared.el,
  );
  const el = h("div", { class: "sp-body sp-branches" }, scenes.el, music.el, tail);
  return {
    el,
    update(state) {
      const b = directingBranches(state);
      const rows = directingRows(state, [...scenes.seen(), ...music.seen(), ...shared.seen()]);
      const now = latestProgressAt(state);
      // Почались спільні кроки — гілка «Сцени» закінчена, навіть якщо останній її рядок не 100%.
      const scenesDone = rows.scenes.length > 0 && rows.scenes.every((r) => r.state === "done");
      scenes.set(scenesDone ? { ...b.scenes, state: "done", ratio: 1 } : b.scenes, rows.scenes, now);
      music.set(b.music, rows.music, now);
      shared.update(rows.shared, now);
    },
  };
}

/** Відсоток поточного формату, смуга, специфікація; під ними — чекліст форматів. @returns {Body} */
function renderingBody() {
  const numeral = makeNumeral();
  const bar = makeBar();
  const spec = h("div", { class: "sp-caption mono" });
  const steps = makeChecklist();
  const el = h("div", { class: "sp-body" }, numeral.el, bar.el, spec, steps.el);
  return {
    el,
    update(state) {
      const info = renderInfo(state);
      numeral.set(String(info.percent), "%");
      bar.set(info.percent / 100);
      text(
        spec,
        `${FORMAT_LABELS[info.format]} · ${FORMAT_SIZES[info.format]} · ${CODEC} · формат ${info.index + 1} з ${info.count}`,
      );
      steps.update(renderRows(state), latestProgressAt(state));
    },
  };
}

/** Цитата правки клієнта + чекліст ревізії. @returns {Body} */
function revisingBody() {
  const quoteText = h("p", { class: "sp-quote__text" });
  const quote = h(
    "blockquote",
    { class: "sp-quote" },
    h("span", { class: "label-s sp-quote__label", text: "Ваша правка" }),
    quoteText,
  );
  const steps = makeChecklist();
  const el = h("div", { class: "sp-body" }, quote, steps.el);
  /** @type {string | null} */
  let shown = null;
  return {
    el,
    update(state) {
      const msg = lastClientMessage(state);
      if (msg !== shown) {
        shown = msg;
        quoteText.replaceChildren(...lines(msg ?? ""));
      }
      quote.hidden = !msg;
      steps.update(revisingRows(state, steps.seen()), latestProgressAt(state));
    },
  };
}

/**
 * @param {ProjectStatus} status
 * @returns {Body}
 */
function bodyFor(status) {
  switch (status) {
    case "intake":
      return intakeBody();
    case "crawling":
      return crawlingBody();
    case "directing":
      return directingBody();
    case "rendering":
      return renderingBody();
    case "revising":
      return revisingBody();
    case "brandkit":
    case "scripting":
      return stepsBody(STAGE_STEPS[status]);
    default:
      return logBody(`${capitalize(STATUS_LABELS[status] ?? status)}…`);
  }
}

// ───────────── View ─────────────

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const eyebrow = h("div", { class: "eyebrow sp-eyebrow" });
  const titleText = h("span", { class: "sp-title__text" });
  const title = h(
    "h1",
    { class: "display-l sp-title" },
    titleText,
    h("span", { class: "accent-dot sp-pulse", "aria-hidden": "true", text: "." }),
  );
  const slot = h("div", { class: "sp-slot" });
  const root = h("div", { class: "sp adc-enter", "data-view": "progress" }, eyebrow, title, slot);
  el.append(root);

  /** @type {ProjectStatus | null} */
  let mode = null;
  /** @type {Body | null} */
  let body = null;

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    if (state.status !== mode) {
      const first = mode === null;
      mode = state.status;
      root.dataset.status = mode;
      text(eyebrow, eyebrowFor(state));
      // crawling (X5): заголовок — хост `display-m`; решта — назва стану `display-l`.
      title.className = mode === "crawling" ? "display-m sp-title sp-title--host" : "display-l sp-title";
      body = bodyFor(mode);
      if (!first) body.el.classList.add("adc-enter");
      slot.replaceChildren(body.el);
      prev = null;
    }
    if (
      !prev ||
      state.site !== prev.site ||
      state.progress !== prev.progress ||
      state.stageLog !== prev.stageLog ||
      state.feed !== prev.feed ||
      state.artifacts !== prev.artifacts ||
      state.checkpoints !== prev.checkpoints ||
      state.busySince !== prev.busySince ||
      state.ui !== prev.ui
    ) {
      text(
        titleText,
        mode === "crawling"
          ? (state.site ?? "Сканую сайт")
          : (TITLES[mode] ?? capitalize(STATUS_LABELS[mode] ?? mode)),
      );
      body?.update(state);
    }
  }

  render(ctx.store.getState(), null);

  return {
    update: (state, prev) => render(state, prev),
    destroy() {
      root.remove();
    },
  };
}
