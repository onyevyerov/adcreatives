// @ts-check
/**
 * Крок 0 · Спільні дані фікстур акаунтів — щоб блоки не дублювали їх (Референс, `AcApp.dc.html`):
 * Олена (баланс 12), історія з 11 записів, 4 проєкти з `credits`, користувачі адмінки, outbox.
 *
 * - `accountFixture(patch, base?)` — `UiState` з Оленою (`meStatus: "ready"`), заповненими
 *   історією й проєктами кабінету і даними адмінки; `patch` зливається глибоко (об'єкти —
 *   рекурсивно, масиви й решта — заміною).
 * - `workspaceFixture(path, patch?)` — робочий простір «Зерна» після шляху подій з
 *   fixture-events.js (справжній редьюсер) + той самий акаунт.
 *
 * Час — ISO в UTC; у Києві (UTC+3 у жовтні) — як у Референсі (19.10 10:40 тощо).
 */
import { reduceAll } from "../../js/data/reduce.js";
import { initialState } from "../../js/initial.js";
import { eventsOf, PATHS, PROJECT_ID, SITE_HOST } from "../fixture-events.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").Me} Me */
/** @typedef {import("../../js/contracts.js").PublicUser} PublicUser */
/** @typedef {import("../../js/contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../../js/contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../../js/contracts.js").OutboxMail} OutboxMail */
/** @typedef {import("../../js/contracts.js").TopUp} TopUp */
/** @typedef {import("../../js/contracts.js").CreditPrices} CreditPrices */
/** @typedef {import("../../js/contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../fixture-events.js").PathName} PathName */

/**
 * Київський час «ДД.ММ ГГ:ХХ» 2026 року → ISO UTC.
 * @param {string} kyiv
 */
export function at(kyiv) {
  const m = /^(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/.exec(kyiv);
  if (!m) throw new Error(`_base: дата ${kyiv}`);
  const [, d, mo, hh, mm] = m.map(Number);
  return new Date(Date.UTC(2026, Number(mo) - 1, Number(d), Number(hh) - 3, Number(mm))).toISOString();
}

// ───────────── Ціни й пакети (= config/credits.json) ─────────────

/** @type {CreditPrices} */
export const PRICES = { video: 10, revision: 3, extraFormat: 2 };

/** @type {CreditPackage[]} */
export const PACKAGES = [
  { id: "starter", credits: 10, priceUsd: 10, label: "Старт" },
  { id: "standard", credits: 25, priceUsd: 25, label: "Кілька роликів" },
  { id: "pro", credits: 60, priceUsd: 60, label: "Серія" },
];

export const CUSTOM = { min: 5, max: 500 };
export const CREDITS_PER_USD = 1;

// ───────────── Користувачі ─────────────

/** @type {PublicUser} */
export const OLENA = {
  id: "u_olena01",
  email: "olena@zerno.example.com",
  name: "Олена Коваль",
  isAdmin: false,
  createdAt: at("14.10 09:58"),
  activatedAt: at("14.10 10:00"),
};

/** @type {PublicUser} */
export const ADMIN = {
  id: "u_admin001",
  email: "admin@example.com",
  name: "Адміністратор",
  isAdmin: true,
  createdAt: at("01.10 09:00"),
  activatedAt: at("01.10 09:00"),
};

/** @type {PublicUser} */
export const ANDRIY = {
  id: "u_andriy02",
  email: "andriy@shyna-lviv.example.com",
  name: "Андрій Мельник",
  isAdmin: false,
  createdAt: at("15.10 12:10"),
  activatedAt: at("15.10 12:12"),
};

/** Зареєструвалась, не активувала. @type {PublicUser} */
export const IRYNA = {
  id: "u_new003",
  email: "new@florist-kyiv.example.com",
  name: "Ірина Ткач",
  isAdmin: false,
  createdAt: at("19.10 11:02"),
  activatedAt: null,
};

/**
 * @param {PublicUser} user
 * @param {number} balance
 * @returns {Me}
 */
export const meOf = (user, balance) => ({
  user,
  balance,
  prices: PRICES,
  packages: PACKAGES,
  custom: CUSTOM,
  creditsPerUsd: CREDITS_PER_USD,
});

/** Фейковий `me` для `?mock=1` і `?fixture=`: Олена, 12 кредитів. */
export const ME = meOf(OLENA, 12);
/** Адмін, 500 кредитів. */
export const ADMIN_ME = meOf(ADMIN, 500);

// ───────────── Леджер ─────────────

/**
 * @param {string} userId
 * @param {string} id
 * @param {string} when
 * @param {LedgerEntry["kind"]} kind
 * @param {number} credits
 * @param {number} balanceAfter
 * @param {LedgerEntry["ref"]} ref
 * @param {string} note
 * @returns {LedgerEntry}
 */
const entry = (userId, id, when, kind, credits, balanceAfter, ref, note) => ({
  id,
  userId,
  at: at(when),
  kind,
  credits,
  balanceAfter,
  ref,
  note,
});

/** @param {Parameters<typeof entry> extends [string, ...infer R] ? R : never} a */
const olena = (...a) => entry(OLENA.id, ...a);

/** Історія Олени, новіші першими (як `GET /api/account/transactions`). Баланс на кінець — 12. */
export const HISTORY = [
  olena(
    "format:p_flor:landscape",
    "19.10 10:40",
    "charge",
    -2,
    12,
    { projectId: "p_flor", format: "landscape" },
    "Додатковий формат: 16:9",
  ),
  olena("video:p_flor", "19.10 10:15", "charge", -10, 14, { projectId: "p_flor" }, "Відео"),
  olena("video:p_kav", "18.10 09:04", "charge", -10, 24, { projectId: "p_kav" }, "Відео"),
  olena("topup:t_c22", "18.10 09:00", "topup", 22, 34, { topupId: "t_c22" }, "Поповнення"),
  olena("adjust:k8Hd", "17.10 11:00", "adjust", 2, 12, { byUserId: ADMIN.id }, "Компенсація за затримку"),
  olena("refund:p_shyna", "16.10 18:52", "refund", 10, 10, { projectId: "p_shyna" }, "Повернення за збій"),
  olena("video:p_shyna", "16.10 18:40", "charge", -10, 0, { projectId: "p_shyna" }, "Відео"),
  olena("revision:p_zerno:r2", "15.10 09:12", "charge", -3, 10, { projectId: "p_zerno", rev: 2 }, "Правка"),
  olena(
    "format:p_zerno:square",
    "14.10 10:31",
    "charge",
    -2,
    13,
    { projectId: "p_zerno", format: "square" },
    "Додатковий формат: 1:1",
  ),
  olena("video:p_zerno", "14.10 10:05", "charge", -10, 15, { projectId: "p_zerno" }, "Відео"),
  olena("topup:t_8f2k", "14.10 10:02", "topup", 25, 25, { topupId: "t_8f2k" }, "Поповнення"),
];

/** Поповнення Олени (усі сплачені; `packageId` — з credits.json або "custom"). @type {TopUp[]} */
export const TOPUPS = [
  {
    id: "t_c22",
    userId: OLENA.id,
    packageId: "custom",
    credits: 22,
    priceUsd: 22,
    status: "paid",
    createdAt: at("18.10 08:59"),
    paidAt: at("18.10 09:00"),
  },
  {
    id: "t_8f2k",
    userId: OLENA.id,
    packageId: "standard",
    credits: 25,
    priceUsd: 25,
    status: "paid",
    createdAt: at("14.10 10:01"),
    paidAt: at("14.10 10:02"),
  },
];

/** Незавершене поповнення (чек `t_9q4m`, «Кілька роликів»). @type {TopUp} */
export const PENDING_TOPUP = {
  id: "t_9q4m",
  userId: OLENA.id,
  packageId: "standard",
  credits: 25,
  priceUsd: 25,
  status: "pending",
  createdAt: at("19.10 11:20"),
  paidAt: null,
};

// ───────────── Проєкти ─────────────

/**
 * @param {Partial<ProjectRow> & Pick<ProjectRow, "id">} p
 * @returns {ProjectRow}
 */
const row = (p) => ({
  ownerId: OLENA.id,
  createdAt: null,
  status: "intake",
  site: null,
  formats: ["vertical"],
  totalUsd: 0,
  chatUrl: `/?project=${p.id}`,
  credits: null,
  ...p,
});

/** Проєкти Олени, новіші першими (`GET /api/projects`). */
export const PROJECTS = [
  row({
    id: "p_flor",
    createdAt: at("19.10 10:15"),
    status: "rendering",
    site: "florist-kyiv.example.com",
    formats: ["vertical", "landscape"],
    totalUsd: 2.4,
    credits: {
      charged: 12,
      refunded: 0,
      parts: [
        { kind: "video", credits: -10 },
        { kind: "format", credits: -2, format: "landscape" },
      ],
    },
  }),
  row({
    id: "p_kav",
    createdAt: at("18.10 09:04"),
    status: "awaiting_script",
    site: null,
    formats: ["vertical"],
    totalUsd: 0.86,
    credits: { charged: 10, refunded: 0, parts: [{ kind: "video", credits: -10 }] },
  }),
  row({
    id: "p_shyna",
    createdAt: at("16.10 18:40"),
    status: "failed",
    site: "shyna-lviv.example.com",
    formats: ["vertical"],
    totalUsd: 1.31,
    credits: {
      charged: 10,
      refunded: 10,
      parts: [
        { kind: "video", credits: -10 },
        { kind: "refund", credits: 10 },
      ],
    },
  }),
  row({
    id: "p_zerno",
    createdAt: at("14.10 10:05"),
    status: "delivered",
    site: "zerno.example.com",
    formats: ["vertical", "square"],
    totalUsd: 2.31,
    credits: {
      charged: 15,
      refunded: 0,
      parts: [
        { kind: "video", credits: -10 },
        { kind: "format", credits: -2, format: "square" },
        { kind: "revision", credits: -3, rev: 2 },
      ],
    },
  }),
];

/** Усі проєкти для адміна (`?all=1`): Олени, Андрія і безхазяйні eval-проєкти (`credits: null`). */
export const ALL_PROJECTS = [
  ...PROJECTS,
  row({
    id: "p_an1",
    ownerId: ANDRIY.id,
    createdAt: at("15.10 12:20"),
    status: "awaiting_brand",
    site: null,
    formats: ["vertical"],
    totalUsd: 0.42,
    credits: { charged: 10, refunded: 0, parts: [{ kind: "video", credits: -10 }] },
  }),
  row({
    id: "p_ev1",
    ownerId: null,
    createdAt: at("13.10 15:00"),
    status: "delivered",
    site: "kavarnia-eval.example.com",
    formats: ["vertical", "square", "landscape"],
    totalUsd: 3.07,
  }),
  row({
    id: "p_ev2",
    ownerId: null,
    createdAt: at("12.10 16:30"),
    status: "failed",
    site: "zerno.example.com",
    formats: ["vertical"],
    totalUsd: 0.58,
  }),
];

// ───────────── Адмінка ─────────────

/** `GET /api/admin/users` (за датою реєстрації). */
export const USERS = [
  { ...ADMIN, balance: 500 },
  { ...OLENA, balance: 12 },
  { ...ANDRIY, balance: 0 },
  { ...IRYNA, balance: 0 },
];

/** Історія кожного користувача для адмінки, новіші першими. @type {Record<string, LedgerEntry[]>} */
export const ADMIN_HISTORY = {
  [OLENA.id]: HISTORY,
  [ANDRIY.id]: [
    entry(ANDRIY.id, "video:p_an1", "15.10 12:20", "charge", -10, 0, { projectId: "p_an1" }, "Відео"),
    entry(ANDRIY.id, "topup:t_an1", "15.10 12:14", "topup", 10, 10, { topupId: "t_an1" }, "Поповнення"),
  ],
  [IRYNA.id]: [],
  [ADMIN.id]: [
    entry(
      ADMIN.id,
      "adjust:seed0001",
      "01.10 09:00",
      "adjust",
      500,
      500,
      { byUserId: ADMIN.id },
      "тестовий баланс",
    ),
  ],
};

/** @param {string} name @param {string} link @param {"activate" | "reset"} kind */
const mailText = (name, link, kind) =>
  kind === "activate"
    ? `Вітаємо, ${name}!\n\nЩоб активувати акаунт AdCreative, відкрийте посилання:\n${link}\n\n` +
      "Посилання дійсне 24 години. Якщо ви не реєструвалися — просто проігноруйте цей лист."
    : `Вітаємо, ${name}!\n\nЩоб задати новий пароль для AdCreative, відкрийте посилання:\n${link}\n\n` +
      "Посилання дійсне 1 годину. Якщо ви не просили скинути пароль — просто проігноруйте цей лист.";

const LINK_ACTIVATE = "https://adcreative.example.com/?auth=activate&token=Qm4xT9vLr2nW8sYp";
const LINK_RESET = "https://adcreative.example.com/?auth=reset&token=Zt9pK1sWq0dF3hJm";

/** `GET /api/admin/outbox`, новіші першими. @type {OutboxMail[]} */
export const OUTBOX = [
  {
    id: "m1",
    at: at("19.10 11:02"),
    to: IRYNA.email,
    kind: "activate",
    subject: "Активація акаунта AdCreative",
    text: mailText(IRYNA.name, LINK_ACTIVATE, "activate"),
    link: LINK_ACTIVATE,
  },
  {
    id: "m2",
    at: at("19.10 08:15"),
    to: OLENA.email,
    kind: "reset",
    subject: "Скидання пароля AdCreative",
    text: mailText(OLENA.name, LINK_RESET, "reset"),
    link: LINK_RESET,
  },
];

// ───────────── Збирачі станів ─────────────

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isPlain = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Глибоке злиття: об'єкти — рекурсивно, масиви й решта — заміною, `undefined` пропускається.
 * @template T
 * @param {T} base
 * @param {unknown} patch
 * @returns {T}
 */
export function merge(base, patch) {
  if (!isPlain(base) || !isPlain(patch)) return /** @type {T} */ (patch === undefined ? base : patch);
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = merge(out[k], v);
  return /** @type {T} */ (out);
}

/**
 * Глибокий частковий патч стану фікстури.
 * @typedef {{ [K in keyof UiState]?: UiState[K] extends any[] ? UiState[K] : UiState[K] extends object ? { [P in keyof UiState[K]]?: any } | null : UiState[K] }} StatePatch
 */

/**
 * Стан з Оленою (12 кредитів), її історією й проєктами в кабінеті і даними адмінки.
 * @param {StatePatch} [patch]
 * @param {UiState} [base] стан без акаунта (за замовчуванням — порожній старт)
 * @returns {UiState}
 */
export function accountFixture(patch = {}, base = initialState("start", null)) {
  /** @type {UiState} */
  const s = {
    ...base,
    account: { ...base.account, me: ME, meStatus: "ready", projectCount: PROJECTS.length, prices: PRICES },
    cabinet: {
      ...base.cabinet,
      history: {
        ...base.cabinet.history,
        entries: HISTORY,
        topups: Object.fromEntries(TOPUPS.map((t) => [t.id, t.packageId])),
      },
      projects: { ...base.cabinet.projects, rows: PROJECTS },
    },
    admin: { ...base.admin, users: USERS, outbox: OUTBOX, allProjects: ALL_PROJECTS },
  };
  return merge(s, patch);
}

/**
 * Робочий простір «Зерна» після шляху подій (`PATHS` з fixture-events.js) + акаунт Олени.
 * @param {PathName} path
 * @param {StatePatch} [patch]
 * @returns {UiState}
 */
export function workspaceFixture(path, patch = {}) {
  const base = {
    ...initialState("project", PROJECT_ID),
    site: SITE_HOST,
    conn: /** @type {const} */ ("online"),
  };
  return accountFixture(patch, reduceAll(base, eventsOf(PATHS[path])));
}
