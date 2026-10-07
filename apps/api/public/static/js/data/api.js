// @ts-check
/**
 * B2 · HTTP API проєктів (перенесено з попереднього index.html). Помилки — `Error` з
 * повідомленням сервера (`message` у JSON-відповіді) або загальним текстом.
 * `fetch` береться з `globalThis` у момент виклику (тести підміняють його).
 */

/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/**
 * Відповідь `GET /api/projects/:id` (поля, які читає UI).
 * @typedef {{
 *   id: string,
 *   status: ProjectStatus,
 *   project: { rev: number, input: { url: string | null } } | null,
 *   intake: { input: { url: string | null } } | null,
 *   totalUsd: number
 * }} ProjectInfo
 */
/** Тіло `POST /api/projects/:id/commands`. @typedef {{ type: "approve", rev: number | null } | { type: "retry" } | { type: "set_logo", assetId: string } | { type: "restart_confirmed" }} CommandBody */

/**
 * Запит до API; JSON-відповідь або виняток із повідомленням сервера.
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
    throw new Error("Немає зв'язку з сервером. Перевірте інтернет і спробуйте ще раз.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && typeof data.message === "string" && data.message ? data.message : "";
    throw new Error(message || `Помилка ${res.status}`);
  }
  return data;
}

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
 * Створення проєкту: multipart `url` | `manualText` + `photos[]`.
 * @param {FormData} form
 * @returns {Promise<{ id: string, chatUrl: string }>}
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
