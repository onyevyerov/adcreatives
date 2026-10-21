// @ts-check
/**
 * Крок 0 · URL ↔ Route (ТЗ фронтенду акаунтів, 2.2).
 *
 * | URL                                         | Маршрут                        |
 * |---------------------------------------------|--------------------------------|
 * | `/`                                         | start                          |
 * | `/?project=<id>`                            | project                        |
 * | `/?cabinet=balance\|history\|projects\|profile` | cabinet                    |
 * | `/?checkout=<topupId>`                      | checkout                       |
 * | `/?admin=users\|outbox\|all[&user=<id>]`    | admin                          |
 * | `/?auth=activate\|reset&token=…`            | start + `auth` (модалка)       |
 *
 * `auth` повертається за будь-якого маршруту (ядро прибирає токен з адреси завжди).
 *
 * У mock-режимі (`?mock=1`) `urlForRoute` зберігає службові параметри (`mock`, `speed`, `fail`…).
 */

/** @typedef {import("./contracts.js").Route} Route */
/** @typedef {import("./contracts.js").CabinetState["section"]} CabinetSection */
/** @typedef {import("./contracts.js").AdminState["tab"]} AdminTab */

/** @type {readonly CabinetSection[]} */
export const CABINET_SECTIONS = ["balance", "history", "projects", "profile"];
/** @type {readonly AdminTab[]} */
export const ADMIN_TABS = ["users", "outbox", "all"];

/** Параметри, що описують маршрут (решта — службові, зберігаються лише в mock-режимі). */
const ROUTE_KEYS = ["project", "cabinet", "checkout", "admin", "user", "auth", "token", "jump"];

/**
 * @template {string} T
 * @param {readonly T[]} list
 * @param {string | null} value
 * @param {T} fallback
 * @returns {T}
 */
const oneOf = (list, value, fallback) =>
  list.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;

/**
 * Маршрут з параметрів адреси. Невідомий розділ кабінету / вкладка адмінки → перший за списком.
 * @param {URLSearchParams} params
 * @returns {Route & { auth?: { kind: "activate" | "reset", token: string } }}
 */
export function routeFromUrl(params) {
  const route = baseRoute(params);
  const kind = params.get("auth");
  const token = params.get("token");
  return (kind === "activate" || kind === "reset") && token ? { ...route, auth: { kind, token } } : route;
}

/**
 * @param {URLSearchParams} params
 * @returns {Route}
 */
function baseRoute(params) {
  const project = params.get("project");
  if (project) return { route: "project", projectId: project };
  const checkout = params.get("checkout");
  if (checkout) return { route: "checkout", id: checkout };
  if (params.has("cabinet"))
    return { route: "cabinet", section: oneOf(CABINET_SECTIONS, params.get("cabinet"), "balance") };
  if (params.has("admin")) {
    const userId = params.get("user");
    return {
      route: "admin",
      tab: oneOf(ADMIN_TABS, params.get("admin"), "users"),
      ...(userId ? { userId } : {}),
    };
  }
  return { route: "start" };
}

/**
 * Адреса маршруту. `params` — поточні параметри сторінки: у mock-режимі службові зберігаються.
 * @param {Route} r
 * @param {URLSearchParams} [params]
 * @returns {string}
 */
export function urlForRoute(r, params) {
  const q = new URLSearchParams();
  if (params?.get("mock") === "1") {
    for (const [k, v] of params) if (!ROUTE_KEYS.includes(k)) q.append(k, v);
  }
  switch (r.route) {
    case "project":
      q.set("project", r.projectId);
      break;
    case "cabinet":
      q.set("cabinet", r.section);
      break;
    case "checkout":
      q.set("checkout", r.id);
      break;
    case "admin":
      q.set("admin", r.tab ?? "users");
      if (r.userId) q.set("user", r.userId);
      break;
    default:
      break;
  }
  const s = q.toString();
  return s ? `/?${s}` : "/";
}
