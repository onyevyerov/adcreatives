// @ts-check
/**
 * B7 · Поповнення в кабінеті (N8-B, N9-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B7.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"openTopup" | "selectPackage" | "setCustom" | "submitTopup" | "continueTopup">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B7] not implemented: ${name}`);

/** @type {Factory} */
export const topupActions = (_store, _deps) => ({
  openTopup(_o) {
    todo("openTopup");
  },
  selectPackage(_id) {
    todo("selectPackage");
  },
  setCustom(_value) {
    todo("setCustom");
  },
  async submitTopup() {
    todo("submitTopup");
  },
  continueTopup(_id) {
    todo("continueTopup");
  },
});
