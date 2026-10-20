// @ts-check
/**
 * B10 · Профіль і пароль (N13-A).
 *
 * Крок 0 — заглушка: ключі заморожені (`AccountActions` у contracts.js), тіла робить B10.
 * Фабрика отримує `store` і `deps` (`PartDeps`: `api`, `actions()`, `backend`, `offline`, `onRoute`).
 */

/** @typedef {import("../contracts.js").PartFactory<"setProfileField" | "saveName" | "changePassword">} Factory */

/** @param {string} name */
const todo = (name) => console.warn(`[B10] not implemented: ${name}`);

/** @type {Factory} */
export const profileActions = (_store, _deps) => ({
  setProfileField(_key, _value) {
    todo("setProfileField");
  },
  async saveName() {
    todo("saveName");
  },
  async changePassword() {
    todo("changePassword");
  },
});
