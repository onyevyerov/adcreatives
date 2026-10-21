// @ts-check
/**
 * Крок 0 · Тонкі обгортки API акаунтів (`docs/accounts-api.md`). Кожна — `Promise<тіло відповіді>`,
 * без логіки; помилки — `ApiError` з data/api.js (`status`, `code`, `message`, `body`).
 */
import { api } from "./api.js";

/** @typedef {import("../contracts.js").Me} Me */
/** @typedef {import("../contracts.js").PublicUser} PublicUser */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").CreditPrices} CreditPrices */
/** @typedef {import("../contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../contracts.js").TopUp} TopUp */
/** @typedef {import("../contracts.js").OutboxMail} OutboxMail */
/** @typedef {import("../contracts.js").ProjectRow} ProjectRow */
/** @typedef {{ user: PublicUser, balance: number }} SignedIn */
/** @typedef {{ message: string }} Accepted */
/** @typedef {{ entries: LedgerEntry[], nextBefore: string | null }} LedgerPage */

/** @param {"POST" | "PATCH"} method @param {unknown} [body] @returns {RequestInit} */
const send = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

/**
 * `?limit&before` без порожніх значень.
 * @param {Record<string, string | number | boolean | null | undefined>} query
 */
function qs(query) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** @param {string} id */
const seg = (id) => encodeURIComponent(id);

// ───────────── /api/auth ─────────────

/** @returns {Promise<Me>} 401 — гість. */
export const me = () => api("/api/auth/me");

/** @param {{ name: string, email: string, password: string }} body @returns {Promise<Accepted>} 202 */
export const register = (body) => api("/api/auth/register", send("POST", body));

/** @param {string} token @returns {Promise<SignedIn>} */
export const activate = (token) => api("/api/auth/activate", send("POST", { token }));

/** @param {string} email @returns {Promise<Accepted>} 202 */
export const resend = (email) => api("/api/auth/resend", send("POST", { email }));

/** @param {{ email: string, password: string }} body @returns {Promise<SignedIn>} */
export const login = (body) => api("/api/auth/login", send("POST", body));

/** @returns {Promise<null>} 204 */
export const logout = () => api("/api/auth/logout", send("POST"));

/** @param {string} email @returns {Promise<Accepted>} 202 */
export const forgot = (email) => api("/api/auth/forgot", send("POST", { email }));

/** @param {{ token: string, password: string }} body @returns {Promise<SignedIn>} */
export const reset = (body) => api("/api/auth/reset", send("POST", body));

/** @returns {Promise<unknown>} 501 `not_implemented` (поки Google не підключено) */
export const google = () => api("/api/auth/google", send("POST"));

// ───────────── /api/account ─────────────

/** @returns {Promise<SignedIn>} */
export const getAccount = () => api("/api/account");

/** @param {{ name: string }} body @returns {Promise<{ user: PublicUser }>} */
export const patchAccount = (body) => api("/api/account", send("PATCH", body));

/** @param {{ current: string, next: string }} body @returns {Promise<{ ok: true }>} */
export const changePassword = (body) => api("/api/account/password", send("POST", body));

/** Новіші першими. @param {{ limit?: number, before?: string | null }} [o] @returns {Promise<LedgerPage>} */
export const transactions = (o = {}) =>
  api(`/api/account/transactions${qs({ limit: o.limit, before: o.before })}`);

// ───────────── /api/billing ─────────────

/** @returns {Promise<{ creditsPerUsd: number, prices: CreditPrices, packages: CreditPackage[], custom: { min: number, max: number } }>} */
export const packages = () => api("/api/billing/packages");

/** @param {{ packageId: string } | { credits: number }} body @returns {Promise<{ topup: TopUp, checkoutUrl: string }>} 201 */
export const createTopUp = (body) => api("/api/billing/topups", send("POST", body));

/** @returns {Promise<{ topups: TopUp[] }>} */
export const listTopUps = () => api("/api/billing/topups");

/** @param {string} id @returns {Promise<{ topup: TopUp }>} 404 — немає або чужий */
export const getTopUp = (id) => api(`/api/billing/topups/${seg(id)}`);

/** Ідемпотентно. @param {string} id @param {"paid" | "failed"} outcome @returns {Promise<{ topup: TopUp, balance: number }>} */
export const confirmTopUp = (id, outcome) =>
  api(`/api/billing/topups/${seg(id)}/confirm`, send("POST", { outcome }));

// ───────────── /api/admin ─────────────

/** @returns {Promise<{ users: (PublicUser & { balance: number })[] }>} */
export const adminUsers = () => api("/api/admin/users");

/** @param {string} id @returns {Promise<SignedIn>} */
export const adminUser = (id) => api(`/api/admin/users/${seg(id)}`);

/**
 * 402 → `body: {required, available}`.
 * @param {string} id @param {{ credits: number, note: string }} body
 * @returns {Promise<{ entry: LedgerEntry, balance: number }>}
 */
export const adminCredits = (id, body) => api(`/api/admin/users/${seg(id)}/credits`, send("POST", body));

/** @param {string} id @param {{ limit?: number, before?: string | null }} [o] @returns {Promise<LedgerPage>} */
export const adminTransactions = (id, o = {}) =>
  api(`/api/admin/users/${seg(id)}/transactions${qs({ limit: o.limit, before: o.before })}`);

/** @param {{ limit?: number }} [o] @returns {Promise<{ mails: OutboxMail[] }>} */
export const adminOutbox = (o = {}) => api(`/api/admin/outbox${qs({ limit: o.limit })}`);

// ───────────── /api/projects ─────────────

/** Свої проєкти; адмін з `all` — усі. @param {{ all?: boolean }} [o] @returns {Promise<{ projects: ProjectRow[] }>} */
export const listProjects = (o = {}) => api(`/api/projects${o.all ? "?all=1" : ""}`);
