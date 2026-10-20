// @ts-check
/**
 * B7 · фікстури N8–N9: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js` (Олена, 12; історія з 11 записів;
 * 4 проєкти).
 *
 * - `cab-balance`, `cab-zero`, `n6-start-return`, `n6-cab-return`, `cab-from-ws`, `cab-loading`,
 *   `cab-admin` — кадри `#N8` (карта `#M`);
 * - `sheet-n9-*` — решта клітинок аркуша `sheet-n9` у його порядку (клітинки «Перший візит · 0»,
 *   «Баланс 12 · пакет обрано» і «Повернення після оплати · старт» — це `cab-zero`,
 *   `cab-balance` і `n6-start-return`).
 * Клітинки аркуша в Референсі — лише розділ (660px); фікстура — уся сторінка кабінету з тим самим
 * розділом.
 */
import { ADMIN, ADMIN_HISTORY, ADMIN_ME, accountFixture, at, meOf, OLENA, PENDING_TOPUP } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").CabinetState} CabinetState */
/** @typedef {import("../../js/contracts.js").AccountState} AccountState */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

/**
 * Кабінет на «Балансі»: `cabinet` / `account` — глибокі патчі.
 * @param {{ cabinet?: Record<string, unknown>, account?: Record<string, unknown> }} [patch]
 * @returns {UiState}
 */
const balance = (patch = {}) =>
  accountFixture(
    /** @type {StatePatch} */ ({
      route: "cabinet",
      cabinet: { section: "balance", ...patch.cabinet },
      ...(patch.account ? { account: patch.account } : {}),
    }),
  );

/** @param {number} n */
const olena = (n) => ({ me: meOf(OLENA, n) });

/** @param {Partial<CabinetState["topup"]>} topup */
const tu = (topup) => ({ topup });

const ZERNO = "zerno.example.com";

/** @param {{ id: string, credits: number, label: string }[]} list */
const packages = (list) => ({
  me: { ...meOf(OLENA, 12), packages: list.map((p) => ({ ...p, priceUsd: p.credits })) },
});

/** @type {Record<string, UiState>} */
export default {
  // ───── Кадри #N8 ─────
  // Пакет не обрано (`packageId: null`) — за замовчуванням середній, «Кілька роликів».
  "cab-balance": balance(),
  "cab-zero": balance({
    account: { ...olena(0), projectCount: 0 },
    cabinet: { history: { entries: [] }, projects: { rows: [] } },
  }),
  "n6-start-return": balance({
    account: {
      ...olena(4),
      pending: { url: ZERNO, manualText: null, hadPhotos: false, at: at("19.10 11:18") },
    },
    cabinet: { backTo: { kind: "start" }, ...tu({ packageId: "starter" }) },
  }),
  "n6-cab-return": balance({
    account: olena(1),
    cabinet: {
      backTo: { kind: "project", projectId: "p_zerno", host: ZERNO, retry: { ctx: "cp3", text: null } },
      ...tu({ packageId: "starter" }),
    },
  }),
  "cab-from-ws": balance({
    cabinet: { backTo: { kind: "project", projectId: "p_zerno", host: ZERNO, retry: null } },
  }),
  "cab-loading": balance({ cabinet: { loading: true } }),
  // «Витрачено $2.31» у топбарі адміна — як у кадрі.
  "cab-admin": {
    ...balance({
      account: { me: ADMIN_ME, projectCount: 0 },
      cabinet: { history: { entries: ADMIN_HISTORY[ADMIN.id] ?? [] }, projects: { rows: [] } },
    }),
    totalUsd: 2.31,
  },

  // ───── Аркуш sheet-n9 ─────
  "sheet-n9-1250": balance({ account: olena(1250), cabinet: tu({ packageId: "pro" }) }),
  "sheet-n9-custom-empty": balance({ cabinet: tu({ mode: "custom", custom: "", error: true }) }),
  "sheet-n9-custom-fraction": balance({ cabinet: tu({ mode: "custom", custom: "12.5", error: true }) }),
  "sheet-n9-custom-range": balance({ cabinet: tu({ mode: "custom", custom: "700", error: true }) }),
  "sheet-n9-custom-ok": balance({ cabinet: tu({ mode: "custom", custom: "40" }) }),
  "sheet-n9-busy": balance({ cabinet: tu({ packageId: "standard", busy: true }) }),
  "sheet-n9-pending": balance({ cabinet: { pendingTopups: [PENDING_TOPUP] } }),
  // Обраний раніше пакет зник зі списку — нічого не обрано, кнопка без суми.
  "sheet-n9-one-package": balance({
    account: packages([{ id: "starter", label: "Старт", credits: 10 }]),
    cabinet: tu({ packageId: "standard" }),
  }),
  "sheet-n9-five-packages": balance({
    account: packages([
      { id: "a", label: "Старт", credits: 10 },
      { id: "b", label: "Кілька роликів", credits: 25 },
      { id: "c", label: "Серія", credits: 60 },
      { id: "d", label: "Сезонна кампанія для мережі", credits: 150 },
      { id: "e", label: "Агенція", credits: 500 },
    ]),
    cabinet: tu({ packageId: "d" }),
  }),
  "sheet-n9-bonus": balance({
    account: olena(5),
    cabinet: {
      history: {
        entries: [
          {
            id: `bonus:signup:${OLENA.id}`,
            userId: OLENA.id,
            at: at("14.10 10:00"),
            kind: "bonus",
            credits: 5,
            balanceAfter: 5,
            ref: {},
            note: "",
          },
        ],
      },
    },
  }),
};
