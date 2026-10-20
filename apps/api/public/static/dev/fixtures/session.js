// @ts-check
/**
 * B12 · фікстури N15: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * - `n15-401`, `n15-401-err` — сесія завершилась на ЧП3: форма входу в сцені (контекст `session`),
 *   чат лишається. Акаунт у топбарі — як у кадрі (Олена, 12).
 * - `n15-404` — чужий або неіснуючий проєкт `p_7Hk2mQ9x`: стрічка порожня, хоста немає, потік на зв'язку.
 * - `n15-403` — маршрут admin для клієнта (`admin.forbidden`).
 * - `n15-net` — ЧП1, з'єднання втрачено (`conn: "lost"` — точка в чаті).
 */
import { authState, initialState } from "../../js/initial.js";
import { accountFixture, OLENA, workspaceFixture } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */

/** Проєкт із кадру `#n15-404`. */
const MISSING_PROJECT = "p_7Hk2mQ9x";

/** @type {Record<string, UiState>} */
export default {
  "n15-401": workspaceFixture("storyboard", {
    session: "401",
    auth: authState("login", "session", { email: OLENA.email }),
  }),
  "n15-401-err": workspaceFixture("storyboard", {
    session: "401",
    auth: authState("login", "session", {
      email: OLENA.email,
      password: "kava",
      error: "invalid_credentials",
      fails: 1,
    }),
  }),
  // Потік встиг підключитися до відповіді 404 (у кадрі — «на зв'язку»).
  "n15-404": accountFixture({ session: "404", conn: "online" }, initialState("project", MISSING_PROJECT)),
  "n15-403": accountFixture({ route: "admin", session: "403", admin: { forbidden: true } }),
  "n15-net": workspaceFixture("brand", { conn: "lost" }),
};
