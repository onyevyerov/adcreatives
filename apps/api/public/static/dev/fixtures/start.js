// @ts-check
/**
 * B2 · фікстури N3: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * Адреса, яку в кадрі вже введено, — це відкладений старт (`account.pending`): view підставляє
 * його у форму, як після повернення з входу чи оплати.
 *
 * `n3-guest-theme` (B5, кадр SW2) — гість з відкритим меню теми: меню — локальний стан view, тож
 * цей модуль у браузері після монтування натискає коло теми (лише в режимі `?fixture=`).
 */
import { LOGOUT_FLASH } from "../../js/data/account.js";
import { initialState } from "../../js/initial.js";
import { accountFixture, at, ME, meOf, OLENA, PRICES } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").PendingStart} PendingStart */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

const HOST = "zerno.example.com";

/** Стани з відкритим меню теми гостя. */
export const THEME_MENU_OPEN = ["n3-guest-theme"];

/** @type {PendingStart} */
const PENDING = { url: HOST, manualText: null, hadPhotos: false, at: at("19.10 11:20") };

/**
 * Гість: `me` визначився як 401, ціни — з публічного `packages()`.
 * @param {Partial<UiState["account"]>} [account]
 * @param {Partial<UiState["ui"]>} [ui]
 * @returns {UiState}
 */
function guest(account = {}, ui = {}) {
  const base = initialState("start", null);
  return {
    ...base,
    account: { ...base.account, meStatus: "anon", prices: PRICES, ...account },
    ui: { ...base.ui, ...ui },
  };
}

/** @type {Record<string, UiState>} */
export default {
  "n3-guest": guest(),
  "n3-guest-theme": guest(),
  "n3-guest-url": guest({ pending: PENDING }),
  "n3-user": accountFixture({ account: { pending: PENDING } }),
  "n3-low": accountFixture({ account: { me: meOf(OLENA, 4), pending: PENDING } }),
  "n3-402": accountFixture({
    account: { me: meOf(OLENA, 4), pending: PENDING },
    ui: { startShortage: { need: ME.prices.video, have: 4 } },
  }),
  // Після оплати ролик почався сам: −10, залишок 15 (як у кадрі — пілюля вже 15); фото не
  // пережили перезавантаження вкладки.
  "n3-auto": accountFixture({
    account: {
      me: meOf(OLENA, 15),
      pending: PENDING,
      autostart: { host: HOST, charged: ME.prices.video, after: 15, photosLost: true },
    },
    ui: { sending: true },
  }),
  "n3-empty": guest({}, { startError: "Вставте адресу сайту або коротко опишіть бізнес." }),
  "n15-logout": guest({ flash: LOGOUT_FLASH }),
};

// Режим `?fixture=n3-guest-theme`: відкрити меню теми, щойно app.js змонтує шапку старту.
if (typeof location !== "undefined" && typeof document !== "undefined") {
  const name = new URLSearchParams(location.search).get("fixture");
  if (name && THEME_MENU_OPEN.includes(name)) {
    let tries = 60;
    const tick = () => {
      const trigger = document.querySelector("#start .tm-trigger");
      if (trigger instanceof HTMLButtonElement) {
        trigger.click();
        // Програмний фокус на обраному пункті малює кільце, якого в кадрі немає.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      } else if (--tries > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
