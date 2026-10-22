// @ts-check
/**
 * Вкладка «Використання» адмінки: дії `usage*` (ключі заморожені в `UsageActions`, contracts.js).
 * Крок 0 — заглушки без ефектів; тіло пише B3.
 */

/** @typedef {import("../contracts.js").PartFactory<keyof import("../contracts.js").UsageActions>} Factory */

/** @type {Factory} */
export const usageActions = (_store, _deps) => ({
  async usagePreset() {},
  async usageRange() {},
  async usageSource() {},
  async usageSortUsers() {},
  async usageToggleUser() {},
  async usageProjects() {},
  usageToggleProject() {},
  async usageReload() {},
});
