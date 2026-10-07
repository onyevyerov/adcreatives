// @ts-check
/** @typedef {import("./contracts.js").UiState} UiState */
/** @typedef {import("./contracts.js").StageView} StageView */
/** @typedef {import("./contracts.js").ProjectStatus} ProjectStatus */

/** @type {Record<ProjectStatus, StageView>} */
const STAGE_VIEW = {
  intake: "progress",
  crawling: "progress",
  brandkit: "progress",
  scripting: "progress",
  directing: "progress",
  rendering: "progress",
  revising: "progress",
  awaiting_brand: "brand",
  awaiting_script: "script",
  awaiting_storyboard: "board",
  delivered: "done",
  failed: "failed",
};

/**
 * Який екран показує сцена (права панель) для статусу проєкту.
 * @param {Pick<UiState, "status">} state
 * @returns {StageView}
 */
export function viewFor(state) {
  return STAGE_VIEW[state.status] ?? "progress";
}
