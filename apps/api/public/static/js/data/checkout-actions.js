// @ts-check
/**
 * B8 · Тестова оплата (N10-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B8.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"confirmCheckout" | "checkoutAgain" | "checkoutReturn">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B8] not implemented: ${name}`);

/** @type {Factory} */
export const checkoutActions = (_store, _deps) => ({
  async confirmCheckout(_outcome) {
    todo("confirmCheckout");
  },
  async checkoutAgain() {
    todo("checkoutAgain");
  },
  checkoutReturn() {
    todo("checkoutReturn");
  },
});
