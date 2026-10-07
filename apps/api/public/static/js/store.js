// @ts-check

/**
 * @template S
 * @typedef {{
 *   getState(): S,
 *   setState(patch: Partial<S> | ((state: S) => Partial<S>)): void,
 *   subscribe(fn: (state: S, prev: S) => void): () => void
 * }} Store
 */

/**
 * Мінімальне сховище: `setState` поверхнево зливає патч (або результат функції від стану) у новий
 * об'єкт стану. Підписники отримують `(state, prev)` лише тоді, коли хоч один ключ змінився за
 * посиланням, — тож view можуть порівнювати гілки стану через `===`.
 * @template {object} S
 * @param {S} initial
 * @returns {Store<S>}
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<(state: S, prev: S) => void>} */
  const listeners = new Set();
  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (!next || next === state) return;
      const changed = Object.keys(next).some(
        (k) =>
          /** @type {Record<string, unknown>} */ (next)[k] !==
          /** @type {Record<string, unknown>} */ (state)[k],
      );
      if (!changed) return;
      const prev = state;
      state = { ...state, ...next };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
