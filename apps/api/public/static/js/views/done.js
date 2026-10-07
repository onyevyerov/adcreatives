// @ts-check
/**
 * B9 · Готово — плеєр, завантаження, витрати (S5, C1, C7).
 *
 * Ліворуч — `<video playsinline preload="metadata">` поточного формату (`ui.doneFormat`, за
 * замовчуванням основний) останньої ревізії з власними контролами: play/pause 40 px, скраббер
 * сегментами сцен (межі — `lib/scene-track.js` з payload чекпоінта 2, інакше один сегмент),
 * тайм-код `00:07 / 00:15`. Без відео — смугастий плейсхолдер.
 * Праворуч — eyebrow «Готово · ревізія N», «Ролик готовий.», лід, перемикач форматів (якщо їх > 1),
 * рядки завантаження (MP4 на формат + постер) і таблиця витрат з підсумком і машинним часом.
 *
 * `update` патчить лише змінене: `<video>` створюється один раз, при зміні формату чи ревізії
 * міняється лише `src`; списки завантажень, витрат, форматів і сегментів перебудовуються лише
 * тоді, коли змінились їхні дані. Тексти — лише через `textContent`, URL — через `safeMediaUrl`.
 */
import { FORMAT_LABELS, FORMATS } from "../contracts.js";
import { clear, h, text } from "../dom.js";
import { formatSeconds, sceneSegments, timelineOf } from "../lib/scene-track.js";
import { formatMachineTime, machineMs } from "../lib/timeline.js";
import { safeMediaUrl } from "./cp-script.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {UiState["artifacts"]["videos"][number]} Video */
/** Сегмент скраббера у відсотках тривалості ролика. @typedef {{ id: string, startPct: number, endPct: number }} ScrubSegment */

/**
 * Людські назви стадій витрат (`CostStage` з `@adc/shared`: `STAGE_NAMES` + службові).
 * Невідома стадія показується як є.
 * @type {Record<string, string>}
 */
export const STAGE_LABELS = {
  crawl: "Сканування сайту",
  ingest: "Обробка фото",
  brandkit: "Бренд-кіт",
  "brandkit-patch": "Правки бренд-кіту",
  storyboard: "Сценарій",
  codegen: "Генерація сцен",
  check: "Перевірка сцен",
  fix: "Виправлення сцен",
  qa: "Контроль якості",
  revise: "Правки",
  audio: "Музика і звук",
  render: "Рендер",
  "chat-intent": "Чат · розбір запитів",
  "chat-reply": "Чат · відповіді",
  "sfx-cache": "Звукові ефекти",
  live: "Живі прогони",
};

/** Розміри кадру рендеру за форматом. @type {Record<Format, string>} */
export const FORMAT_SIZES = { vertical: "1080×1920", square: "1080×1080", landscape: "1920×1080" };
/** Кодеки рендеру (packages/render/src/engine.ts: `codec: "h264"`, `audioCodec: "aac"`). */
const CODEC = "h264 + aac";

export const LEAD =
  "Завантажте MP4 у потрібному форматі. Якщо щось треба змінити — напишіть у чаті, я внесу правки й перерендерю ролик.";

/** Крок перемотування з клавіатури, с: стрілки — 1, Shift+стрілки / PageUp / PageDown — 5. */
export const SEEK_STEP = 1;
export const SEEK_STEP_BIG = 5;

/** @param {number} n */
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** @param {number} n */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Для кожного формату — відео останньої ревізії (найбільший `rev`; за рівності — пізніша подія),
 * у канонічному порядку `FORMATS`. Формати з небезпечним URL відкидаються.
 * @param {readonly Video[] | null | undefined} videos
 * @returns {Video[]}
 */
export function latestVideos(videos) {
  /** @type {Map<Format, Video>} */
  const best = new Map();
  for (const v of videos ?? []) {
    if (!v || !FORMATS.includes(v.format)) continue;
    const cur = best.get(v.format);
    if (!cur || v.rev >= cur.rev) best.set(v.format, v);
  }
  /** @type {Video[]} */
  const out = [];
  for (const f of FORMATS) {
    const v = best.get(f);
    if (v && safeMediaUrl(v.url) !== null) out.push(v);
  }
  return out;
}

/**
 * Основний формат: `primaryFormat` з payload чекпоінта 3, якщо для нього є відео, інакше перший
 * наявний у порядку `FORMATS`.
 * @param {Pick<UiState, "checkpoints">} state
 * @param {readonly Format[]} available
 * @returns {Format | null}
 */
export function primaryFormat(state, available) {
  const p = state.checkpoints?.storyboard?.payload;
  const primary = p?.checkpoint === "storyboard" ? p.primaryFormat : null;
  if (primary && available.includes(primary)) return primary;
  return available[0] ?? null;
}

/**
 * Формат плеєра: `ui.doneFormat`, якщо для нього є відео, інакше основний.
 * @param {Pick<UiState, "checkpoints" | "ui">} state
 * @param {readonly Format[]} available
 * @returns {Format | null}
 */
export function currentFormat(state, available) {
  const f = state.ui?.doneFormat;
  return f && available.includes(f) ? f : primaryFormat(state, available);
}

/**
 * Номер ревізії для eyebrow: `state.rev`, інакше найбільший `rev` серед відео; `null` — невідомо.
 * @param {Pick<UiState, "rev" | "artifacts">} state
 * @returns {number | null}
 */
export function revisionOf(state) {
  if (typeof state.rev === "number") return state.rev;
  const revs = (state.artifacts?.videos ?? []).map((v) => v.rev).filter((r) => Number.isFinite(r));
  return revs.length > 0 ? Math.max(...revs) : null;
}

/**
 * Сегменти скраббера: межі сцен з payload чекпоінта 2 (`sceneSegments`), інакше один сегмент.
 * @param {Pick<UiState, "checkpoints">} state
 * @returns {ScrubSegment[]}
 */
export function scrubSegments(state) {
  const timeline = timelineOf(state.checkpoints?.script?.payload);
  if (!timeline) return [{ id: "all", startPct: 0, endPct: 100 }];
  return sceneSegments(timeline).map((s) => ({ id: s.id, startPct: s.startPct, endPct: s.endPct }));
}

/**
 * Долари з двома знаками: 1.085 → «$1.09».
 * @param {number} usd
 */
export function formatUsd(usd) {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}

/**
 * Секунди → «mm:ss» (07 → «00:07»).
 * @param {number} seconds
 */
export function formatClock(seconds) {
  return formatMachineTime(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0);
}

/**
 * Тривалість для рядка завантаження: «15 с», «16,5 с»; невідома — `null`.
 * @param {number | null | undefined} seconds
 * @returns {string | null}
 */
export function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const r = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(r) ? String(r) : formatSeconds(r)} с`;
}

/**
 * Тривалість ролика, с: `durationSeconds` з payload чекпоінта 2 або `null`.
 * @param {Pick<UiState, "checkpoints">} state
 * @returns {number | null}
 */
export function scriptDuration(state) {
  const p = state.checkpoints?.script?.payload;
  return p?.checkpoint === "script" && p.durationSeconds > 0 ? p.durationSeconds : null;
}

/**
 * Назва стадії витрат.
 * @param {string} stage
 */
export function stageLabel(stage) {
  return STAGE_LABELS[stage] ?? stage;
}

/**
 * Розширення файлу з URL у верхньому регістрі («/x/poster.png?rev=2» → «PNG») або `null`.
 * @param {string} url
 * @returns {string | null}
 */
export function fileExt(url) {
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * Рядок завантаження (C7): назва і мета ліворуч, круглий «↓» праворуч; весь рядок — `<a download>`.
 * @param {{ href: string, download: string, name: string, meta: string, label: string, kind: string, format?: Format }} o
 */
function downloadRow(o) {
  return h(
    "li",
    { class: "dn-dl-item" },
    h(
      "a",
      {
        class: "dn-dl",
        href: o.href,
        download: o.download,
        "data-kind": o.kind,
        "data-format": o.format,
        "aria-label": o.label,
      },
      h(
        "span",
        { class: "dn-dl__text" },
        h("span", { class: "dn-dl__name", text: o.name }),
        h("span", { class: "mono dn-dl__meta", text: o.meta }),
      ),
      h("span", { class: "btn-round btn-round--ghost dn-dl__icon", "aria-hidden": "true", text: "↓" }),
    ),
  );
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  let destroyed = false;
  let raf = 0;
  let dragging = false;
  /** @type {string | null} */
  let videoUrl = null;
  /** @type {Format | null} */
  let videoFormat = null;
  /** Позиція й стан відтворення, які треба відновити після перемикання формату. @type {{ time: number, play: boolean } | null} */
  let resume = null;
  /** @type {ScrubSegment[]} */
  let segments = [];
  /** @type {{ el: HTMLElement, fill: HTMLElement }[]} */
  let segEls = [];
  let segKey = "";
  /** @type {string | null} */
  let formatsKey = null;
  let downloadsKey = "";
  let costsKey = "";
  /** @type {Format | null} */
  let shownFormat = null;
  /** @type {Array<() => void>} */
  const offs = [];

  /**
   * @param {EventTarget} target
   * @param {string} type
   * @param {(e: any) => void} fn
   */
  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    offs.push(() => target.removeEventListener(type, fn));
  };

  // ── Плеєр ──
  const video = h("video", {
    class: "dn-video",
    playsinline: true,
    preload: "metadata",
    "aria-label": "Готовий ролик",
  });
  const emptyNote = h("span", { class: "label-s dn-empty", text: "Відео ще немає", hidden: true });
  const frame = h("div", { class: "dn-frame" }, video, emptyNote);
  const playIcon = h("span", { class: "icon-play", "aria-hidden": "true" });
  const playBtn = h(
    "button",
    { type: "button", class: "btn-round btn-round--40 dn-play", "aria-label": "Відтворити" },
    playIcon,
  );
  const track = h("div", { class: "dn-scrub__track" });
  const head = h("span", { class: "dn-scrub__head", "aria-hidden": "true" });
  const scrub = h(
    "div",
    {
      class: "dn-scrub",
      role: "slider",
      tabindex: "0",
      "aria-label": "Позиція відтворення",
      "aria-valuemin": "0",
      "aria-valuemax": "0",
      "aria-valuenow": "0",
      "aria-valuetext": "00:00 з 00:00",
    },
    track,
    head,
  );
  const timeEl = h("span", { class: "mono dn-time", text: "00:00 / 00:00" });
  const controls = h("div", { class: "dn-controls" }, playBtn, scrub, timeEl);
  const player = h("figure", { class: "dn-player" }, frame, controls);

  // ── Інформація ──
  const eyebrow = h("p", { class: "eyebrow dn-eyebrow" });
  const formatsEl = h("div", { class: "seg dn-formats", role: "group", "aria-label": "Формат відео" });
  const dlList = h("ul", { class: "dn-dl-list" });
  const costBody = h("tbody");
  const costFoot = h("tfoot");
  const root = h(
    "section",
    { class: "dn adc-enter", "aria-label": "Готово" },
    h(
      "div",
      { class: "dn-grid" },
      h("div", { class: "dn-media" }, player),
      h(
        "div",
        { class: "dn-info" },
        h(
          "header",
          { class: "dn-head" },
          eyebrow,
          h("h1", { class: "display-m dn-title" }, "Ролик готовий", h("span", { class: "accent-dot" }, ".")),
          h("p", { class: "body-l dn-lead", text: LEAD }),
        ),
        formatsEl,
        h(
          "section",
          { class: "dn-block dn-downloads", "aria-label": "Завантаження" },
          h("h2", { class: "label-s dn-block__title", text: "Завантаження" }),
          dlList,
        ),
        h(
          "section",
          { class: "dn-block dn-costs", "aria-label": "Витрати" },
          h("h2", { class: "label-s dn-block__title", text: "Витрати за етапами" }),
          h("table", { class: "dn-cost-table" }, costBody, costFoot),
        ),
      ),
    ),
  );
  el.append(root);

  // ── Плеєр: відтворення і малювання ──

  /** @param {boolean} playing */
  function setPlaying(playing) {
    playIcon.className = playing ? "icon-pause" : "icon-play";
    playBtn.setAttribute("aria-label", playing ? "Пауза" : "Відтворити");
    root.dataset.playing = playing ? "true" : "false";
  }

  /** @param {boolean} empty */
  function setEmpty(empty) {
    frame.classList.toggle("stripes", empty);
    frame.classList.toggle("dn-frame--empty", empty);
    video.hidden = empty;
    emptyNote.hidden = !empty;
    controls.hidden = empty;
  }

  /**
   * @param {number} t поточна секунда
   * @param {number} d тривалість (0 — невідома)
   */
  function paintAt(t, d) {
    const pct = d > 0 ? clamp01(t / d) * 100 : 0;
    let current = -1;
    segEls.forEach((s, i) => {
      const seg = /** @type {ScrubSegment} */ (segments[i]);
      const w = seg.endPct - seg.startPct;
      const fill = w > 0 ? clamp01((pct - seg.startPct) / w) : pct >= seg.endPct ? 1 : 0;
      s.fill.style.setProperty("--fill", String(round3(fill)));
      if (current === -1 && d > 0 && (pct < seg.endPct || i === segEls.length - 1)) current = i;
      s.el.classList.toggle("is-current", i === current);
    });
    head.style.setProperty("--pos", `${round3(pct)}%`);
    const now = formatClock(t);
    const total = formatClock(d);
    text(timeEl, `${now} / ${total}`);
    scrub.setAttribute("aria-valuemax", String(Math.round(d)));
    scrub.setAttribute("aria-valuenow", String(Math.min(Math.floor(t), Math.round(d))));
    scrub.setAttribute("aria-valuetext", `${now} з ${total}`);
  }

  function duration() {
    const d = video.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  function paint() {
    const t = video.currentTime;
    paintAt(Number.isFinite(t) && t > 0 ? t : 0, duration());
  }

  function tick() {
    paint();
    raf =
      !destroyed && !video.paused && typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(tick)
        : 0;
  }

  function stopTick() {
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    raf = 0;
  }

  function play() {
    try {
      const p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch((/** @type {unknown} */ err) => {
          // AbortError — src змінився посеред play(); NotAllowedError — політика автовідтворення.
          if (!destroyed) console.debug("[done] play", err);
        });
      }
    } catch (err) {
      console.debug("[done] play", err);
    }
  }

  function toggle() {
    if (!videoUrl) return;
    if (video.paused || video.ended) play();
    else video.pause();
  }

  /** @param {number} seconds */
  function seekTo(seconds) {
    const d = duration();
    if (!d) return;
    const t = Math.min(d, Math.max(0, seconds));
    try {
      video.currentTime = t;
    } catch {
      return;
    }
    paintAt(t, d);
  }

  /** @param {number} clientX */
  function seekToX(clientX) {
    const r = track.getBoundingClientRect();
    if (!(r.width > 0)) return;
    seekTo(clamp01((clientX - r.left) / r.width) * duration());
  }

  /**
   * Новий URL відео: той самий `<video>`, змінюється лише `src`. При перемиканні формату
   * позиція й стан відтворення переносяться після `loadedmetadata`.
   * @param {string | null} url
   * @param {Format | null} format
   */
  function setSource(url, format) {
    if (url === videoUrl) {
      videoFormat = format;
      return;
    }
    const playing = videoUrl !== null && !video.paused && !video.ended;
    const t = videoUrl !== null && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    resume =
      url && videoUrl !== null && format !== videoFormat && (playing || t > 0)
        ? { time: t, play: playing }
        : null;
    videoUrl = url;
    videoFormat = format;
    stopTick();
    if (url) {
      video.setAttribute("src", url);
      setEmpty(false);
    } else {
      try {
        video.pause();
      } catch {
        // happy-dom / старі браузери
      }
      video.removeAttribute("src");
      setEmpty(true);
    }
    setPlaying(false);
    paintAt(0, 0);
  }

  // ── Будова списків ──

  /** @param {ScrubSegment[]} next */
  function buildScrub(next) {
    segments = next;
    clear(track);
    segEls = next.map((s) => {
      const fill = h("span", { class: "dn-scrub__fill" });
      const segEl = h(
        "span",
        {
          class: "dn-scrub__seg",
          "data-scene": s.id,
          style: { "--l": `${round3(s.startPct)}%`, "--w": `${round3(s.endPct - s.startPct)}%` },
        },
        h("span", { class: "dn-scrub__bar" }, fill),
      );
      track.append(segEl);
      return { el: segEl, fill };
    });
    paint();
  }

  /** @param {readonly Format[]} list */
  function buildFormats(list) {
    clear(formatsEl);
    for (const f of list) {
      formatsEl.append(
        h("button", {
          type: "button",
          class: "seg__opt dn-format",
          "data-format": f,
          "aria-pressed": "false",
          text: FORMAT_LABELS[f],
        }),
      );
    }
    formatsEl.hidden = list.length <= 1;
    shownFormat = null;
  }

  /** @param {Format | null} format */
  function syncFormat(format) {
    if (format === shownFormat) return;
    shownFormat = format;
    for (const b of formatsEl.querySelectorAll("button[data-format]")) {
      const on = b.getAttribute("data-format") === format;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("is-on", on);
    }
  }

  /**
   * @param {Video[]} latest
   * @param {string | null} poster
   * @param {Format | null} primary
   * @param {number | null} rev
   * @param {string | null} length тривалість («15 с») або `null`
   */
  function buildDownloads(latest, poster, primary, rev, length) {
    clear(dlList);
    for (const v of latest) {
      const href = safeMediaUrl(v.url);
      if (!href) continue;
      const label = FORMAT_LABELS[v.format];
      const size = FORMAT_SIZES[v.format];
      dlList.append(
        downloadRow({
          href,
          download: `adcreative-${label.replace(":", "x")}-r${v.rev}.mp4`,
          name: `MP4 · ${label}`,
          meta: [size, length, CODEC].filter(Boolean).join(" · "),
          label: `Завантажити ${label} · ${size} · MP4`,
          kind: "video",
          format: v.format,
        }),
      );
    }
    if (poster) {
      const ext = fileExt(poster) ?? "PNG";
      const meta = [ext, primary ? FORMAT_LABELS[primary] : null, "кадр заклику"].filter(Boolean).join(" · ");
      dlList.append(
        downloadRow({
          href: poster,
          download: `adcreative-poster${rev ? `-r${rev}` : ""}.${ext.toLowerCase()}`,
          name: "Постер",
          meta,
          label: `Завантажити постер · ${meta}`,
          kind: "poster",
        }),
      );
    }
    if (!dlList.firstChild)
      dlList.append(h("li", { class: "dn-dl-none", text: "Файлів для завантаження поки немає." }));
  }

  /** @param {UiState} state */
  function buildCosts(state) {
    clear(costBody);
    clear(costFoot);
    for (const r of state.breakdown ?? []) {
      costBody.append(
        h(
          "tr",
          { class: "dn-cost", "data-stage": r.stage },
          h("th", { class: "dn-cost__stage", scope: "row", title: r.stage, text: stageLabel(r.stage) }),
          h("td", { class: "dn-cost__usd", text: formatUsd(r.usd) }),
        ),
      );
    }
    costFoot.append(
      h(
        "tr",
        { class: "dn-cost dn-cost--total" },
        h("th", {
          class: "dn-cost__stage",
          scope: "row",
          text: `Разом · машинний час ${formatMachineTime(machineMs(state))}`,
        }),
        h("td", { class: "dn-cost__usd", text: formatUsd(state.totalUsd) }),
      ),
    );
  }

  // ── Рендер ──

  /** @param {UiState} state */
  function render(state) {
    const latest = latestVideos(state.artifacts?.videos);
    const available = latest.map((v) => v.format);
    const format = currentFormat(state, available);
    const primary = primaryFormat(state, available);
    const current = latest.find((v) => v.format === format) ?? null;
    const rev = revisionOf(state);
    const poster = safeMediaUrl(state.artifacts?.poster);

    root.dataset.format = format ?? "none";
    player.dataset.format = format ?? "none";
    setSource(current ? safeMediaUrl(current.url) : null, format);
    if (poster) {
      if (video.getAttribute("poster") !== poster) video.setAttribute("poster", poster);
    } else video.removeAttribute("poster");

    text(eyebrow, rev === null ? "Готово" : `Готово · ревізія ${rev}`);

    const nextSegments = scrubSegments(state);
    const nextSegKey = JSON.stringify(nextSegments);
    if (nextSegKey !== segKey) {
      segKey = nextSegKey;
      buildScrub(nextSegments);
    }

    const nextFormatsKey = available.join(",");
    if (nextFormatsKey !== formatsKey) {
      formatsKey = nextFormatsKey;
      buildFormats(available);
    }
    syncFormat(format);

    // Тривалість: фактична з `<video>` (після loadedmetadata), інакше з чекпоінта 2.
    const length = formatDuration(duration() || scriptDuration(state));
    const nextDownloadsKey = JSON.stringify([latest, poster, primary, rev, length]);
    if (nextDownloadsKey !== downloadsKey) {
      downloadsKey = nextDownloadsKey;
      buildDownloads(latest, poster, primary, rev, length);
    }

    const nextCostsKey = JSON.stringify([
      state.breakdown,
      state.totalUsd,
      formatMachineTime(machineMs(state)),
    ]);
    if (nextCostsKey !== costsKey) {
      costsKey = nextCostsKey;
      buildCosts(state);
    }
  }

  // ── Обробники ──

  on(playBtn, "click", toggle);
  on(video, "click", toggle);
  on(video, "play", () => {
    setPlaying(true);
    stopTick();
    tick();
  });
  on(video, "pause", () => {
    setPlaying(false);
    stopTick();
    paint();
  });
  on(video, "ended", () => {
    setPlaying(false);
    stopTick();
    paint();
  });
  on(video, "timeupdate", () => {
    if (!raf) paint();
  });
  on(video, "durationchange", () => {
    paint();
    if (!destroyed) render(ctx.store.getState());
  });
  on(video, "loadedmetadata", () => {
    const r = resume;
    resume = null;
    if (r) {
      const d = duration();
      if (r.time > 0 && d) seekTo(Math.min(r.time, Math.max(0, d - 0.05)));
      if (r.play) play();
    }
    paint();
    if (!destroyed) render(ctx.store.getState());
  });
  on(video, "error", () => {
    if (!video.getAttribute("src")) return;
    stopTick();
    setPlaying(false);
    setEmpty(true);
  });

  on(formatsEl, "click", (/** @type {MouseEvent} */ e) => {
    const target = /** @type {Element | null} */ (e.target);
    const btn = target?.closest?.("button[data-format]");
    if (!btn) return;
    const f = /** @type {Format} */ (btn.getAttribute("data-format"));
    if (f === shownFormat) return;
    ctx.actions.setDoneFormat(f);
  });

  on(scrub, "pointerdown", (/** @type {PointerEvent} */ e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (!duration()) return;
    e.preventDefault();
    dragging = true;
    try {
      scrub.setPointerCapture?.(e.pointerId);
    } catch {
      // pointerId може бути недійсним (синтетичні події)
    }
    scrub.focus();
    seekToX(e.clientX);
  });
  on(scrub, "pointermove", (/** @type {PointerEvent} */ e) => {
    if (dragging) seekToX(e.clientX);
  });
  /** @param {PointerEvent} e */
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      scrub.releasePointerCapture?.(e.pointerId);
    } catch {
      // захоплення вже знято
    }
  };
  on(scrub, "pointerup", endDrag);
  on(scrub, "pointercancel", endDrag);
  on(scrub, "lostpointercapture", () => {
    dragging = false;
  });

  on(scrub, "keydown", (/** @type {KeyboardEvent} */ e) => {
    const d = duration();
    const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const step = e.shiftKey ? SEEK_STEP_BIG : SEEK_STEP;
    /** @type {number | null} */
    let to = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        to = t + step;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        to = t - step;
        break;
      case "PageUp":
        to = t + SEEK_STEP_BIG;
        break;
      case "PageDown":
        to = t - SEEK_STEP_BIG;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = d;
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        toggle();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (d) seekTo(to);
  });

  setPlaying(false);
  setEmpty(true); // поки немає URL відео (`videoUrl === null`)
  render(ctx.store.getState());

  return {
    update(state) {
      render(state);
    },
    destroy() {
      destroyed = true;
      stopTick();
      try {
        video.pause();
      } catch {
        // happy-dom / старі браузери
      }
      for (const off of offs.splice(0)) off();
      root.remove();
    },
  };
}
