// @ts-check
/**
 * B2 · Дії і запуск потоку даних. Заглушка Кроку 0: B2 замінює вміст файлу (і додає api.js,
 * sse.js, reduce.js, mock.js поруч), сигнатуру `createActions` зберігає.
 *
 * Контракт: `createActions(store, { params })` повертає `Actions` і сам запускає потік даних
 * для поточного маршруту — GET проєкту + SSE, або програвання фікстури при `?mock=1`.
 * Подальші переходи (createProject → project, newProject → start) теж робить шар даних.
 */
import { createDevActions } from "../../dev/dev-actions.js";

/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").DataOptions} DataOptions */

/**
 * @param {Store} store
 * @param {DataOptions} _opts
 * @returns {Actions}
 */
export function createActions(store, _opts) {
  return createDevActions(store);
}
