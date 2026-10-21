// @ts-check
/**
 * B2 · Старт для гостя й користувача, автостарт (N3-A).
 *
 * - `submitStart(form)` — форма старту вже пройшла перевірку view (адреса або опис, ≤ 10 фото):
 *   гість → відкладений старт (`savePending`, localStorage) + модалка реєстрації; користувач з
 *   балансом < ціни ролика → `ui.startShortage` без запиту (і відкладений старт — після оплати
 *   ролик почнеться сам); інакше → `createProject(form)`. 402 від сервера `createProject` сам
 *   перетворює на `ui.startShortage` — тоді форма теж відкладається.
 * - `startPending()` — `takePending()` → `account.autostart` (рядок «Починаю ролик…» на старті,
 *   мін. `AUTOSTART_MIN_MS`) → `createProject` → маршрут project. Нестача (клієнтська або 402) —
 *   картка K3 на старті, відкладений старт повертається у сховище.
 * - `dismissFlash()` — прибрати рядок-статус після виходу.
 * Поки `me` вантажиться, `submitStart` чекає на нього: користувача не відправляємо в реєстрацію.
 */
import { peekPending, photosLost, savePending, takePending } from "../lib/pending.js";
import { hostOf } from "./api.js";

/** @typedef {import("../contracts.js").PartFactory<"submitStart" | "startPending" | "dismissFlash">} Factory */
/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").AccountState} AccountState */
/** @typedef {import("../contracts.js").PendingStart} PendingStart */
/** @typedef {import("../contracts.js").UiFlags} UiFlags */

/** Скільки щонайменше видно рядок «Починаю ролик…» перед запитом, мс. */
export const AUTOSTART_MIN_MS = 1200;

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Відкладений старт і файли з FormData форми старту.
 * @param {FormData} form
 * @returns {{ pending: PendingStart, files: File[] }}
 */
function pendingOf(form) {
  const files = form.getAll("photos").filter((f) => typeof f === "object" && f !== null);
  return {
    pending: {
      url: str(form.get("url")),
      manualText: str(form.get("manualText")),
      hadPhotos: files.length > 0,
      at: new Date().toISOString(),
    },
    files: /** @type {File[]} */ (files),
  };
}

/**
 * FormData для `createProject` з відкладеного старту.
 * @param {PendingStart} p
 * @param {File[]} files
 */
function formOf(p, files) {
  const form = new FormData();
  if (p.url) form.append("url", p.url);
  if (p.manualText) form.append("manualText", p.manualText);
  for (const file of files) form.append("photos", file);
  return form;
}

/** @param {number} ms */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {Factory} */
export const startActions = (store, deps) => {
  /** @param {Partial<AccountState>} patch */
  const setAccount = (patch) => store.setState((s) => ({ account: { ...s.account, ...patch } }));
  /** @param {Partial<UiFlags>} patch */
  const ui = (patch) => store.setState((s) => ({ ui: { ...s.ui, ...patch } }));

  /** `me` визначився (ready або anon). */
  function settled() {
    if (store.getState().account.meStatus !== "loading") return Promise.resolve();
    return new Promise((resolve) => {
      const off = store.subscribe((s) => {
        if (s.account.meStatus === "loading") return;
        off();
        resolve(undefined);
      });
    });
  }

  /**
   * Зберегти відкладений старт (до входу або оплати).
   * @param {PendingStart} pending
   * @param {File[]} files
   */
  function keep(pending, files) {
    savePending(pending, files);
    setAccount({ pending });
  }

  /**
   * Клієнтська перевірка балансу: не вистачає — K3 без запиту.
   * @returns {boolean} true — вистачає
   */
  function enough() {
    const me = store.getState().account.me;
    if (!me || me.balance >= me.prices.video) return true;
    ui({ startShortage: { need: me.prices.video, have: me.balance }, startError: null });
    return false;
  }

  return {
    async submitStart(form) {
      setAccount({ flash: null });
      await settled();
      const s = store.getState();
      const { pending, files } = pendingOf(form);
      if (s.account.meStatus !== "ready" || !s.account.me) {
        keep(pending, files);
        deps.actions().openAuth("register", "start");
        return;
      }
      if (!enough()) {
        keep(pending, files);
        return;
      }
      await deps.actions().createProject(form);
      // 402: ролик почнеться сам після оплати.
      if (store.getState().ui.startShortage) keep(pending, files);
    },

    async startPending() {
      const taken = takePending();
      setAccount({ pending: null, flash: null });
      if (!taken) return;
      const { pending, files } = taken;
      if (store.getState().route !== "start") deps.actions().navigate({ route: "start" });
      if (!enough()) {
        keep(pending, files);
        return;
      }
      const me = store.getState().account.me;
      const price = me?.prices.video ?? 0;
      setAccount({
        autostart: {
          host: hostOf(pending.url),
          charged: price,
          after: Math.max(0, (me?.balance ?? 0) - price),
          photosLost: photosLost(taken),
        },
      });
      ui({ sending: true, startError: null, startShortage: null });
      await delay(AUTOSTART_MIN_MS);
      try {
        await deps.actions().createProject(formOf(pending, files));
      } finally {
        setAccount({ autostart: null });
      }
      const after = store.getState();
      // Не вийшло (402 або помилка) — форма лишається відкладеною, якщо нова ще не з'явилась.
      if (after.route === "start" && !peekPending()) keep(pending, files);
    },

    dismissFlash() {
      if (store.getState().account.flash !== null) setAccount({ flash: null });
    },
  };
};
