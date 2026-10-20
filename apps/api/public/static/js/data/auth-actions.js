// @ts-check
/**
 * B1 · Вхід, реєстрація, листи (N1–N2).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B1.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"openAuth" | "closeAuth" | "setAuthField" | "submitAuth" | "resendAuthMail" | "authGoogle">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B1] not implemented: ${name}`);

/** @type {Factory} */
export const authActions = (_store, _deps) => ({
  openAuth(_view, _context) {
    todo("openAuth");
  },
  closeAuth() {
    todo("closeAuth");
  },
  setAuthField(_key, _value) {
    todo("setAuthField");
  },
  async submitAuth() {
    todo("submitAuth");
  },
  async resendAuthMail() {
    todo("resendAuthMail");
  },
  async authGoogle() {
    todo("authGoogle");
  },
});
