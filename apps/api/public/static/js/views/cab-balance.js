// @ts-check
/**
 * B7 · Кабінет · баланс і поповнення (N8-B, N9-A).
 *
 * Заголовок «Баланс і поповнення»; банер повернення (`cabinet.backTo`: старт — «ролик для host
 * почнеться сам», проєкт з `retry` — «натисніть «Повторити» в чаті»); баланс великим числом і
 * праворуч «вистачить на…», ціни, вітальний бонус (запис `bonus` в уже завантаженій історії);
 * на нулі — рядок-заклик. Незавершені поповнення — «Продовжити оплату». Форма: тайли пакетів
 * (`role="radio"`, ←/→ між ними) + тайл «Своя сума» з полем, помилки своєї суми — три тексти,
 * «Поповнити на N кредитів →» і примітка про тестову оплату.
 * DOM будується один раз: поле своєї суми не перестворюється (фокус і каретка лишаються).
 */

import { customError, selectedCredits, selectedPackage } from "../data/topup-actions.js";
import { h, text } from "../dom.js";
import { closingPackage, creditWord, enoughFor, formatCredits, formatNumber } from "../lib/credits.js";
import { peekPending } from "../lib/pending.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Me} Me */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").CreditPrices} CreditPrices */
/** @typedef {import("../contracts.js").TopUp} TopUp */
/** @typedef {import("../data/topup-actions.js").CustomError} CustomError */

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** «14.10.2026» (локальна дата). @param {string} iso */
export function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** «19.10 11:20» (локальний час). @param {string} iso */
export function formatStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * «вистачить на 1 ролик або 4 правки» / «не вистачить ні на ролик, ні на правку».
 * @param {number} n
 * @param {CreditPrices} prices
 */
export function enoughLine(n, prices) {
  const s = enoughFor(n, prices);
  return s.startsWith("ні на ролик") ? `не вистачить ${s}` : `вистачить на ${s}`;
}

/**
 * Текст помилки своєї суми (копірайт Референсу N9).
 * @param {CustomError} err
 * @param {{ min: number, max: number }} c
 */
export function customErrorText(err, c) {
  if (err === "empty") return `Вкажіть кількість кредитів — від ${c.min} до ${c.max}.`;
  if (err === "integer") return `Лише ціле число кредитів — від ${c.min} до ${c.max}.`;
  return `Від ${c.min} до ${c.max} кредитів.`;
}

/**
 * Хост відкладеного старту для банера «поверну на старт».
 * @param {UiState} s
 * @returns {string | null}
 */
function pendingHost(s) {
  const url = (s.account.pending ?? peekPending())?.url;
  if (!url) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Текст банера повернення; `null` — без банера.
 * @param {UiState} s
 * @returns {string | null}
 */
export function returnText(s) {
  const to = s.cabinet.backTo;
  if (to?.kind === "start") {
    const host = pendingHost(s);
    return host
      ? `Після оплати поверну на старт — ролик для ${host} почнеться сам.`
      : "Після оплати поверну на старт — ролик почнеться сам.";
  }
  if (to?.kind === "project" && to.retry)
    return `Після оплати поверну до ${to.host ?? "проєкту"} — натисніть «Повторити» в чаті.`;
  return null;
}

/**
 * Пакет, що закриває різницю (лише при поверненні на старт: нестача на ролик).
 * @param {UiState} s
 * @returns {string | null}
 */
export function recommendedId(s) {
  const me = s.account.me;
  if (s.cabinet.backTo?.kind !== "start" || !me || me.packages.length === 0) return null;
  const prices = s.account.prices ?? me.prices;
  const short = prices.video - me.balance;
  return short > 0 ? closingPackage(me.packages, short).id : null;
}

/** Вітальний бонус з уже завантаженої історії. @param {UiState} s */
const bonusOf = (s) => s.cabinet.history.entries.find((e) => e.kind === "bonus")?.credits ?? 0;

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  // ───── шапка: банер і баланс ─────
  const bannerText = h("span");
  const banner = h(
    "div",
    { class: "cab-bal__return" },
    h("span", { class: "cab-bal__diamond", "aria-hidden": "true" }),
    bannerText,
  );
  const num = h("span", { class: "cab-bal__num" });
  const word = h("span", { class: "cab-bal__word" });
  const enough = h("span");
  const priceLine = h("span", { class: "cab-bal__muted" });
  const bonus = h("span", { class: "cab-bal__muted" });
  const head = h(
    "div",
    { class: "cab-bal__head" },
    h(
      "div",
      { class: "cab-bal__now" },
      h("span", { class: "label-s", text: "Баланс" }),
      h("span", { class: "cab-bal__amount" }, num, word),
    ),
    h("div", { class: "cab-bal__facts" }, enough, priceLine, bonus),
  );
  const zero = h("p", { class: "cab-bal__zero", text: "Поповніть баланс, щоб зробити перший ролик." });
  const pendingBox = h("div", { class: "cab-bal__pending", hidden: true });

  // ───── форма поповнення ─────
  const group = h("div", { class: "cab-tu__tiles", role: "radiogroup", "aria-label": "Пакет" });
  const input = h("input", {
    class: "cab-tu__input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    "aria-label": "Кількість кредитів",
    oninput: () => actions.setCustom(input.value),
    onfocus: () => {
      if (ctx.store.getState().cabinet.topup.mode !== "custom") actions.selectPackage("custom");
    },
  });
  const hint = h("span", { class: "cab-tu__foot" });
  const customTile = h(
    "div",
    {
      class: "cab-tu__tile cab-tu__tile--custom",
      role: "radio",
      onclick: (/** @type {MouseEvent} */ e) => {
        if (ctx.store.getState().cabinet.topup.mode !== "custom") actions.selectPackage("custom");
        if (e.target !== input) input.focus();
      },
    },
    h("span", { class: "cab-tu__label", text: "Своя сума" }),
    h("label", { class: "cab-tu__field" }, input),
    hint,
  );
  group.append(customTile);
  const error = h("p", { class: "cab-tu__error", role: "alert" });
  const spinner = h("span", { class: "spinner cab-tu__spinner", "aria-hidden": "true" });
  const submitLabel = h("span");
  const submit = h(
    "button",
    { type: "submit", class: "btn btn--primary cab-tu__submit" },
    spinner,
    submitLabel,
    h("span", { "aria-hidden": "true", text: "→" }),
  );
  const form = h(
    "form",
    {
      class: "cab-tu",
      novalidate: true,
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        void actions.submitTopup();
      },
    },
    h("span", { class: "label-s", text: "Поповнити" }),
    group,
    error,
    h(
      "div",
      { class: "cab-tu__actions" },
      submit,
      h("span", { class: "cab-tu__note", text: "тестова оплата — гроші не списуються" }),
    ),
  );

  const root = h(
    "section",
    { class: "cab-bal", "aria-labelledby": "cab-bal-title" },
    h("h1", { class: "display-m cab-bal__title", id: "cab-bal-title", text: "Баланс і поповнення" }),
    banner,
    head,
    zero,
    pendingBox,
    form,
  );
  el.append(root);

  /** @type {{ key: string, tiles: { id: string, button: HTMLButtonElement, check: HTMLSpanElement, enough: HTMLSpanElement, rec: HTMLSpanElement }[] }} */
  let built = { key: "", tiles: [] };

  /** Тайли перебудовуються лише при зміні списку пакетів. @param {Me} me */
  function buildTiles(me) {
    const key = me.packages.map((p) => `${p.id}:${p.credits}:${p.label}`).join("|");
    if (key === built.key) return;
    for (const t of built.tiles) t.button.remove();
    built = {
      key,
      tiles: me.packages.map((p) => {
        const check = h("span", { class: "cab-tu__check", "aria-hidden": "true", text: "✓" });
        const enoughEl = h("span");
        const rec = h("span", { class: "cab-tu__rec", text: "закриє різницю" });
        const button = h(
          "button",
          {
            type: "button",
            class: "cab-tu__tile",
            role: "radio",
            "data-package": p.id,
            onclick: () => actions.selectPackage(p.id),
          },
          h("span", { class: "cab-tu__label", text: p.label }),
          check,
          h(
            "span",
            { class: "cab-tu__amount" },
            h("span", { class: "cab-tu__num", text: formatNumber(p.credits) }),
            h("span", { class: "cab-tu__word", text: creditWord(p.credits) }),
          ),
          h("span", { class: "cab-tu__foot" }, enoughEl, rec),
        );
        return { id: p.id, button, check, enough: enoughEl, rec };
      }),
    };
    group.prepend(...built.tiles.map((t) => t.button));
  }

  // ←/→/↑/↓ між тайлами (radiogroup): фокус і вибір переходять разом.
  group.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const step = keys[/** @type {keyof typeof keys} */ (e.key)];
    if (!step || e.target === input) return;
    /** @type {HTMLElement[]} */
    const radios = [...built.tiles.map((t) => t.button), customTile];
    const at = radios.indexOf(/** @type {HTMLElement} */ (e.target));
    if (at < 0) return;
    e.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    if (!next) return;
    if (next === customTile) {
      actions.selectPackage("custom");
      input.focus();
    } else {
      const id = next.getAttribute("data-package");
      if (id) actions.selectPackage(id);
      next.focus();
    }
  });

  /** @param {UiState} s */
  function render(s) {
    const me = s.account.me;
    if (!me) return;
    const prices = s.account.prices ?? me.prices;
    const t = s.cabinet.topup;

    const ret = returnText(s);
    banner.hidden = ret === null;
    text(bannerText, ret ?? "");

    text(num, formatNumber(me.balance));
    text(word, creditWord(me.balance));
    text(enough, enoughLine(me.balance, prices));
    text(
      priceLine,
      `ролик ${formatNumber(prices.video)} · правка ${formatNumber(prices.revision)} · додатковий формат +${formatNumber(prices.extraFormat)}`,
    );
    const b = bonusOf(s);
    bonus.hidden = b <= 0;
    text(bonus, b > 0 ? `+${formatNumber(b)} · вітальний бонус, ${formatDate(me.user.createdAt)}` : "");
    zero.hidden = me.balance !== 0;

    renderPending(s.cabinet.pendingTopups, me.packages);

    // Тайли пакетів.
    buildTiles(me);
    const sel = selectedPackage(t, me.packages);
    const rec = recommendedId(s);
    for (const tile of built.tiles) {
      const on = sel?.id === tile.id;
      tile.button.setAttribute("aria-checked", String(on));
      tile.button.tabIndex = on || (!sel && t.mode !== "custom" && tile === built.tiles[0]) ? 0 : -1;
      tile.check.hidden = !on;
      const pkg = me.packages.find((p) => p.id === tile.id);
      text(tile.enough, pkg ? enoughFor(pkg.credits, prices) : "");
      tile.rec.hidden = rec !== tile.id;
    }

    // Своя сума.
    const custom = t.mode === "custom";
    const err = customError(t.custom, me.custom);
    const shown = custom && t.error ? err : null;
    customTile.setAttribute("aria-checked", String(custom));
    customTile.classList.toggle("is-error", shown !== null);
    if (input.value !== t.custom) input.value = t.custom;
    input.placeholder = `${me.custom.min}–${me.custom.max}`;
    input.setAttribute("aria-invalid", String(shown !== null));
    hint.classList.toggle("is-error", shown !== null);
    hint.classList.toggle("is-ok", shown === null && err === null);
    text(
      hint,
      shown !== null
        ? `від ${me.custom.min} до ${me.custom.max}, лише ціле`
        : err === null
          ? `= ${enoughFor(Number(t.custom.trim()), prices)}`
          : `від ${me.custom.min} до ${me.custom.max} кредитів`,
    );
    error.hidden = shown === null;
    text(error, shown !== null ? customErrorText(shown, me.custom) : "");

    // Відправка.
    const credits = selectedCredits(t, me);
    text(submitLabel, credits !== null ? `Поповнити на ${formatCredits(credits)}` : "Поповнити");
    submit.disabled = t.busy;
    submit.setAttribute("aria-busy", String(t.busy));
    spinner.hidden = !t.busy;
  }

  let pendingKey = "";
  /** @param {TopUp[]} list @param {CreditPackage[]} packages */
  function renderPending(list, packages) {
    const key = list.map((p) => `${p.id}:${p.credits}:${p.packageId}`).join("|");
    if (key === pendingKey) return;
    pendingKey = key;
    pendingBox.hidden = list.length === 0;
    pendingBox.replaceChildren(
      ...list.map((p) => {
        const label = packages.find((k) => k.id === p.packageId)?.label ?? "своя сума";
        return h(
          "div",
          { class: "cab-bal__pending-row" },
          h(
            "span",
            { class: "cab-bal__pending-text" },
            h(
              "span",
              { class: "cab-bal__pending-title" },
              h("span", { class: "dot dot--accent", "aria-hidden": "true" }),
              `Незавершене поповнення · ${label}`,
            ),
            h("span", {
              class: "cab-bal__pending-meta",
              text: `${formatCredits(p.credits)} · створено ${formatStamp(p.createdAt)} · ${p.id}`,
            }),
          ),
          h("button", {
            type: "button",
            class: "btn btn--sm btn--ghost-ink cab-bal__continue",
            text: "Продовжити оплату",
            onclick: () => actions.continueTopup(p.id),
          }),
        );
      }),
    );
  }

  render(ctx.store.getState());

  return {
    update: (s) => render(s),
    destroy: () => root.remove(),
  };
}
