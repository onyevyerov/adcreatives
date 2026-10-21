// @ts-check
/**
 * B11 · фікстури N14: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js` (адмін, 500 кредитів).
 *
 * Кадри `#N14` (1440): `adm-users`, `adm-user`, `adm-done`, `adm-confirm`, `adm-402`,
 * `adm-outbox`, `adm-all`, `adm-search`, `adm-empty`, `adm-loading`.
 */
import { ADMIN, ADMIN_HISTORY, ADMIN_ME, ANDRIY, accountFixture, at, IRYNA, OLENA, USERS } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").AdminState} AdminState */
/** @typedef {import("../../js/contracts.js").PublicUser} PublicUser */
/** @typedef {import("../../js/contracts.js").LedgerEntry} LedgerEntry */

/**
 * Обраний користувач з його балансом і історією з `_base.js`.
 * @param {PublicUser} user
 * @param {{ balance?: number, entries?: LedgerEntry[] }} [o]
 */
const pick = (user, o = {}) => ({
  selectedId: user.id,
  selected: {
    user,
    balance: o.balance ?? USERS.find((u) => u.id === user.id)?.balance ?? 0,
    entries: o.entries ?? ADMIN_HISTORY[user.id] ?? [],
  },
});

/**
 * Адмінка під адміном.
 * @param {Partial<{ [K in keyof AdminState]: any }>} admin
 * @param {Partial<UiState>} [rest]
 * @returns {UiState}
 */
const adm = (admin, rest = {}) =>
  accountFixture({ route: "admin", account: { me: ADMIN_ME }, admin: { tab: "users", ...admin }, ...rest });

/** Щойно нараховано +5 «компенсація» Олені. @type {LedgerEntry} */
const COMPENSATION = {
  id: "adjust:n3",
  userId: OLENA.id,
  at: at("19.10 11:30"),
  kind: "adjust",
  credits: 5,
  balanceAfter: 17,
  ref: { byUserId: ADMIN.id },
  note: "компенсація",
};

/** @type {Record<string, UiState>} */
export default {
  "adm-users": adm(pick(OLENA)),
  "adm-user": adm({ ...pick(OLENA), adjust: { credits: "+5", note: "компенсація" } }),
  "adm-done": adm({
    ...pick(OLENA, { balance: 17, entries: [COMPENSATION, ...(ADMIN_HISTORY[OLENA.id] ?? [])] }),
    users: USERS.map((u) => (u.id === OLENA.id ? { ...u, balance: 17 } : u)),
    adjust: { done: { credits: 5, note: "компенсація", balance: 17 } },
  }),
  "adm-confirm": adm({
    ...pick(OLENA),
    adjust: { credits: "−10", note: "помилкове нарахування", confirm: true },
  }),
  "adm-402": adm({
    ...pick(ANDRIY),
    adjust: { credits: "−5", note: "тест", error: { need: 5, have: 0 } },
  }),
  "adm-outbox": adm({ tab: "outbox", copied: "m1" }),
  "adm-all": adm({ tab: "all" }),
  "adm-search": adm({ ...pick(IRYNA), q: "florist" }),
  "adm-empty": adm({ users: [], outbox: [] }),
  "adm-loading": adm({ loading: true }),
};
