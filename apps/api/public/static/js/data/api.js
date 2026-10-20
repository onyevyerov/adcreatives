// @ts-check
/**
 * HTTP API (перенесено з попереднього index.html; Крок 0 акаунтів додав `ApiError`).
 * Помилки — `ApiError` з повідомленням сервера (`message` у JSON-відповіді) або загальним текстом,
 * HTTP-статусом і кодом (`error` у відповіді; мережа — `status: 0, code: "network"`).
 * `fetch` береться з `globalThis` у момент виклику (тести підміняють його).
 */

/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {import("../contracts.js").ProjectCredits} ProjectCredits */
/**
 * Відповідь `GET /api/projects/:id` (поля, які читає UI). `credits` додає B4 (може не бути).
 * @typedef {{
 *   id: string,
 *   status: ProjectStatus,
 *   project: { rev: number, input: { url: string | null } } | null,
 *   intake: { input: { url: string | null } } | null,
 *   totalUsd: number,
 *   credits?: ProjectCredits | null
 * }} ProjectInfo
 */
/** Тіло `POST /api/projects/:id/commands`. @typedef {{ type: "approve", rev: number | null } | { type: "retry" } | { type: "set_logo", assetId: string } | { type: "restart_confirmed" }} CommandBody */

/** Текст мережевої помилки (як і до Кроку 0). */
export const NETWORK_MESSAGE = "Немає зв'язку з сервером. Перевірте інтернет і спробуйте ще раз.";

/** Помилка запиту: `status` — HTTP (0 — мережа), `code` — поле `error` відповіді, `body` — тіло. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string | null} code
   * @param {any} body
   */
  constructor(message, status, code, body) {
    super(message);
    this.name = "ApiError";
    /** @type {number} */
    this.status = status;
    /** @type {string | null} */
    this.code = code;
    /** @type {any} */
    this.body = body;
  }
}

/** @type {((err: ApiError, path: string) => void) | null} */
let onUnauthorized = null;

/**
 * Обробник 401 `unauthorized` (немає сесії або вона скінчилась); `path` — шлях запиту.
 * Не викликається на `invalid_credentials`. `null` — зняти.
 * @param {((err: ApiError, path: string) => void) | null} fn
 */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * Запит до API; JSON-відповідь або `ApiError` із повідомленням сервера.
 * @param {string} path
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
export async function api(path, opts) {
  /** @type {Response} */
  let res;
  try {
    res = await globalThis.fetch(path, opts);
  } catch {
    throw new ApiError(NETWORK_MESSAGE, 0, "network", null);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && typeof data.message === "string" && data.message ? data.message : "";
    const code = data && typeof data.error === "string" && data.error ? data.error : null;
    const err = new ApiError(message || `Помилка ${res.status}`, res.status, code, data);
    if (res.status === 401 && code === "unauthorized" && onUnauthorized) {
      try {
        onUnauthorized(err, path);
      } catch (handlerErr) {
        console.error("[api] unauthorized handler", handlerErr);
      }
    }
    throw err;
  }
  return data;
}

/** @param {unknown} err @param {number} status */
export const isStatus = (err, status) => err instanceof ApiError && err.status === status;

/**
 * @param {string} projectId
 * @param {string} [suffix]
 */
export function projectPath(projectId, suffix = "") {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

/** @param {unknown} body */
const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * @param {string} projectId
 * @param {CommandBody} body
 * @returns {Promise<{ commandId: string }>}
 */
export function sendCommand(projectId, body) {
  return api(projectPath(projectId, "/commands"), json(body));
}

/**
 * @param {string} projectId
 * @param {string} text
 * @returns {Promise<{ commandId: string, messageId: string, eventId: string }>}
 */
export function sendMessage(projectId, text) {
  return api(projectPath(projectId, "/messages"), json({ text }));
}

/**
 * Створення проєкту: multipart `url` | `manualText` + `photos[]`. 402 → `ApiError` з
 * `body: {required, available}`.
 * @param {FormData} form
 * @returns {Promise<{ id: string, chatUrl: string, balance?: number }>}
 */
export function createProject(form) {
  return api("/api/projects", { method: "POST", body: form });
}

/**
 * Дозавантаження фото (multipart `photos`).
 * @param {string} projectId
 * @param {FileList | File[]} files
 * @returns {Promise<{ commandId: string, files: string[] }>}
 */
export function uploadPhotos(projectId, files) {
  const form = new FormData();
  for (const f of Array.from(files)) form.append("photos", f);
  return api(projectPath(projectId, "/uploads"), { method: "POST", body: form });
}

/**
 * @param {string} projectId
 * @returns {Promise<ProjectInfo>}
 */
export function getProject(projectId) {
  return api(projectPath(projectId));
}

/**
 * Хост сайту з адреси (як її ввів клієнт — можна без схеми); `null`, якщо адреси немає.
 * @param {unknown} url
 * @returns {string | null}
 */
export function hostOf(url) {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || null;
  } catch {
    return null;
  }
}
