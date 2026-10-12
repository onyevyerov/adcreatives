// @ts-check
/**
 * B5 · Сцена: робочі стани (X5, X6, робочі стани прототипу).
 *
 * Шапка — eyebrow «0N — Сегмент» (сегмент таймлайну C3) і заголовок `display-l` з пульсуючою
 * крапкою `--accent`. Тіло — за статусом:
 * - intake — хост і рядок «готую сканування»;
 * - crawling (X5) — хост `display-m` замість заголовка, `numeral` done/total, смуга, мітка;
 * - brandkit / scripting — `stageLog`: попередні мітки з ✓, остання зі спінером;
 * - directing — дві гілки «Сцени» (codegen/check/fix/qa) і «Музика» (audio);
 * - rendering — `numeral` відсоток, смуга, «9:16 · 1080×1920 · h264 · формат N з M»;
 * - revising — «Вношу правки» + цитата останнього повідомлення клієнта + `stageLog`.
 *
 * Тіло перебудовується лише при зміні статусу; лічильники, смуги й мітки патчаться на місці.
 */
import { FORMAT_LABELS, FORMATS, SEGMENTS, STATUS_LABELS } from "../contracts.js";
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

/** Стадії гілки «Сцени» в directing (X6). */
export const SCENE_STAGES = ["codegen", "check", "fix", "qa"];
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

/** X5: лічильник done/total, смуга, мітка. @returns {Body} */
function crawlingBody() {
  const numeral = makeNumeral();
  const bar = makeBar();
  const label = h("div", { class: "sp-caption mono" });
  const el = h("div", { class: "sp-body" }, numeral.el, bar.el, label);
  return {
    el,
    update(state) {
      const p = state.progress;
      numeral.set(String(p?.done ?? 0), p?.total !== null && p?.total !== undefined ? `/${p.total}` : "");
      bar.set(ratioOf(p));
      text(label, `${p?.label ?? "Сканую сайт…"} · ліміт ${CRAWL_LIMIT_S} с`);
    },
  };
}

/** brandkit / scripting і будь-який інший статус без окремого вигляду. @param {string} placeholder @returns {Body} */
function logBody(placeholder) {
  const log = makeLog(placeholder);
  const el = h("div", { class: "sp-body" }, log.el);
  return { el, update: (state) => log.update(state) };
}

/** @type {Record<Branch["state"], string>} */
const BRANCH_STATUS = { pending: "очікує", running: "", done: "готово", kept: "без змін" };

/**
 * Гілка directing.
 * @param {"scenes" | "music"} key
 * @param {string} name
 */
function makeBranch(key, name) {
  const status = h("span", { class: "sp-branch__status mono" });
  const spinner = h("span", { class: "spinner", "aria-hidden": "true" });
  const bar = makeBar();
  const label = h("div", { class: "sp-caption mono" });
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
    label,
  );
  /** @param {Branch} b */
  const set = (b) => {
    if (el.dataset.state !== b.state) el.dataset.state = b.state;
    spinner.hidden = b.state !== "running";
    const counter =
      b.done !== null && b.total !== null && b.state === "running" ? `${b.done}/${b.total}` : "";
    text(status, BRANCH_STATUS[b.state] || counter);
    bar.set(b.state === "pending" ? 0 : b.ratio);
    text(label, b.label);
  };
  return { el, set };
}

/** Дві гілки: «Сцени» і «Музика». @returns {Body} */
function directingBody() {
  const scenes = makeBranch("scenes", "Сцени");
  const music = makeBranch("music", "Музика");
  const el = h("div", { class: "sp-body sp-branches" }, scenes.el, music.el);
  return {
    el,
    update(state) {
      const b = directingBranches(state);
      scenes.set(b.scenes);
      music.set(b.music);
    },
  };
}

/** Відсоток поточного формату, смуга, специфікація. @returns {Body} */
function renderingBody() {
  const numeral = makeNumeral();
  const bar = makeBar();
  const spec = h("div", { class: "sp-caption mono" });
  const el = h("div", { class: "sp-body" }, numeral.el, bar.el, spec);
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
    },
  };
}

/** Цитата правки клієнта + мітки ревізії. @returns {Body} */
function revisingBody() {
  const quoteText = h("p", { class: "sp-quote__text" });
  const quote = h(
    "blockquote",
    { class: "sp-quote" },
    h("span", { class: "label-s sp-quote__label", text: "Ваша правка" }),
    quoteText,
  );
  const log = makeLog("Читаю правку…");
  const el = h("div", { class: "sp-body" }, quote, log.el);
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
      log.update(state);
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
