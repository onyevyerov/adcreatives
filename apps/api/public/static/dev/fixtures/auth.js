// @ts-check
/**
 * B1 · фікстури N1–N2: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — як у пресетах `AcApp.dc.html`: старт гостя з відкладеним стартом
 * для zerno.example.com (контекст-рядок «Ролик для … почнеться після входу»), Олена.
 * `n1-register-filled` — крок F1 (Референс `#F`).
 */
import { authState, initialState } from "../../js/initial.js";
import { meOf, OLENA } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {NonNullable<import("../../js/contracts.js").AuthState>} Auth */
/** @typedef {import("../../js/contracts.js").AuthView} AuthView */

const EMAIL = "olena@zerno.example.com";
const NEW_EMAIL = "new@florist-kyiv.example.com";

/** Відкладений старт гостя. @type {import("../../js/contracts.js").PendingStart} */
const PENDING = {
  url: "zerno.example.com",
  manualText: null,
  hadPhotos: false,
  at: new Date().toISOString(),
};

/**
 * Старт із модалкою входу.
 * @param {AuthView} view
 * @param {Partial<Auth>} [patch]
 * @param {{ pending?: boolean, balance?: number | null }} [o] `balance` — Олена з цим балансом (вхід виконано)
 * @returns {UiState}
 */
function authFixture(view, patch = {}, o = {}) {
  const base = initialState("start", null);
  const signedIn = o.balance !== undefined && o.balance !== null;
  return {
    ...base,
    account: {
      ...base.account,
      me: signedIn ? meOf(OLENA, /** @type {number} */ (o.balance)) : null,
      meStatus: signedIn ? "ready" : "anon",
      pending: o.pending === false ? null : PENDING,
      projectCount: signedIn ? 0 : null,
    },
    auth: authState(view, o.pending === false ? null : "start", patch),
  };
}

/** Кулдаун листа, що триває ще `sec` секунд (рахується від відкриття фікстури). @param {number} sec */
const cooldown = (sec) => Date.now() + sec * 1000;

const filled = { email: EMAIL, password: "kava2026!" };
const registered = { name: "Олена Коваль", email: EMAIL };

/** @type {Record<string, UiState>} */
export default {
  // N1 · вхід
  "n1-login": authFixture("login"),
  "n1-login-filled": authFixture("login", filled),
  "n1-login-busy": authFixture("login", { ...filled, busy: true }),
  "n1-login-invalid": authFixture("login", {
    email: EMAIL,
    password: "kava2025",
    error: "invalid_credentials",
    fails: 1,
  }),
  "n1-login-notact": authFixture("login", {
    email: NEW_EMAIL,
    password: "florist-19",
    error: "not_activated",
  }),
  "n1-login-notact-sent": authFixture("login", {
    email: NEW_EMAIL,
    password: "florist-19",
    error: "not_activated",
    resent: true,
  }),
  "n1-login-rate": authFixture("login", {
    email: EMAIL,
    password: "kava2025",
    error: "rate_limited",
    fails: 4,
  }),
  "n1-login-net": authFixture("login", { ...filled, error: "network" }),
  "n1-google": authFixture("login", { error: "google" }),
  // N1 · реєстрація
  "n1-register": authFixture("register"),
  "n1-register-hint": authFixture("register", { ...registered, password: "kava2" }),
  "n1-register-ok": authFixture("register", { ...registered, password: "kava2026!", showPassword: true }),
  "n1-register-filled": authFixture("register", { ...registered, password: "kava2026!" }),
  "n1-register-weak": authFixture("register", { ...registered, password: "kava", error: "weak_password" }),
  "n1-register-busy": authFixture("register", { ...registered, password: "kava2026!", busy: true }),
  // N2 · листи
  "n2-check": authFixture("check", { email: EMAIL, cooldownUntil: cooldown(42) }),
  "n2-check-ready": authFixture("check", { email: EMAIL, cooldownUntil: null }),
  "n2-check-sent": authFixture("check", { email: EMAIL, cooldownUntil: cooldown(58), resent: true }),
  "n2-activating": authFixture("activating", { token: "Qm4xT9vLr2nW8sYp" }),
  "n2-activated": authFixture("activated", {}, { balance: 0 }),
  "n2-activated-bonus": authFixture("activated", { bonus: 5 }, { balance: 5 }),
  "n2-activated-plain": authFixture("activated", {}, { pending: false, balance: 0 }),
  "n2-act-invalid": authFixture("activateInvalid", { email: EMAIL }),
  "n2-act-invalid-sent": authFixture("activateInvalid", { email: EMAIL, resent: true }),
  "n2-forgot": authFixture("forgot", { email: EMAIL }, { pending: false }),
  "n2-forgot-sent": authFixture("forgotSent", { email: EMAIL }, { pending: false }),
  "n2-reset": authFixture(
    "reset",
    { password: "Zerno-ranok", token: "Zt9pK1sWq0dF3hJm" },
    { pending: false },
  ),
  "n2-reset-weak": authFixture(
    "reset",
    { password: "kava", error: "weak_password", token: "Zt9pK1sWq0dF3hJm" },
    { pending: false },
  ),
  "n2-reset-invalid": authFixture("resetInvalid", {}, { pending: false }),
  "n2-reset-done": authFixture("resetDone", {}, { pending: false, balance: 12 }),
};
