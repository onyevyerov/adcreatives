// @ts-check
/**
 * B2 · фікстури N3: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * Адреса, яку в кадрі вже введено, — це відкладений старт (`account.pending`): view підставляє
 * його у форму, як після повернення з входу чи оплати.
 */
import { LOGOUT_FLASH } from "../../js/data/account.js";
import { initialState } from "../../js/initial.js";
import { accountFixture, at, ME, meOf, OLENA } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").PendingStart} PendingStart */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

const HOST = "zerno.example.com";

/** @type {PendingStart} */
const PENDING = { url: HOST, manualText: null, hadPhotos: false, at: at("19.10 11:20") };

/**
 * Гість: `me` визначився як 401.
 * @param {Partial<UiState["account"]>} [account]
 * @param {Partial<UiState["ui"]>} [ui]
 * @returns {UiState}
 */
function guest(account = {}, ui = {}) {
  const base = initialState("start", null);
  return {
    ...base,
    account: { ...base.account, meStatus: "anon", ...account },
    ui: { ...base.ui, ...ui },
  };
}

/** @type {Record<string, UiState>} */
export default {
  "n3-guest": guest(),
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
