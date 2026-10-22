// @ts-check
/**
 * B1 · Стартовий екран (S1, C1, C3, X6) + B2 акаунтів (N3-A).
 *
 * Ліворуч — заголовок, лід і форма (адреса сайту або опис бізнесу + фото) → `submitStart`.
 * Праворуч — приклад ролика 9:16 (`static/media/sample-9x16.mp4`), без файлу — смугастий плейсхолдер.
 * Унизу — легенда таймлайну (C3, усе неактивне).
 *
 * N3-A: шапка — «Увійти» для гостя або контроли акаунта (B3); рядок ціни з «поповнити» при
 * нестачі; K3 за `ui.startShortage`; рядок «Починаю ролик…» за `account.autostart`; рядок-статус
 * після виходу (`account.flash`); «Мої проєкти · N». Відкладений старт підставляється у форму.
 *
 * `update` патчить лише змінене: `<video>`, поля й textarea не перестворюються.
 */
import { SEGMENTS } from "../contracts.js";
import { clear, h, text } from "../dom.js";
import {
  closingPackage,
  creditWord,
  customFor,
  formatCredits,
  formatNumber,
  signed,
} from "../lib/credits.js";
import { peekPending } from "../lib/pending.js";
import { mount as mountAccount } from "./account-controls.js";
import { shortageCard } from "./shortage.js";
import { mountThemeButton } from "./theme-switch.js";

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
const PHOTOS_LOST = "Фото, обрані до входу, не збереглися — додайте їх у чаті через «+ Фото».";

/**
 * K3 на старті (Референс `#n3-402`): пакет, що закриває нестачу, і своя сума.
 * @param {Ctx} ctx
 * @param {{ need: number, have: number }} short
 * @param {UiState["account"]["me"]} me
 * @returns {HTMLElement}
 */
function shortage(ctx, short, me) {
  const missing = Math.max(0, short.need - short.have);
  const pkg = me && me.packages.length > 0 ? closingPackage(me.packages, missing) : null;
  const custom = me ? customFor(missing, me.custom) : missing;
  return shortageCard({
    title: "Не вистачає кредитів",
    need: short.need,
    have: short.have,
    size: "start",
    advice: pkg
      ? `Різницю закриє пакет «${pkg.label}» — ${formatCredits(pkg.credits)}. Після оплати ролик почнеться сам.`
      : "Після оплати ролик почнеться сам.",
    primary: pkg
      ? {
          label: `Поповнити на ${formatNumber(pkg.credits)}`,
          onClick: () => ctx.actions.openTopup({ from: "start", packageId: pkg.id }),
        }
      : { label: "Поповнити", onClick: () => ctx.actions.openTopup({ from: "start" }) },
    secondary: {
      label: `Своя сума · ${formatNumber(custom)}`,
      onClick: () => ctx.actions.openTopup({ from: "start", custom }),
    },
  });
}

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

  // ── Шапка: коло теми (B5) і «Увійти» для гостя, контроли акаунта (B3) для користувача ──
  const loginBtn = h("button", { class: "btn btn--ghost st-login", type: "button", text: "Увійти" });
  const themeHost = h("span", { class: "st-theme" });
  const accountEl = h("div", { class: "st-account" });
  /** @type {ViewHandle | null} */
  let account = null;
  /** @type {ViewHandle | null} */
  let theme = null;
  /** @type {UiState["account"]["meStatus"] | null} */
  let headKind = null;

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
  const submitSpinner = h("span", {
    class: "spinner st-submit__spinner",
    "aria-hidden": "true",
    hidden: true,
  });
  const submitLabel = h("span", { class: "st-submit__label", text: "Почати" });
  const submitBtn = h(
    "button",
    { class: "btn btn--primary btn--lg st-submit", type: "submit" },
    submitSpinner,
    submitLabel,
    h("span", { class: "btn__arrow", "aria-hidden": "true", text: "→" }),
  );
  const errorEl = h("p", { class: "st-error", id: "st-error", role: "alert" });

  const flashText = h("span", { class: "st-flash__text" });
  const flashEl = h(
    "p",
    { class: "st-flash", role: "status", hidden: true },
    h("span", { class: "dot", "aria-hidden": "true" }),
    flashText,
  );

  const priceValue = h("span", { class: "st-price__value" });
  const priceTail = h("span", { class: "st-price__tail" });
  const topupBtn = h("button", { class: "st-link st-price__topup", type: "button", text: "поповнити" });
  const topupPart = h(
    "span",
    { class: "st-price__more" },
    h("span", { "aria-hidden": "true", text: "·" }),
    topupBtn,
  );
  const pricePart = h(
    "span",
    { class: "st-price__head" },
    h("span", {}, "Ролик — ", priceValue),
    h("span", { "aria-hidden": "true", text: "·" }),
  );
  const priceEl = h("p", { class: "st-price", hidden: true }, pricePart, priceTail, topupPart);

  const shortageEl = h("div", { class: "st-shortage", hidden: true });
  /** @type {UiState["ui"]["startShortage"]} */
  let shownShortage = null;
  /** @type {UiState["account"]["me"]} */
  let shortageMe = null;

  const startingHost = h("span", { class: "st-starting__host" });
  const startingMeta = h("span", { class: "st-starting__meta" });
  const startingEl = h(
    "p",
    { class: "st-starting", role: "status", hidden: true },
    startingHost,
    startingMeta,
  );
  const lostEl = h("p", { class: "st-lost", hidden: true, text: PHOTOS_LOST });

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
  const projectsCount = h("span", { class: "st-link__mono" });
  const projectsBtn = h(
    "button",
    { class: "st-link st-projects", type: "button", hidden: true },
    "Мої проєкти ",
    projectsCount,
  );
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
    priceEl,
    shortageEl,
    startingEl,
    lostEl,
    h("div", { class: "st-extras" }, exampleBtn, manualBtn, photosBtn, fileInput, projectsBtn),
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
      accountEl,
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
        flashEl,
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
  function renderHead(state) {
    const status = state.account.meStatus;
    if (status === headKind) return;
    headKind = status;
    const view = account;
    account = null;
    view?.destroy();
    theme?.destroy();
    theme = null;
    clear(accountEl);
    if (status === "anon") {
      theme = mountThemeButton(themeHost, ctx);
      accountEl.append(themeHost, loginBtn);
    } else if (status === "ready") account = mountAccount(accountEl, ctx, { place: "start" });
  }

  /** @param {UiState} state */
  function render(state) {
    const { me, meStatus, autostart, flash, projectCount } = state.account;
    const user = meStatus === "ready" ? me : null;
    const short = state.ui.startShortage;

    // Нестачу показує K3, а не рядок помилки.
    const message = short ? "" : (clientError ?? state.ui.startError ?? "");
    text(errorEl, message);
    errorEl.hidden = !message;
    urlInput.setAttribute("aria-invalid", message ? "true" : "false");

    const busy = pending || state.ui.sending || autostart !== null;
    submitBtn.disabled = busy;
    submitSpinner.hidden = !busy;
    text(submitLabel, autostart ? "Починаю" : "Почати");
    form.setAttribute("aria-busy", busy ? "true" : "false");

    // Рядок-статус після виходу — лише гостю.
    const showFlash = Boolean(flash) && meStatus !== "ready";
    text(flashText, showFlash ? (flash ?? "") : "");
    flashEl.hidden = !showFlash;

    // Рядок ціни (ціни — лише `account.prices`): гість — «правки безкоштовні», користувач — баланс
    // і «поповнити» при нестачі. Цін немає (збій) — рядок без числа; `me` вантажиться — без рядка.
    const { prices } = state.account;
    priceEl.hidden = meStatus === "loading" || autostart !== null;
    pricePart.hidden = !prices;
    if (prices) text(priceValue, formatCredits(prices.video));
    text(priceTail, user ? `у вас ${formatNumber(user.balance)}` : "правки на чекпоінтах безкоштовні");
    topupPart.hidden = !(user && prices && user.balance < prices.video);

    if (short !== shownShortage || (short && me !== shortageMe)) {
      shownShortage = short;
      shortageMe = me;
      clear(shortageEl);
      if (short) shortageEl.append(shortage(ctx, short, me));
      shortageEl.hidden = !short;
    }

    startingEl.hidden = !autostart;
    lostEl.hidden = !autostart?.photosLost;
    if (autostart) {
      text(startingHost, autostart.host ? `Починаю ролик для ${autostart.host}` : "Починаю ролик");
      text(
        startingMeta,
        `· ${signed(-autostart.charged)} ${creditWord(autostart.charged)} · залишок ${formatNumber(autostart.after)}`,
      );
    }

    const count = user ? (projectCount ?? 0) : 0;
    projectsBtn.hidden = count <= 0;
    text(projectsCount, `· ${formatNumber(count)}`);
  }

  /** @param {string | null} message */
  function setClientError(message) {
    if (clientError === message) return;
    clientError = message;
    render(ctx.store.getState());
  }

  /** @param {boolean} open */
  function setManual(open) {
    manualOpen = open;
    manualBox.hidden = !open;
    manualBtn.setAttribute("aria-expanded", String(open));
    text(manualBtn, open ? "Сховати опис" : "Немає сайту? Опишіть бізнес");
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

  // Відкладений старт (гість до входу, нестача до оплати) — назад у форму.
  const saved = ctx.store.getState().account.pending ?? peekPending();
  if (saved?.url) urlInput.value = saved.url;
  if (saved?.manualText) {
    manualText.value = saved.manualText;
    setManual(true);
  }

  // ── Обробники ──
  loginBtn.addEventListener("click", () => {
    ctx.actions.dismissFlash();
    ctx.actions.openAuth("login", "header");
  });

  topupBtn.addEventListener("click", () => ctx.actions.openTopup({ from: "start" }));

  projectsBtn.addEventListener("click", () =>
    ctx.actions.navigate({ route: "cabinet", section: "projects" }),
  );

  exampleBtn.addEventListener("click", () => {
    urlInput.value = EXAMPLE_HOST;
    setClientError(null);
    urlInput.focus();
  });

  manualBtn.addEventListener("click", () => {
    setManual(!manualOpen);
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
    if (pending || state.ui.sending || state.account.autostart) return;
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
      await ctx.actions.submitStart(data);
    } catch (err) {
      // submitStart (B2) кладе помилки в стан і не відхиляє; це — страховка.
      console.error("[start] submitStart", err);
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

  renderHead(ctx.store.getState());
  render(ctx.store.getState());

  return {
    update(state, prev) {
      renderHead(state);
      account?.update(state, prev);
      if (state.ui !== prev.ui || state.account !== prev.account) render(state);
    },
    destroy() {
      destroyed = true;
      stopTick();
      try {
        video.pause();
      } catch {
        // happy-dom / старі браузери
      }
      account?.destroy();
      account = null;
      theme?.destroy();
      theme = null;
      root.remove();
    },
  };
}
