// @ts-check
/**
 * B12 · Системні стани в сцені (N15-B): 401 / 404 / 403 у манері X4 — чат лишається, нових
 * поверхонь немає.
 *
 * - `mount` обслуговує обидва екрани сцени `session` і `notfound` (app.js перемонтовує view при
 *   зміні екрана): `session: "401"` → форма входу з views/auth.js (`layout: "stage"`, той самий
 *   стан `auth` login/session; відновлення після входу робить B1); `session: "404"` → «Проєкт не
 *   знайдено» з «Мої проєкти» / «Новий проєкт».
 * - `mountForbidden` — екран 403 для адмінки (`admin.js` викликає при `admin.forbidden`).
 * - `emptyChatText` — текст порожнього чату для 404 (`chat.js` показує, якщо не `null`).
 */
import { h, text } from "../dom.js";
import { viewFor } from "../view.js";
import { mountAuthForm } from "./auth.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */

/** Порожній чат проєкту, якого немає (404). */
export const NOT_FOUND_CHAT = "Тут з'явиться діалог, коли ви відкриєте свій проєкт.";

/**
 * Текст порожнього чату для системного стану (404) або `null`; `chat.js` (B6) показує його.
 * @param {Pick<UiState, "session">} state
 * @returns {string | null}
 */
export function emptyChatText(state) {
  return state.session === "404" ? NOT_FOUND_CHAT : null;
}

/** «Проєкт · p_7Hk2mQ9x». @param {string | null} projectId */
export function notFoundEyebrow(projectId) {
  return projectId ? `Проєкт · ${projectId}` : "Проєкт";
}

/**
 * Дві кнопки X4: primary і ghost (40px).
 * @param {[string, string, () => void]} primary [action, підпис, клік]
 * @param {[string, string, () => void]} ghost
 */
function actionsRow(primary, ghost) {
  /** @param {string} cls @param {[string, string, () => void]} b */
  const button = (cls, [action, label, onclick]) =>
    h("button", { class: `btn ${cls}`, type: "button", "data-action": action, text: label, onclick });
  return h("div", { class: "ss-actions" }, button("btn--primary", primary), button("btn--ghost", ghost));
}

/**
 * 401: форма входу в сцені (B1). Контейнер — як X4 (padding 44 · max-width 640).
 * @param {HTMLElement} el
 * @param {Ctx} ctx
 * @returns {ViewHandle}
 */
function mountLogin(el, ctx) {
  const root = h("div", { class: "ss ss-login adc-enter", "data-view": "session" });
  el.append(root);
  const form = mountAuthForm(root, ctx, { layout: "stage" });
  return {
    update: (state, prev) => form.update(state, prev),
    destroy() {
      form.destroy();
      root.remove();
    },
  };
}

/**
 * 404: «Проєкт не знайдено».
 * @param {HTMLElement} el
 * @param {Ctx} ctx
 * @returns {ViewHandle}
 */
function mountNotFound(el, ctx) {
  const { navigate } = ctx.actions;
  const eyebrow = h("div", { class: "eyebrow" });
  const root = h(
    "div",
    { class: "ss ss-notfound adc-enter", "data-view": "notfound" },
    eyebrow,
    h("h1", { class: "display-l ss-title", text: "Проєкт не знайдено" }),
    h("p", {
      class: "ss-lead",
      text: "Перевірте посилання або відкрийте проєкт зі списку. Нові проєкти з'являються там одразу після старту.",
    }),
    actionsRow(
      ["projects", "Мої проєкти", () => navigate({ route: "cabinet", section: "projects" })],
      ["new-project", "Новий проєкт", () => navigate({ route: "start" })],
    ),
  );
  el.append(root);

  /** @param {UiState} state */
  const render = (state) => text(eyebrow, notFoundEyebrow(state.projectId));
  render(ctx.store.getState());
  return {
    update: (state) => render(state),
    destroy: () => root.remove(),
  };
}

/**
 * Екрани сцени `session` (401) і `notfound` (404). Екран фіксується при монтуванні: app.js
 * перемонтовує view, коли `viewFor(state)` змінюється.
 * @type {import("../contracts.js").MountFn}
 */
export function mount(el, ctx) {
  return viewFor(ctx.store.getState()) === "session" ? mountLogin(el, ctx) : mountNotFound(el, ctx);
}

/**
 * Екран 403 для адмінки: `admin.js` (B11) викликає при `admin.forbidden`.
 * @type {import("../contracts.js").MountFn}
 */
export function mountForbidden(el, ctx) {
  const { navigate } = ctx.actions;
  const root = h(
    "div",
    { class: "ss-forbidden adc-enter", "data-view": "forbidden" },
    h("div", { class: "eyebrow", text: "403 · Адмінка" }),
    h("h2", { class: "ss-forbidden__title", text: "Лише для адміністратора." }),
    h("p", {
      class: "ss-lead",
      text: "Цей розділ недоступний для вашого акаунта. Кабінет і проєкти — на місці.",
    }),
    actionsRow(
      ["cabinet", "До кабінету", () => navigate({ route: "cabinet", section: "balance" })],
      ["new-project", "Новий проєкт", () => navigate({ route: "start" })],
    ),
  );
  el.append(root);
  return {
    update: () => {},
    destroy: () => root.remove(),
  };
}
