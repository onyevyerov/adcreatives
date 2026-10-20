// @ts-check
/**
 * B4 · Композер (C5) + рядок `ui.notice` (помилка дії) над ним.
 *
 * - Enter / ⌘+Enter / Ctrl+Enter — надіслати, Shift+Enter — новий рядок (IME-набір не чіпаємо);
 * - висота 1–5 рядків за вмістом (JS-автовисота + `max-height` у chat.css);
 * - плейсхолдер за статусом (C5), після «Правки» (`ui.editing`) — «Опишіть, що змінити» + рамка
 *   `--ink` і фокус у полі;
 * - чернетка: введення → `actions.setDraft`; зовнішня зміна `ui.draft` переноситься в поле лише
 *   коли відрізняється від його значення (textarea не перестворюється, курсор зберігається).
 *
 * B5 · ціна правки (N5-A): після видачі підказка «↵ надіслати · правка — 3 кредити»; якщо
 * балансу не вистачає — «правка — 3 кредити, у вас 2» кольором --ink. Лише інформує:
 * надсилання не блокується за будь-якого балансу. Ціна — лише `account.prices`.
 */
import { AWAITING } from "../contracts.js";
import { h, text } from "../dom.js";
import { formatCredits, formatNumber } from "../lib/credits.js";

/** @typedef {import("../contracts.js").UiState} UiState */

/** Максимум рядків до появи прокрутки. */
export const MAX_ROWS = 5;

export const PLACEHOLDERS = {
  editing: "Опишіть, що змінити",
  awaiting: "Відповідь, питання або правки",
  delivered: "Напишіть правку — зроблю нову ревізію",
  busy: "Можна писати — врахую на наступному погодженні",
};

/**
 * Плейсхолдер поля за станом (C5). failed — як busy: повідомлення збережуться до повтору (X4).
 * @param {Pick<UiState, "status" | "ui">} state
 * @returns {string}
 */
export function placeholderFor(state) {
  if (state.ui.editing) return PLACEHOLDERS.editing;
  if (AWAITING.includes(state.status)) return PLACEHOLDERS.awaiting;
  if (state.status === "delivered") return PLACEHOLDERS.delivered;
  return PLACEHOLDERS.busy;
}

/**
 * Підказка ціни правки після видачі (N5-A); `null` — не видано або цін немає.
 * `short` — баланс відомий і менший за ціну правки.
 * @param {Pick<UiState, "status" | "account">} state
 * @returns {{ text: string, short: boolean } | null}
 */
export function revisionHint(state) {
  const prices = state.account.prices;
  if (state.status !== "delivered" || !prices) return null;
  const price = `правка — ${formatCredits(prices.revision)}`;
  const balance = state.account.me?.balance ?? null;
  const short = balance !== null && balance < prices.revision;
  return short ? { text: `${price}, у вас ${formatNumber(balance)}`, short } : { text: price, short };
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;
  const notice = h("div", { class: "ch-notice", role: "alert", hidden: true });
  const input = h("textarea", {
    class: "ch-composer__input",
    rows: 1,
    "aria-label": "Повідомлення",
    autocomplete: "off",
  });
  const file = h("input", {
    type: "file",
    multiple: true,
    accept: "image/*,.heic,.heif",
    hidden: true,
    tabindex: "-1",
  });
  const photo = h("button", { type: "button", class: "btn btn--tag", text: "+ Фото" });
  const price = h("span", { class: "cmp-price" });
  const priceSep = h("span", { "aria-hidden": "true", text: " · " });
  const priceWrap = h("span", { hidden: true }, priceSep, price);
  const send = h("button", {
    type: "submit",
    class: "btn-round",
    "aria-label": "Надіслати",
    title: "Надіслати (Enter)",
    text: "↑",
  });
  const form = h(
    "form",
    { class: "ch-composer", novalidate: true },
    input,
    h(
      "div",
      { class: "ch-composer__bar" },
      photo,
      file,
      h(
        "span",
        { class: "ch-composer__send" },
        h(
          "span",
          { class: "ch-composer__hint cmp-hint" },
          h("span", { "aria-hidden": "true", text: "↵ надіслати" }),
          priceWrap,
        ),
        send,
      ),
    ),
  );
  const root = h("div", { class: "ch-compose" }, notice, form);
  el.append(root);

  let state = ctx.store.getState();

  function grow() {
    input.style.height = "auto";
    const sh = input.scrollHeight;
    if (sh > 0) input.style.height = `${sh}px`;
    else input.style.removeProperty("height");
  }

  function syncSend() {
    send.disabled = input.value.trim() === "" || state.ui.sending;
  }

  /** @param {UiState} s @param {UiState | null} prev */
  function render(s, prev) {
    state = s;
    const ph = placeholderFor(s);
    if (input.placeholder !== ph) input.placeholder = ph;
    form.classList.toggle("ch-composer--editing", s.ui.editing);
    form.setAttribute("aria-busy", String(s.ui.sending));

    if (s.ui.draft !== input.value && (!prev || s.ui.draft !== prev.ui.draft)) {
      const focused = document.activeElement === input;
      const caret = input.selectionStart ?? s.ui.draft.length;
      input.value = s.ui.draft;
      if (focused) {
        const pos = Math.min(caret, input.value.length);
        input.setSelectionRange(pos, pos);
      }
      grow();
    }

    const hint = revisionHint(s);
    text(price, hint?.text ?? "");
    price.classList.toggle("cmp-price--short", hint?.short ?? false);
    priceWrap.hidden = !hint;

    text(notice, s.ui.notice ?? "");
    notice.hidden = !s.ui.notice;
    syncSend();

    if (prev && s.ui.editing && !prev.ui.editing) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }

  async function submit() {
    const value = input.value.trim();
    if (!value || state.ui.sending) return;
    send.disabled = true;
    let ok = false;
    try {
      ok = await actions.sendMessage(value);
    } catch (err) {
      console.error("[composer] sendMessage", err);
    }
    if (ok && input.value.trim() === value) {
      input.value = "";
      grow();
      if (ctx.store.getState().ui.draft !== "") actions.setDraft("");
    }
    syncSend();
  }

  input.addEventListener("input", () => {
    grow();
    syncSend();
    actions.setDraft(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void submit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  photo.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const files = Array.from(file.files ?? []);
    file.value = "";
    if (files.length > 0)
      actions.uploadPhotos(files).catch((err) => console.error("[composer] uploadPhotos", err));
  });

  input.value = state.ui.draft;
  render(state, null);
  grow();

  return {
    update(next, prev) {
      render(next, prev);
    },
    destroy() {
      root.remove();
    },
  };
}
