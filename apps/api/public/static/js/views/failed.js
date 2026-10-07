// @ts-check
/**
 * B5 · Сцена: помилка (X4).
 *
 * Eyebrow `--danger` з точкою — «Помилка · етап <ErrorEvent.stage>», заголовок «Щось пішло не так»,
 * лід — `ErrorEvent.message` + підказка, що повідомлення збережуться. «Спробувати ще раз» →
 * `actions.retry` (лише коли помилка `retryable`), «Новий проєкт» → `actions.newProject`.
 */
import { h, text } from "../dom.js";

/** @typedef {import("../contracts.js").UiState} UiState */

/** Підказка під текстом помилки (X4; = `failedHint` бекенду без згадки кнопки). */
export const FAILED_HINT =
  "Повідомлення, які ви надішлете зараз, я збережу й врахую на наступному погодженні.";
/** Текст, якщо `state.error` немає (напр., стан відновлено без error-події). */
const FALLBACK_MESSAGE = "Етап завершився з помилкою.";

/**
 * «Помилка · етап codegen».
 * @param {UiState["error"]} error
 */
export function failedEyebrow(error) {
  return error?.stage ? `Помилка · етап ${error.stage}` : "Помилка";
}

/**
 * Перша літера велика, у кінці — крапка: «модель не відповіла вчасно» → «Модель не відповіла вчасно.»
 * @param {string} message
 */
export function failedMessage(message) {
  const s = message.trim();
  if (!s) return FALLBACK_MESSAGE;
  const cap = s.charAt(0).toLocaleUpperCase("uk") + s.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const eyebrowText = h("span");
  const message = h("span", { class: "sp-failed__message" });
  let pending = false;

  const retry = h("button", {
    class: "btn btn--primary",
    type: "button",
    "data-action": "retry",
    text: "Спробувати ще раз",
    onclick: async () => {
      if (pending) return;
      pending = true;
      retry.disabled = true;
      try {
        await ctx.actions.retry();
      } catch (err) {
        console.error("[failed] retry", err);
      } finally {
        pending = false;
        if (root.isConnected) retry.disabled = false;
      }
    },
  });
  const fresh = h("button", {
    class: "btn btn--ghost",
    type: "button",
    "data-action": "new-project",
    text: "Новий проєкт",
    onclick: () => ctx.actions.newProject(),
  });

  const root = h(
    "div",
    { class: "sp sp-failed adc-enter", "data-view": "failed", role: "alert" },
    h(
      "div",
      { class: "eyebrow sp-failed__eyebrow" },
      h("span", { class: "dot dot--danger", "aria-hidden": "true" }),
      eyebrowText,
    ),
    h("h1", { class: "display-l sp-title", text: "Щось пішло не так" }),
    h("p", { class: "sp-failed__lead" }, message, " ", FAILED_HINT),
    h("div", { class: "sp-failed__actions" }, retry, fresh),
  );
  el.append(root);

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    if (prev && state.error === prev.error) return;
    const error = state.error;
    text(eyebrowText, failedEyebrow(error));
    text(message, failedMessage(error?.message ?? ""));
    // Без error-події (невідомо) кнопку лишаємо: бекенд сам відповість, якщо повтор неможливий.
    const canRetry = error ? error.retryable : true;
    retry.hidden = !canRetry;
    fresh.className = canRetry ? "btn btn--ghost" : "btn btn--primary";
  }

  render(ctx.store.getState(), null);

  return {
    update: (state, prev) => render(state, prev),
    destroy() {
      root.remove();
    },
  };
}
