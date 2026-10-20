// @ts-check
/**
 * B6 · «Повторити» після поповнення (N6-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B6.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"retryAfterTopup">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B6] not implemented: ${name}`);

/** @type {Factory} */
export const retryActions = (_store, _deps) => ({
  async retryAfterTopup() {
    todo("retryAfterTopup");
  },
});
