// @ts-check
/**
 * B8 · Тестова оплата (N10-A).
 *
 * Дані чека вантажить підписка `deps.onRoute` (ядро викликає її на boot, navigate, popstate і
 * після входу на захищеному маршруті): `GET topup` → `pending`, або `paid` / `failed` з
 * `revisit: true` (оплату вже завершено раніше), або 404 → `notfound`, або мережа / 5xx при першому
 * завантаженні → `error` («Спробувати ще раз» — той самий `checkoutAgain`). Точку повернення
 * (`adc.return`, кладе B7 у `openTopup`) чек забирає один раз — при першому відкритті — і
 * тримає в `checkout.returnTo`; без неї — кабінет.
 *
 * - `confirmCheckout(outcome)` → `confirming` (кнопки заблоковано) → `POST confirm` →
 *   `refreshMe()` → `paid` / `failed`. Повернення на старт — само через `RETURN_DELAY_MS`
 *   (`navigate(start)` + `startPending()`).
 * - `checkoutReturn()` — кнопки «Повернутися до проєкту» / «До проєкту» / «До кабінету»:
 *   у проєкт після оплати — ще й `ui.retry` (картка «Повторити» в чаті, B6).
 * - `checkoutAgain()` — після скасування: нове поповнення з тим самим пакетом або сумою →
 *   новий чек з тією самою точкою повернення; у стані `error` — повторне завантаження того самого чека.
 *
 * У `?mock=1` (`deps.offline`) — без мережі: чек «Кілька роликів» з фікстур, оплата миттєва.
 */
import { saveReturn, takeReturn } from "../lib/pending.js";
import { isStatus } from "./api.js";

/** @typedef {import("../contracts.js").PartFactory<"confirmCheckout" | "checkoutAgain" | "checkoutReturn">} Factory */
/** @typedef {import("../contracts.js").CheckoutState} CheckoutState */
/** @typedef {import("../contracts.js").TopUp} TopUp */

/** Пауза перед автоповерненням на старт після оплати (Референс `#N10`, paid · старт). */
export const RETURN_DELAY_MS = 1400;

/** Тіло `POST topups` для повтору: той самий пакет або та сама своя сума. @param {TopUp} t */
export const againBody = (t) =>
  t.packageId === "custom" ? { credits: t.credits } : { packageId: t.packageId };

/** @type {Factory} */
export const checkoutActions = (store, deps) => {
  /** Номер останнього `GET topup`: відповіді старіших відкидаються. */
  let loadSeq = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let returnTimer;
  let againBusy = false;

  /** @returns {CheckoutState | null} */
  const current = () => store.getState().checkout;

  /**
   * Патч чека, лише якщо відкритий той самий чек (користувач міг піти на інший).
   * @param {string} id
   * @param {Partial<CheckoutState>} patch
   */
  const patch = (id, patch) =>
    store.setState((s) => (s.checkout?.id === id ? { checkout: { ...s.checkout, ...patch } } : {}));

  /** @param {string} id */
  const still = (id) => {
    const s = store.getState();
    return s.route === "checkout" && s.checkout?.id === id;
  };

  /** Фейковий чек для `?mock=1`. @param {string} id @returns {Promise<TopUp>} */
  async function offlineTopUp(id) {
    const { PENDING_TOPUP } = await import("../../dev/fixtures/_base.js");
    return { ...PENDING_TOPUP, id, createdAt: new Date().toISOString() };
  }

  /** @param {string} id */
  async function load(id) {
    const co = current();
    if (!co || co.id !== id || co.status === "confirming") return;
    if (co.status === "loading") {
      const back = takeReturn();
      if (back) patch(id, { returnTo: back });
    }
    if (co.status === "error") patch(id, { status: "loading" });
    const my = ++loadSeq;
    try {
      const topup = deps.offline ? await offlineTopUp(id) : (await deps.api.getTopUp(id)).topup;
      const now = current();
      if (my !== loadSeq || !now || now.id !== id || now.status === "confirming") return;
      if (deps.offline && now.status !== "loading") return;
      if (topup.status === "pending") patch(id, { status: "pending", topup, revisit: false });
      // Оплату завершено раніше: повторне відкриття. Якщо щойно завершили тут — екран той самий.
      else
        patch(id, { status: topup.status, topup, revisit: now.status === topup.status ? now.revisit : true });
    } catch (err) {
      if (my !== loadSeq) return;
      if (isStatus(err, 404)) patch(id, { status: "notfound", topup: null });
      // 401 обробило ядро (модалка входу); після входу onRoute завантажить чек ще раз.
      else if (!isStatus(err, 401)) {
        console.warn("[checkout] getTopUp", err);
        // Мережа / 5xx: замість вічного спінера — «Спробувати ще раз». Уже показаний чек лишається.
        if (current()?.status === "loading") patch(id, { status: "error" });
      }
    }
  }

  deps.onRoute((route) => {
    if (route.route === "checkout") void load(route.id);
  });

  /** @param {string} id */
  function scheduleStart(id) {
    clearTimeout(returnTimer);
    returnTimer = setTimeout(() => {
      if (!still(id)) return;
      const a = deps.actions();
      a.navigate({ route: "start" });
      void a.startPending();
    }, RETURN_DELAY_MS);
  }

  /** Баланс у `?mock=1`: refreshMe там нічого не робить. @param {number} credits */
  function offlineCredit(credits) {
    store.setState((s) => {
      const me = s.account.me;
      if (!me) return {};
      return {
        account: {
          ...s.account,
          me: { ...me, balance: me.balance + credits },
          delta: { credits, key: Date.now() },
        },
      };
    });
  }

  return {
    async confirmCheckout(outcome) {
      const co = current();
      if (co?.status !== "pending" || !co.topup) return;
      const { id } = co;
      const topup0 = co.topup;
      patch(id, { status: "confirming" });
      try {
        /** @type {TopUp} */
        let topup;
        if (deps.offline) {
          topup = {
            ...topup0,
            status: outcome,
            paidAt: outcome === "paid" ? new Date().toISOString() : null,
          };
          if (outcome === "paid") offlineCredit(topup.credits);
        } else {
          ({ topup } = await deps.api.confirmTopUp(id, outcome));
          // Баланс у топбарі й у ліді — до показу «Зараховано».
          if (topup.status === "paid") await deps.actions().refreshMe();
        }
        if (current()?.id !== id) return;
        patch(id, { status: topup.status === "pending" ? "pending" : topup.status, topup, revisit: false });
        if (topup.status === "paid" && current()?.returnTo.kind === "start") scheduleStart(id);
      } catch (err) {
        if (isStatus(err, 404)) patch(id, { status: "notfound", topup: null });
        else {
          // Мережа / 5xx / 401 — кнопки знову активні, можна натиснути ще раз (confirm ідемпотентний).
          if (!isStatus(err, 401)) console.warn("[checkout] confirmTopUp", err);
          patch(id, { status: "pending" });
        }
      }
    },

    async checkoutAgain() {
      const co = current();
      if (co?.status === "error") return load(co.id);
      if (!co?.topup || againBusy) return;
      againBusy = true;
      try {
        const topup = deps.offline
          ? {
              ...co.topup,
              id: `t_${Math.random().toString(36).slice(2, 6)}`,
              status: /** @type {const} */ ("pending"),
              createdAt: new Date().toISOString(),
              paidAt: null,
            }
          : (await deps.api.createTopUp(againBody(co.topup))).topup;
        if (current()?.id !== co.id) return;
        // Новий чек забере ту саму точку повернення при першому відкритті.
        saveReturn(co.returnTo);
        deps.actions().navigate({ route: "checkout", id: topup.id });
        patch(topup.id, { status: "pending", topup, revisit: false });
      } catch (err) {
        if (!isStatus(err, 401)) console.warn("[checkout] createTopUp", err);
      } finally {
        againBusy = false;
      }
    },

    checkoutReturn() {
      const co = current();
      if (!co) return;
      clearTimeout(returnTimer);
      const a = deps.actions();
      const back = co.returnTo;
      // Повторне відкриття оплаченого — лише «До кабінету»: повернення вже відбулося раніше.
      const paidNow = co.status === "paid" && !co.revisit;
      if (paidNow && back.kind === "start") {
        a.navigate({ route: "start" });
        void a.startPending();
        return;
      }
      if (back.kind === "project" && (paidNow || co.status === "failed" || co.status === "error")) {
        a.navigate({ route: "project", projectId: back.projectId });
        // Вхід у проєкт скидає гілки проєкту (і ui.retry) — тож картку кладемо після нього.
        const retry = back.retry;
        if (paidNow && retry)
          store.setState((s) => ({
            ui: { ...s.ui, retry: { ctx: retry.ctx, plus: co.topup?.credits ?? 0, text: retry.text } },
          }));
        return;
      }
      a.navigate({ route: "cabinet", section: "balance" });
    },
  };
};
