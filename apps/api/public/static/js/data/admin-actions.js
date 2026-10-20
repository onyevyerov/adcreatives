// @ts-check
/**
 * B11 · Адмінка (N14-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B11.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"adminTab" | "adminSearch" | "adminSelect" | "adminField" | "adminAdjust" | "adminCancelConfirm" | "adminCopy">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B11] not implemented: ${name}`);

/** @type {Factory} */
export const adminActions = (_store, _deps) => ({
  adminTab(_tab) {
    todo("adminTab");
  },
  adminSearch(_q) {
    todo("adminSearch");
  },
  async adminSelect(_id) {
    todo("adminSelect");
  },
  adminField(_key, _value) {
    todo("adminField");
  },
  async adminAdjust(_confirmed) {
    todo("adminAdjust");
  },
  adminCancelConfirm() {
    todo("adminCancelConfirm");
  },
  async adminCopy(_mailId) {
    todo("adminCopy");
  },
});
