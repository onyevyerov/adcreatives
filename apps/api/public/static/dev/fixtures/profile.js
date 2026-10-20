// @ts-check
/**
 * B10 · фікстури N13: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js` (Олена, 12).
 *
 * - `cab-profile` — кадр `#N13` (карта `#M`); він же клітинка «Перегляд» аркуша `sheet-n13`;
 * - `sheet-n13-*` — решта клітинок аркуша `sheet-n13` у його порядку.
 * Клітинки аркуша в Референсі — лише розділ (660px); фікстура — уся сторінка кабінету з тим самим
 * розділом.
 */
import { ADMIN_ME, accountFixture, meOf, OLENA } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").CabinetState} CabinetState */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

const NEW_NAME = "Олена Коваль-Шевчук";

/**
 * Кабінет на «Профілі»: форма з поточним ім'ям + `profile`; `account` — глибокий патч.
 * @param {Partial<CabinetState["profile"]>} [profile]
 * @param {Record<string, unknown>} [account]
 * @returns {UiState}
 */
const profile = (profile = {}, account) => {
  const me = /** @type {import("../../js/contracts.js").Me} */ (account?.me ?? meOf(OLENA, 12));
  return accountFixture(
    /** @type {StatePatch} */ ({
      route: "cabinet",
      cabinet: { section: "profile", profile: { nameDraft: me.user.name, ...profile } },
      ...(account ? { account } : {}),
    }),
  );
};

/** @type {Record<string, UiState>} */
export default {
  // ───── Кадр #N13 (= клітинка «Перегляд») ─────
  "cab-profile": profile(),

  // ───── Аркуш sheet-n13 ─────
  "sheet-n13-editing": profile({ nameDraft: NEW_NAME }),
  "sheet-n13-saving": profile({ nameDraft: NEW_NAME, saving: true }),
  "sheet-n13-saved": profile(
    { nameDraft: NEW_NAME, saved: true },
    { me: meOf({ ...OLENA, name: NEW_NAME }, 12) },
  ),
  "sheet-n13-name-empty": profile({ nameDraft: "", nameError: true }),
  "sheet-n13-pw-invalid": profile({
    current: "kava2025",
    next: "Zerno-ranok",
    pwError: "invalid_credentials",
  }),
  "sheet-n13-pw-weak": profile({ current: "kava2026!", next: "kava", pwError: "weak_password" }),
  "sheet-n13-pw-done": profile({ pwDone: true }),
  "sheet-n13-admin": profile({}, { me: ADMIN_ME }),
};
