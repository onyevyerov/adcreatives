// @ts-check
/**
 * B3 · фікстури N4: імена — з карти станів Референсу (`#M`), відкриваються через
 * `/?fixture=<ім'я>`. Дані — `accountFixture()` / `workspaceFixture()` з `./_base.js`.
 *
 * - `n4-menu`, `n4-admin`, `ws-meload`, `ws-long` — кадри `#N4` (карта `#M`);
 * - `sheet-n4-*` — решта клітинок аркуша `sheet-n4` у його порядку (клітинки «/me», «Меню» і
 *   «Меню адміна» — це `ws-meload`, `n4-menu`, `n4-admin`).
 *
 * Меню — локальний стан view, у `UiState` його немає: для `n4-menu` / `n4-admin` цей модуль у
 * браузері після монтування натискає коло акаунта (лише в режимі `?fixture=`).
 */
import { ADMIN_ME, meOf, OLENA, workspaceFixture } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */

const LONG_HOST = "kavyarnya-na-podoli-zi-snidankamy-do-obidu.example.com.ua";

/** @param {number} balance */
const olena = (balance) => ({ account: { me: meOf(OLENA, balance) } });

/** Стани з відкритим меню акаунта. */
export const MENU_OPEN = ["n4-menu", "n4-admin"];

/** @type {Record<string, UiState>} */
export default {
  // ───── Кадри #N4 ─────
  "n4-menu": workspaceFixture("brand"),
  "n4-admin": workspaceFixture("brand", { account: { me: ADMIN_ME } }),
  // Баланс ще вантажиться; ініціали в колі — з кадру (Олена).
  "ws-meload": workspaceFixture("brand", { account: { meStatus: "loading" } }),
  "ws-long": workspaceFixture("storyboard", { site: LONG_HOST, ...olena(1250) }),

  // ───── Аркуш sheet-n4 ─────
  "sheet-n4-12": workspaceFixture("brand", olena(12)),
  "sheet-n4-5": workspaceFixture("storyboard", { status: "rendering", ...olena(5) }),
  "sheet-n4-4": workspaceFixture("delivered", olena(4)),
  "sheet-n4-0": workspaceFixture("failed", olena(0)),
  "sheet-n4-1250": workspaceFixture("storyboard", olena(1250)),
  "sheet-n4-minus3": workspaceFixture("revision", {
    status: "revising",
    account: { me: meOf(OLENA, 9), delta: { credits: -3, key: 7 } },
  }),
  "sheet-n4-plus10": workspaceFixture("storyboard", {
    account: { me: meOf(OLENA, 11), delta: { credits: 10, key: 8 } },
  }),
  "sheet-n4-admin": workspaceFixture("brand", { account: { me: ADMIN_ME } }),
  "sheet-n4-long-low": workspaceFixture("storyboard", { site: LONG_HOST, ...olena(4) }),
};

// Режим `?fixture=n4-menu|n4-admin`: відкрити меню, щойно app.js змонтує топбар.
if (typeof location !== "undefined" && typeof document !== "undefined") {
  const name = new URLSearchParams(location.search).get("fixture");
  if (name && MENU_OPEN.includes(name)) {
    let tries = 60;
    const tick = () => {
      const trigger = document.querySelector("#topbar .ac-trigger");
      if (trigger instanceof HTMLButtonElement) {
        trigger.click();
        // Програмний фокус на першому пункті малює кільце, якого в кадрі немає.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      } else if (--tries > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
