// @ts-check
/**
 * Крок 0 · Відкладений старт гостя і точка повернення після оплати (ТЗ фронтенду акаунтів, 2.5).
 *
 * Обидва записи — JSON під замороженими ключами; інших ключів не вводити.
 * - `adc.pendingStart` — **localStorage з TTL 24 год** (рішення користувача 2026-10-20): посилання
 *   активації з листа відкривається в новій вкладці, а sessionStorage у неї не переходить.
 *   Термін рахується від `PendingStart.at`; протухлий або битий запис видаляється, а
 *   `peekPending` / `takePending` повертають `null`.
 * - `adc.return` — sessionStorage: повернення після оплати відбувається в тій самій вкладці.
 * Файли фото не серіалізуються — живуть лише в пам'яті модуля, тож після перезавантаження
 * сторінки (лист відкрито в новій вкладці) їх немає: `photosLost`.
 * Недоступне сховище (приватний режим, заборона) — не помилка: запис просто не зберігається.
 */

/** @typedef {import("../contracts.js").PendingStart} PendingStart */
/** @typedef {import("../contracts.js").ReturnTo} ReturnTo */

export const PENDING_KEY = "adc.pendingStart";
export const RETURN_KEY = "adc.return";
/** Скільки живе відкладений старт від `PendingStart.at`. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {File[]} */
let memoryFiles = [];

/**
 * Сховище для ключа: відкладений старт — localStorage, повернення — sessionStorage.
 * @param {string} key
 * @returns {Storage | null}
 */
function storage(key) {
  try {
    return (key === PENDING_KEY ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

/** @param {string} key @returns {unknown} */
function read(key) {
  try {
    const raw = storage(key)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return undefined; // битий JSON
  }
}

/** @param {string} key @param {unknown} value */
function write(key, value) {
  try {
    storage(key)?.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[pending] ${key}`, err);
  }
}

/** @param {string} key */
function remove(key) {
  try {
    storage(key)?.removeItem(key);
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

/** @param {PendingStart} p */
const expired = (p) => {
  const at = Date.parse(p.at);
  return !Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS;
};

/**
 * Чинний відкладений старт; протухлий або битий запис видаляється.
 * @returns {PendingStart | null}
 */
function readPending() {
  const v = read(PENDING_KEY);
  if (v === null) return null;
  if (isPending(v) && !expired(v)) return v;
  remove(PENDING_KEY);
  return null;
}

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
  const pending = readPending();
  remove(PENDING_KEY);
  const files = memoryFiles;
  memoryFiles = [];
  return pending ? { pending, files } : null;
}

/** Не видаляє (крім протухлого чи битого). @returns {PendingStart | null} */
export function peekPending() {
  return readPending();
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
