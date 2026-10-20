// @ts-check
/**
 * Крок 0 · Відкладений старт гостя і точка повернення після оплати (ТЗ фронтенду акаунтів, 2.5).
 *
 * Обидва записи — JSON у sessionStorage під замороженими ключами; інших ключів не вводити.
 * Файли фото в sessionStorage не серіалізуються — живуть лише в пам'яті модуля, тож після
 * перезавантаження сторінки (лист відкрито в новій вкладці) їх немає: `photosLost`.
 * Недоступне сховище (приватний режим, заборона) — не помилка: запис просто не зберігається.
 */

/** @typedef {import("../contracts.js").PendingStart} PendingStart */
/** @typedef {import("../contracts.js").ReturnTo} ReturnTo */

export const PENDING_KEY = "adc.pendingStart";
export const RETURN_KEY = "adc.return";

/** @type {File[]} */
let memoryFiles = [];

/** @returns {Storage | null} */
function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** @param {string} key @returns {unknown} */
function read(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {string} key @param {unknown} value */
function write(key, value) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[pending] ${key}`, err);
  }
}

/** @param {string} key */
function remove(key) {
  try {
    storage()?.removeItem(key);
  } catch {
    // сховище недоступне — нічого прибирати
  }
}

/** @param {unknown} v @returns {v is PendingStart} */
const isPending = (v) =>
  typeof v === "object" &&
  v !== null &&
  "hadPhotos" in v &&
  typeof v.hadPhotos === "boolean" &&
  "at" in v &&
  typeof v.at === "string";

/** @param {unknown} v @returns {v is ReturnTo} */
const isReturn = (v) =>
  typeof v === "object" &&
  v !== null &&
  "kind" in v &&
  (v.kind === "start" || v.kind === "cabinet" || (v.kind === "project" && "projectId" in v));

/**
 * @param {PendingStart} p
 * @param {File[]} files
 */
export function savePending(p, files) {
  write(PENDING_KEY, p);
  memoryFiles = [...files];
}

/** Читає й видаляє. @returns {{ pending: PendingStart, files: File[] } | null} */
export function takePending() {
  const pending = read(PENDING_KEY);
  remove(PENDING_KEY);
  const files = memoryFiles;
  memoryFiles = [];
  return isPending(pending) ? { pending, files } : null;
}

/** @returns {PendingStart | null} */
export function peekPending() {
  const pending = read(PENDING_KEY);
  return isPending(pending) ? pending : null;
}

/**
 * Фото були, але файлів у пам'яті вже немає (сторінку перезавантажили).
 * @param {{ pending: PendingStart, files: File[] }} taken
 */
export function photosLost(taken) {
  return taken.pending.hadPhotos && taken.files.length === 0;
}

/** @param {ReturnTo} r */
export function saveReturn(r) {
  write(RETURN_KEY, r);
}

/** Читає й видаляє. @returns {ReturnTo | null} */
export function takeReturn() {
  const r = read(RETURN_KEY);
  remove(RETURN_KEY);
  return isReturn(r) ? r : null;
}
