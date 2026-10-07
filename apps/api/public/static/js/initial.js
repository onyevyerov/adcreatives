// @ts-check
/** @typedef {import("./contracts.js").UiState} UiState */

/**
 * Порожній стан UI для маршруту.
 * @param {UiState["route"]} route
 * @param {string | null} projectId
 * @returns {UiState}
 */
export function initialState(route, projectId) {
  return {
    route,
    projectId,
    site: null,
    status: "intake",
    prevStatus: null,
    rev: null,
    conn: "idle",
    totalUsd: 0,
    breakdown: null,
    feed: [],
    progress: null,
    stageLog: [],
    checkpoints: { brand: null, script: null, storyboard: null },
    artifacts: { videos: [], poster: null, music: null },
    error: null,
    busyMs: 0,
    busySince: null,
    ui: {
      editing: false,
      draft: "",
      pendingFormats: null,
      doneFormat: null,
      notice: null,
      startError: null,
      sending: false,
    },
  };
}
