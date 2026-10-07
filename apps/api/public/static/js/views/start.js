// @ts-check
/**
 * B1 · Стартовий екран (S1, C1, C3, X6).
 *
 * Ліворуч — заголовок, лід і форма (адреса сайту або опис бізнесу + фото) → `createProject`.
 * Праворуч — приклад ролика 9:16 (`static/media/sample-9x16.mp4`), без файлу — смугастий плейсхолдер.
 * Унизу — легенда таймлайну (C3, усе неактивне).
 *
 * `update` патчить лише помилку старту і стан кнопки: `<video>`, поля й textarea не перестворюються.
 */
import { SEGMENTS } from "../contracts.js";
import { h, text } from "../dom.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */

/** Скільки фото можна додати на старті (= `MAX_PHOTOS_PER_REQUEST` бекенду). */
export const MAX_PHOTOS = 10;
export const EXAMPLE_HOST = "zerno.example.com";
export const SAMPLE_VIDEO = "/static/media/sample-9x16.mp4";
export const SAMPLE_POSTER = "/static/media/sample-9x16.jpg";

const PHOTOS_EMPTY = `+ Фото (до ${MAX_PHOTOS})`;
const ERR_EMPTY = "Вставте адресу сайту або коротко опишіть бізнес.";
const ERR_TOO_MANY = `Можна додати до ${MAX_PHOTOS} фото за раз.`;

/**
 * Секунди → «0:03».
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** @returns {boolean} */
function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Легенда таймлайну (C3) у неактивному стані: номери й назви сегментів, тіки і ромби чекпоінтів.
 * @returns {HTMLElement}
 */
function legend() {
  const total = SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
  let acc = 0;
  /** @type {HTMLElement[]} */
  const diamonds = [];
  for (const seg of SEGMENTS) {
    acc += seg.weight;
    if (!seg.checkpoint) continue;
    const left = `${Math.round((acc / total) * 10000) / 100}%`;
    diamonds.push(
      h("span", {
        class: "diamond diamond--lg st-legend__diamond",
        "data-checkpoint": seg.checkpoint,
        style: { left },
      }),
    );
  }
  return h(
    "div",
    { class: "st-legend", "aria-hidden": "true" },
    h(
      "ol",
      { class: "st-legend__labels" },
      SEGMENTS.map((seg, i) =>
        h(
          "li",
          { class: "st-legend__seg", "data-segment": seg.key, style: { flexGrow: seg.weight } },
          h("span", { class: "st-legend__num", text: String(i + 1).padStart(2, "0") }),
          " ",
          seg.label,
        ),
      ),
    ),
    h("div", { class: "st-legend__track" }, diamonds),
  );
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  let pending = false;
  let destroyed = false;
  /** @type {string | null} */
  let clientError = null;
  /** @type {File[]} */
  let photos = [];
  let manualOpen = false;
  let raf = 0;

  // ── Форма ──
  const urlInput = h("input", {
    class: "st-url",
    id: "st-url",
    name: "url",
    type: "text",
    inputmode: "url",
    autocomplete: "url",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "адреса-вашого-сайту.ua",
    "aria-describedby": "st-error",
  });
  const submitBtn = h(
    "button",
    { class: "btn btn--primary btn--lg st-submit", type: "submit" },
    "Почати",
    h("span", { class: "btn__arrow", "aria-hidden": "true", text: "→" }),
  );
  const errorEl = h("p", { class: "st-error", id: "st-error", role: "alert" });

  const exampleBtn = h(
    "button",
    { class: "st-link st-example", type: "button" },
    "Приклад: ",
    h("span", { class: "st-link__mono", text: EXAMPLE_HOST }),
  );
  const manualBtn = h("button", {
    class: "st-link st-manual-toggle",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": "st-manual",
    text: "Немає сайту? Опишіть бізнес",
  });
  const fileInput = h("input", {
    class: "st-file",
    name: "photos",
    type: "file",
    multiple: true,
    accept: "image/*,.heic,.heif",
    tabindex: "-1",
    "aria-hidden": "true",
    hidden: true,
  });
  const photosBtn = h("button", {
    class: "btn btn--tag st-photos",
    type: "button",
    "aria-describedby": "st-error",
    text: PHOTOS_EMPTY,
  });
  const manualText = h("textarea", {
    class: "st-manual__text",
    id: "st-manual-text",
    name: "manualText",
    rows: "4",
    placeholder: "Кав'ярня на Подолі: обсмажуємо зерно самі, сніданки до 12:00, є веганське меню…",
  });
  const manualBox = h(
    "div",
    { class: "st-manual", id: "st-manual", hidden: true },
    h("label", {
      class: "label-s st-manual__label",
      for: "st-manual-text",
      text: "Кілька речень про бізнес",
    }),
    manualText,
  );

  const form = h(
    "form",
    { class: "st-form", novalidate: true, "aria-label": "Новий проєкт" },
    h(
      "div",
      { class: "st-row" },
      h("label", { class: "sr-only", for: "st-url", text: "Адреса сайту бізнесу" }),
      urlInput,
      submitBtn,
    ),
    errorEl,
    h("div", { class: "st-extras" }, exampleBtn, manualBtn, photosBtn, fileInput),
    manualBox,
  );

  // ── Приклад ролика ──
  const video = h("video", {
    class: "st-video",
    src: SAMPLE_VIDEO,
    poster: SAMPLE_POSTER,
    muted: true,
    loop: true,
    playsinline: true,
    autoplay: !prefersReducedMotion(),
    preload: "auto",
    "aria-label": "Приклад ролика 9:16",
  });
  const frame = h("div", { class: "st-frame stripes" }, video);
  const barFill = h("div", { class: "bar__fill" });
  const timeEl = h("span", { class: "mono st-time", text: "0:00 / 0:00" });
  const player = h(
    "figure",
    { class: "st-player" },
    frame,
    h("figcaption", { class: "st-meta" }, h("div", { class: "bar st-bar" }, barFill), timeEl),
  );

  const root = h(
    "div",
    { class: "st", "data-view": "start" },
    h(
      "header",
      { class: "st-head" },
      h("a", { class: "wordmark", href: "/", text: "AdCreative" }),
      h("span", { class: "label-s st-demo", text: "Демо · v0" }),
    ),
    h(
      "div",
      { class: "st-main" },
      h(
        "div",
        { class: "st-left adc-enter" },
        h(
          "h1",
          { class: "display-xl st-title" },
          "Сайт стає роликом",
          h("span", { class: "accent-dot" }, "."),
        ),
        h("p", {
          class: "body-l st-lead",
          text:
            "Вставте адресу сайту бізнесу — я зберу бренд-кіт, напишу сценарій, згенерую сцени й музику. " +
            "Ви погоджуєте результат на трьох чекпоінтах.",
        }),
        form,
      ),
      h("div", { class: "st-right adc-enter" }, player),
    ),
    h(
      "footer",
      { class: "st-foot adc-enter" },
      legend(),
      h("p", {
        class: "st-note",
        text: "Три чекпоінти — бренд, тексти, розкадровка. Нічого не рендериться без вашого «так».",
      }),
    ),
  );
  el.append(root);

  // ── Рендер ──
  /** @param {UiState} state */
  function render(state) {
    const message = clientError ?? state.ui.startError ?? "";
    text(errorEl, message);
    errorEl.hidden = !message;
    urlInput.setAttribute("aria-invalid", message ? "true" : "false");
    const busy = pending || state.ui.sending;
    submitBtn.disabled = busy;
    form.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /** @param {string | null} message */
  function setClientError(message) {
    if (clientError === message) return;
    clientError = message;
    render(ctx.store.getState());
  }

  function paintTime() {
    const d = video.duration;
    const t = video.currentTime;
    const ok = Number.isFinite(d) && d > 0;
    barFill.style.setProperty("--bar-value", String(ok ? Math.min(1, t / d) : 0));
    text(timeEl, `${formatTime(t)} / ${formatTime(ok ? d : 0)}`);
  }

  function tick() {
    paintTime();
    raf =
      !destroyed && !video.paused && typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(tick)
        : 0;
  }

  function stopTick() {
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    raf = 0;
  }

  // ── Обробники ──
  exampleBtn.addEventListener("click", () => {
    urlInput.value = EXAMPLE_HOST;
    setClientError(null);
    urlInput.focus();
  });

  manualBtn.addEventListener("click", () => {
    manualOpen = !manualOpen;
    manualBox.hidden = !manualOpen;
    manualBtn.setAttribute("aria-expanded", String(manualOpen));
    text(manualBtn, manualOpen ? "Сховати опис" : "Немає сайту? Опишіть бізнес");
    if (manualOpen) manualText.focus();
  });

  photosBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const chosen = Array.from(fileInput.files ?? []);
    if (chosen.length > MAX_PHOTOS) {
      photos = [];
      fileInput.value = "";
      text(photosBtn, PHOTOS_EMPTY);
      setClientError(ERR_TOO_MANY);
      return;
    }
    photos = chosen;
    text(photosBtn, photos.length ? `Фото: ${photos.length}` : PHOTOS_EMPTY);
    if (clientError === ERR_TOO_MANY) setClientError(null);
  });

  const clearEmpty = () => {
    if (clientError === ERR_EMPTY) setClientError(null);
  };
  urlInput.addEventListener("input", clearEmpty);
  manualText.addEventListener("input", clearEmpty);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const state = ctx.store.getState();
    if (pending || state.ui.sending) return;
    const url = urlInput.value.trim();
    const manual = manualOpen ? manualText.value.trim() : "";
    if (!url && !manual) {
      setClientError(ERR_EMPTY);
      (manualOpen ? manualText : urlInput).focus();
      return;
    }
    const data = new FormData();
    if (url) data.append("url", url);
    if (manual) data.append("manualText", manual);
    for (const file of photos) data.append("photos", file);

    clientError = null;
    pending = true;
    render(ctx.store.getState());
    try {
      await ctx.actions.createProject(data);
    } catch (err) {
      // createProject (B2) кладе помилки в ui.startError і не відхиляє; це — страховка.
      console.error("[start] createProject", err);
    } finally {
      pending = false;
      if (!destroyed) render(ctx.store.getState());
    }
  });

  video.addEventListener("loadedmetadata", paintTime);
  video.addEventListener("timeupdate", () => {
    if (!raf) paintTime();
  });
  video.addEventListener("play", () => {
    stopTick();
    tick();
  });
  video.addEventListener("pause", stopTick);
  video.addEventListener("error", () => {
    stopTick();
    video.hidden = true;
    frame.classList.add("st-frame--empty");
  });

  render(ctx.store.getState());

  return {
    update(state, prev) {
      if (state.ui.startError !== prev.ui.startError || state.ui.sending !== prev.ui.sending) render(state);
    },
    destroy() {
      destroyed = true;
      stopTick();
      try {
        video.pause();
      } catch {
        // happy-dom / старі браузери
      }
      root.remove();
    },
  };
}
