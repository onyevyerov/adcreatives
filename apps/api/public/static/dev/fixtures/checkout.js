// @ts-check
/**
 * B8 · фікстури N10: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js`; чек — `PENDING_TOPUP`
 * (`t_9q4m`, «Кілька роликів», створено 19.10 11:20), як у Референсі.
 *
 * Аркуш `sheet-n10` (9 клітинок, усі названі в `#M`): n10-loading, n10-pending, n10-confirming,
 * n10-paid, n10-paid-start, n10-paid-ws, n10-failed, n10-revisit, n10-404. Плюс n10-guest —
 * гість на чеку з модалкою входу (B1) у контексті checkout, і n10-net — `GET topup` не вдався
 * (мережа / 5xx), кадру в Референсі немає.
 */
import { authState, checkoutState, initialState } from "../../js/initial.js";
import { accountFixture, at, meOf, OLENA, PENDING_TOPUP, PRICES } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").CheckoutState} CheckoutState */
/** @typedef {import("../../js/contracts.js").TopUp} TopUp */

const PAID_AT = at("19.10 11:21");

/** @type {TopUp} */
const PAID = { ...PENDING_TOPUP, status: "paid", paidAt: PAID_AT };

/** Пакет «Старт» з проєкту (n10-paid-ws). @type {TopUp} */
const PAID_STARTER = { ...PAID, packageId: "starter", credits: 10, priceUsd: 10 };

/** @type {TopUp} */
const FAILED = { ...PENDING_TOPUP, status: "failed" };

/**
 * Чек Олени на маршруті checkout.
 * @param {Partial<CheckoutState>} co
 * @param {number} [balance]
 * @param {Partial<UiState["account"]>} [account]
 * @returns {UiState}
 */
const checkout = (co, balance = 12, account = {}) =>
  accountFixture(
    {
      route: "checkout",
      checkout: { ...checkoutState(PENDING_TOPUP.id), topup: PENDING_TOPUP, ...co },
      account: { me: meOf(OLENA, balance), ...account },
    },
    initialState("checkout", null),
  );

/** Повернення в проєкт «Зерно» після «Затвердити й рендерити» (ЧП3). */
const FROM_PROJECT = /** @type {const} */ ({
  kind: "project",
  projectId: "p_zerno",
  host: "zerno.example.com",
  retry: { ctx: "cp3", text: null },
});

/** Гість відкрив посилання на чек: маршрут лишається, модалка входу (B1) з контекстом checkout. @type {UiState} */
const guest = (() => {
  const s = initialState("checkout", null);
  return {
    ...s,
    checkout: checkoutState(PENDING_TOPUP.id),
    account: { ...s.account, meStatus: "anon", prices: PRICES },
    auth: authState("login", "checkout"),
  };
})();

/** @type {Record<string, UiState>} */
export default {
  "n10-loading": checkout({ status: "loading", topup: null }),
  "n10-pending": checkout({ status: "pending" }),
  "n10-confirming": checkout({ status: "confirming" }),
  "n10-paid": checkout({ status: "paid", topup: PAID }, 37),
  "n10-paid-start": checkout({ status: "paid", topup: PAID, returnTo: { kind: "start" } }, 25, {
    pending: { url: "zerno.example.com", manualText: null, hadPhotos: false, at: at("19.10 11:18") },
  }),
  "n10-paid-ws": checkout({ status: "paid", topup: PAID_STARTER, returnTo: FROM_PROJECT }, 11),
  "n10-failed": checkout({ status: "failed", topup: FAILED }),
  "n10-revisit": checkout({ status: "paid", topup: PAID, revisit: true }, 37),
  "n10-404": checkout({ status: "notfound", id: "t_zz00", topup: null }),
  "n10-net": checkout({ status: "error", topup: null }),
  "n10-guest": guest,
};
