// @ts-check
/**
 * B12 · Системні стани сцени (N15-B): 401 / 404 / 403.
 * Крок 0 — заглушка з фіксованими експортами; B12 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("session", "B12", el, ctx, (s) => s.session ?? "—");
}

/**
 * Екран 403 для адмінки: `admin.js` (B11) викликає при `admin.forbidden`.
 * @type {import("../contracts.js").MountFn}
 */
export function mountForbidden(el, ctx) {
  return stubView("session-403", "B12", el, ctx, () => "403");
}

/**
 * Текст порожнього чату для системного стану (404) або `null`; `chat.js` (B6) показує його.
 * @param {import("../contracts.js").UiState} _state
 * @returns {string | null}
 */
export function emptyChatText(_state) {
  return null;
}
