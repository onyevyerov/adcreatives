// @ts-check
/**
 * B2 · Старт для гостя й користувача, автостарт (N3-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B2.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"submitStart" | "startPending" | "dismissFlash">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B2] not implemented: ${name}`);

/** @type {Factory} */
export const startActions = (_store, _deps) => ({
  async submitStart(_form) {
    todo("submitStart");
  },
  async startPending() {
    todo("startPending");
  },
  dismissFlash() {
    todo("dismissFlash");
  },
});
