// @ts-check
/**
 * B9 · фікстури N11: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` з `./_base.js` (Олена, 12; історія з 11 записів;
 * 4 проєкти).
 *
 * - `cab-history` — кадри `#N11` «Історія» (1440) і «Історія · 1024»;
 * - `sheet-n11-*` — клітинки аркуша `sheet-n11` у його порядку: «Список» (`-list`), «Порожньо»
 *   (`-empty`), «Завантаження» (`-loading`), «Сторінка + «Показати ще»» (`-more`), «Довантаження»
 *   (`-more-busy`), «Довга примітка» (`-long-note`).
 * Клітинки аркуша в Референсі — лише розділ; фікстура — уся сторінка кабінету з тим самим розділом.
 */
import { accountFixture, at, HISTORY, OLENA, TOPUPS } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").CabinetState} CabinetState */
/** @typedef {import("../../js/contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("./_base.js").StatePatch} StatePatch */

/**
 * Кабінет на «Історії»; `history` — патч гілки історії.
 * @param {Partial<CabinetState["history"]>} [history]
 * @returns {UiState}
 */
const history = (history = {}) =>
  accountFixture(
    /** @type {StatePatch} */ ({
      route: "cabinet",
      cabinet: { section: "history", history: { topups: TOPUP_PACKAGES, ...history } },
    }),
  );

/** `history.topups` з `GET topups` Олени: `topupId → packageId`. */
export const TOPUP_PACKAGES = Object.fromEntries(TOPUPS.map((t) => [t.id, t.packageId]));

/** Перша сторінка з п'яти записів: далі є ще (`nextBefore` — час останнього). */
const PAGE = HISTORY.slice(0, 5);
const NEXT = PAGE.at(-1)?.at ?? null;

/** Коригування з приміткою на межі (≤ 200 символів). @type {LedgerEntry} */
export const LONG_NOTE = {
  id: "adjust:x",
  userId: OLENA.id,
  at: at("19.10 12:00"),
  kind: "adjust",
  credits: 6,
  balanceAfter: 18,
  ref: { byUserId: "u_admin001" },
  note: "Компенсація за затримку рендеру 18–19 жовтня: два проєкти чекали в черзі довше години через оновлення сервера",
};

/** @type {Record<string, UiState>} */
export default {
  // ───── Кадри #N11 ─────
  "cab-history": history(),

  // ───── Аркуш sheet-n11 ─────
  "sheet-n11-list": history(),
  "sheet-n11-empty": history({ entries: [] }),
  "sheet-n11-loading": history({ entries: [], loading: true }),
  "sheet-n11-more": history({ entries: PAGE, nextBefore: NEXT, more: true }),
  "sheet-n11-more-busy": history({ entries: PAGE, nextBefore: NEXT, more: true, loading: true }),
  "sheet-n11-long-note": history({ entries: [LONG_NOTE, ...HISTORY.slice(0, 3)] }),
};
