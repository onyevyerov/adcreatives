// @ts-check
/**
 * B8 · Тестова оплата (N10-A, екран-чек `/?checkout=<id>`).
 *
 * Шапка 76px як на старті: вордмарк + контроли акаунта (B3, `place: "start"`). Під нею — колонка
 * 560 по центру: пунктирна мітка «Тестова оплата», сума (eyebrow · число · лід · мета), рядок
 * автоповернення на старт, дії через лінію і примітка-заглушка. Тексти — з Референсу дослівно.
 * Стан `error` (мережа / 5xx на `GET topup`) у Референсі кадру не має: побудований як `notfound`,
 * з червоною крапкою «з'єднання втрачено» (N15 `n15-net`) і «Спробувати ще раз».
 *
 * Модель екрана — `checkoutModel(state)` (чиста функція); `update` патчить вузли на місці, тож
 * фокус лишається на кнопці, поки чек іде pending → confirming → paid.
 */

import { BRAND_NAME } from "../contracts.js";
import { hostOf, NETWORK_MESSAGE } from "../data/api.js";
import { h, text } from "../dom.js";
import { creditWord, formatCredits, formatNumber } from "../lib/credits.js";
import { peekPending } from "../lib/pending.js";
import { mount as mountAccount } from "./account-controls.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {"pay" | "cancel" | "return" | "again"} Act */
/**
 * @typedef {{ label: string, act: Act, disabled: boolean, spin: boolean, arrow: boolean }} Button
 * @typedef {{
 *   kind: "loading" | "main" | "notfound" | "error",
 *   eyebrow: string, title: string, big: string, word: string, lead: string, meta: string,
 *   auto: string | null, primary: Button | null, secondary: Button | null, foot: boolean
 * }} Model
 */

export const LOADING_TEXT = "Завантажую поповнення…";
export const FOOT_TEXT = "Це крок-заглушка: справжнього платіжного провайдера ще немає.";
export const NOT_FOUND_TITLE = "Поповнення не знайдено";
export const NOT_FOUND_LEAD = "Перевірте посилання або почніть поповнення з кабінету.";
/** Мітка як у чаті при `conn: "lost"` (N15 `n15-net`). */
export const ERROR_EYEBROW = "З'єднання втрачено";
export const ERROR_TITLE = "Поповнення не завантажилось";
export const ERROR_LEAD = NETWORK_MESSAGE;
const FAILED_LEAD = "Кредити не зараховано. Можна спробувати ще раз — я створю нове поповнення.";

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * ISO → «19.10 11:20» за місцевим часом.
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function formatAt(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Рядок автоповернення: «… ролик для host почнеться сам…», якщо відкладений старт має адресу.
 * @param {UiState} state
 */
function autoText(state) {
  const pending = state.account.pending ?? peekPending();
  if (!pending) return "Повертаю на старт…";
  const host = hostOf(pending.url);
  return host
    ? `Повертаю на старт — ролик для ${host} почнеться сам…`
    : "Повертаю на старт — ролик почнеться сам…";
}

/**
 * @param {string} label
 * @param {Act} act
 * @param {Partial<Button>} [o]
 * @returns {Button}
 */
const button = (label, act, o = {}) => ({ label, act, disabled: false, spin: false, arrow: false, ...o });

/**
 * Що показати для стану (Референс `#N10`, `AcCheckout`).
 * @param {UiState} state
 * @returns {Model}
 */
export function checkoutModel(state) {
  /** @type {Model} */
  const m = {
    kind: "loading",
    eyebrow: "",
    title: "",
    big: "",
    word: "",
    lead: "",
    meta: "",
    auto: null,
    primary: null,
    secondary: null,
    foot: false,
  };
  const co = state.checkout;
  if (!co || co.status === "loading") return m;
  if (co.status === "error") {
    return {
      ...m,
      kind: "error",
      eyebrow: ERROR_EYEBROW,
      title: ERROR_TITLE,
      lead: ERROR_LEAD,
      meta: `поповнення ${co.id}`,
      primary: button("Спробувати ще раз", "again"),
      secondary: button(co.returnTo.kind === "project" ? "До проєкту" : "До кабінету", "return"),
    };
  }
  if (co.status === "notfound" || !co.topup) {
    return {
      ...m,
      kind: "notfound",
      eyebrow: `Поповнення · ${co.id}`,
      title: NOT_FOUND_TITLE,
      lead: NOT_FOUND_LEAD,
      primary: button("До кабінету", "return", { arrow: true }),
    };
  }
  const t = co.topup;
  const pkg = state.account.me?.packages.find((p) => p.id === t.packageId);
  const name = t.packageId === "custom" ? "Своя сума" : `Пакет «${pkg?.label ?? t.packageId}»`;
  const back = co.returnTo.kind;
  Object.assign(m, {
    kind: "main",
    big: formatNumber(t.credits),
    word: creditWord(t.credits),
    meta: `поповнення ${co.id} · створено ${formatAt(t.createdAt)}`,
  });

  if (co.status === "pending" || co.status === "confirming") {
    const busy = co.status === "confirming";
    return {
      ...m,
      eyebrow: "До сплати",
      lead: `${name}. Кредити зарахую одразу після підтвердження.`,
      primary: button(busy ? "Підтверджую…" : "Оплатити", "pay", {
        disabled: busy,
        spin: busy,
        arrow: !busy,
      }),
      secondary: button("Скасувати", "cancel", { disabled: busy }),
      foot: !busy,
    };
  }

  if (co.status === "paid") {
    const paidAt = formatAt(t.paidAt);
    const balance = state.account.me?.balance ?? 0;
    return {
      ...m,
      eyebrow: co.revisit ? (paidAt ? `Уже оплачено · ${paidAt}` : "Уже оплачено") : "Зараховано",
      big: `+${formatNumber(t.credits)}`,
      lead: `Зараховано ${formatCredits(t.credits)}. Баланс: ${formatNumber(balance)}.`,
      meta: co.revisit ? `повторне відкриття — другого зарахування немає · ${co.id}` : m.meta,
      auto: back === "start" && !co.revisit ? autoText(state) : null,
      primary:
        back === "start" && !co.revisit
          ? null
          : back === "project" && !co.revisit
            ? button("Повернутися до проєкту", "return", { arrow: true })
            : button("До кабінету", "return", { arrow: true }),
    };
  }

  // failed — сервер не ставить paidAt скасованому, тож дата лише якщо вона є.
  const at = formatAt(t.paidAt);
  return {
    ...m,
    eyebrow: co.revisit && at ? `Оплату скасовано · ${at}` : "Оплату скасовано",
    big: "0",
    word: "зараховано",
    lead: FAILED_LEAD,
    primary: button("Спробувати ще раз", "again", { arrow: true }),
    secondary: button(back === "project" ? "До проєкту" : "До кабінету", "return"),
  };
}

/**
 * Кнопка, яку `update` патчить на місці (той самий вузол → фокус не губиться).
 * @param {"primary" | "ghost"} kind
 * @param {(act: Act) => void} onAct
 */
function actionButton(kind, onAct) {
  const spinner = h("span", { class: "spinner co-btn__spinner", "aria-hidden": "true", hidden: true });
  const label = h("span", { class: "co-btn__label" });
  const arrow = h("span", { class: "co-btn__arrow", "aria-hidden": "true", text: "→", hidden: true });
  /** @type {Act | null} */
  let act = null;
  const el = h(
    "button",
    {
      class: `btn btn--${kind} btn--lg co-btn`,
      type: "button",
      onclick: () => {
        if (act) onAct(act);
      },
    },
    spinner,
    label,
    arrow,
  );
  return {
    el,
    /** @param {Button | null} b */
    set(b) {
      el.hidden = !b;
      if (!b) return;
      act = b.act;
      text(label, b.label);
      el.disabled = b.disabled;
      spinner.hidden = !b.spin;
      arrow.hidden = !b.arrow;
    },
  };
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  /** @param {Act} act */
  const onAct = (act) => {
    const a = ctx.actions;
    if (act === "pay") void a.confirmCheckout("paid");
    else if (act === "cancel") void a.confirmCheckout("failed");
    else if (act === "again") void a.checkoutAgain();
    else a.checkoutReturn();
  };

  const accountEl = h("div", { class: "co-account" });
  const home = h("a", {
    class: "wordmark",
    href: "/",
    text: BRAND_NAME,
    onclick: (/** @type {MouseEvent} */ e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      ctx.actions.navigate({ route: "start" });
    },
  });

  const loadingEl = h(
    "p",
    { class: "co-loading", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    LOADING_TEXT,
  );

  const eyebrowDot = h("span", { class: "dot dot--danger", "aria-hidden": "true", hidden: true });
  const eyebrowLabel = h("span", {});
  const eyebrowEl = h("span", { class: "co-eyebrow" }, eyebrowDot, eyebrowLabel);
  const bigEl = h("span", { class: "co-num" });
  const wordEl = h("span", { class: "co-word" });
  const amountEl = h("span", { class: "co-amount" }, bigEl, wordEl);
  const titleEl = h("h1", { class: "co-title" });
  const leadEl = h("p", { class: "co-lead" });
  const metaEl = h("span", { class: "co-meta" });
  const sumEl = h("div", { class: "co-sum" }, eyebrowEl, amountEl, titleEl, leadEl, metaEl);

  const autoLabel = h("span", {});
  const autoEl = h(
    "p",
    { class: "co-auto", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    autoLabel,
  );

  const primary = actionButton("primary", onAct);
  const secondary = actionButton("ghost", onAct);
  const actionsEl = h("div", { class: "co-actions" }, primary.el, secondary.el);
  const footEl = h("p", { class: "co-foot", text: FOOT_TEXT });

  const root = h(
    "div",
    { class: "co", "data-view": "checkout" },
    h("header", { class: "co-head" }, home, accountEl),
    h(
      "main",
      { class: "co-body" },
      h(
        "section",
        { class: "co-card", "aria-label": "Тестова оплата" },
        h(
          "div",
          { class: "co-top" },
          h("span", { class: "co-tag", text: "Тестова оплата · гроші не списуються" }),
        ),
        loadingEl,
        sumEl,
        autoEl,
        actionsEl,
        footEl,
      ),
    ),
  );
  el.append(root);

  /** @type {ViewHandle | null} */
  const account = mountAccount(accountEl, ctx, { place: "start" });

  /** @param {UiState} state */
  function render(state) {
    const m = checkoutModel(state);
    root.dataset.status = state.checkout?.status ?? "loading";
    loadingEl.hidden = m.kind !== "loading";
    sumEl.hidden = m.kind === "loading";
    // Як K3: помилку оголошує role="alert"; інші стани — без ролі.
    if (m.kind === "error") sumEl.setAttribute("role", "alert");
    else sumEl.removeAttribute("role");
    amountEl.hidden = m.kind !== "main";
    metaEl.hidden = m.kind !== "main" && m.kind !== "error";
    titleEl.hidden = !m.title;
    eyebrowDot.hidden = m.kind !== "error";
    text(eyebrowLabel, m.eyebrow);
    text(titleEl, m.title);
    text(bigEl, m.big);
    text(wordEl, m.word);
    text(leadEl, m.lead);
    text(metaEl, m.meta);
    autoEl.hidden = !m.auto;
    text(autoLabel, m.auto);
    primary.set(m.primary);
    secondary.set(m.secondary);
    actionsEl.hidden = !m.primary && !m.secondary;
    footEl.hidden = !m.foot;
  }

  render(ctx.store.getState());

  return {
    update(state, prev) {
      if (
        state.checkout !== prev.checkout ||
        state.account.me !== prev.account.me ||
        state.account.pending !== prev.account.pending
      )
        render(state);
      account?.update(state, prev);
    },
    destroy() {
      account?.destroy();
      root.remove();
    },
  };
}
