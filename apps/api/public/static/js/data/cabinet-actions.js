// @ts-check
/**
 * B9 · Історія і мої проєкти (N11-B, N12-B).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B9.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"loadHistory" | "loadProjects" | "toggleProjectCredits" | "openProject">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B9] not implemented: ${name}`);

/** @type {Factory} */
export const cabinetActions = (_store, _deps) => ({
  async loadHistory(_more) {
    todo("loadHistory");
  },
  async loadProjects() {
    todo("loadProjects");
  },
  toggleProjectCredits(_id) {
    todo("toggleProjectCredits");
  },
  openProject(_id) {
    todo("openProject");
  },
});
