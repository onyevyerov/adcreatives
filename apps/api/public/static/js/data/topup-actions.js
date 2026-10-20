// @ts-check
/**
 * B7 · Поповнення в кабінеті (N8-B, N9-A).
 *
 * - `openTopup(o)` — точка повернення після оплати (`saveReturn`: start → `{kind:"start"}`, ws →
 *   `{kind:"project", projectId, host, retry:{ctx, text}}`, topbar → `{kind:"cabinet"}`), банер /
 *   «← до host» (`cabinet.backTo`), передвибір пакета (`packageId`, інакше пакет, що закриває
 *   нестачу, — `closingPackage`; `custom` → режим «своя сума») і перехід у «Баланс».
 * - `selectPackage(id)` / `setCustom(value)` — вибір тайла і поле «своя сума» (помилка знімається).
 * - `submitTopup()` — перевірка своєї суми (`customError`: ціле, `custom.min…max`) →
 *   `POST /api/billing/topups` → чек `/?checkout=<id>`.
 * - `continueTopup(id)` — незавершене поповнення → його чек.
 * Незавершені поповнення (`GET /api/billing/topups`, статус pending) вантажаться на вході в
 * «Баланс» (`deps.onRoute`); у `?mock=1` мережі немає.
 * `cabinet.backTo` — звідки прийшли: `openTopup` ставить його сам; будь-який інший вхід у кабінет
 * з проєкту — `{kind:"project", retry:null}` (лише «← до host», без банера), з решти маршрутів — `null`.
 */
import { parseCreditMessage } from "../lib/credit-messages.js";
import { closingPackage } from "../lib/credits.js";
import { saveReturn } from "../lib/pending.js";

/** @typedef {import("../contracts.js").PartFactory<"openTopup" | "selectPackage" | "setCustom" | "submitTopup" | "continueTopup">} Factory */
/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").CabinetState} CabinetState */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").ReturnTo} ReturnTo */
/** @typedef {import("../contracts.js").AccountActions} AccountActions */
/** @typedef {Parameters<AccountActions["openTopup"]>[0]} TopupOpen */
/** @typedef {"empty" | "integer" | "range"} CustomError */

/**
 * Помилка своєї суми: порожньо / не ціле / поза межами; `null` — сума годиться.
 * @param {string} raw
 * @param {{ min: number, max: number }} limits
 * @returns {CustomError | null}
 */
export function customError(raw, limits) {
  const v = raw.trim();
  if (!v) return "empty";
  if (!/^[-+]?\d+$/.test(v)) return "integer";
  const n = Number(v);
  return n < limits.min || n > limits.max ? "range" : null;
}

/**
 * Пакет за замовчуванням, поки нічого не обрано (`packageId: null`): середній за списком
 * (Референс: «Кілька роликів» із трьох).
 * @param {readonly CreditPackage[]} packages
 * @returns {CreditPackage | null}
 */
export function defaultPackage(packages) {
  return packages[Math.floor(packages.length / 2)] ?? null;
}

/**
 * Обраний пакет: `packageId` зі списку; `null` — пакет за замовчуванням; невідомий id — нічого.
 * @param {CabinetState["topup"]} topup
 * @param {readonly CreditPackage[]} packages
 * @returns {CreditPackage | null}
 */
export function selectedPackage(topup, packages) {
  if (topup.mode !== "package") return null;
  if (topup.packageId === null) return defaultPackage(packages);
  return packages.find((p) => p.id === topup.packageId) ?? null;
}

/**
 * Скільки кредитів поповнюємо зараз: пакет або коректна своя сума; `null` — нічого.
 * @param {CabinetState["topup"]} topup
 * @param {import("../contracts.js").Me} me
 * @returns {number | null}
 */
export function selectedCredits(topup, me) {
  if (topup.mode === "custom")
    return customError(topup.custom, me.custom) === null ? Number(topup.custom.trim()) : null;
  return selectedPackage(topup, me.packages)?.credits ?? null;
}

/**
 * Що повторити після оплати з проєкту: явно передане, інакше після видачі — правка, до — ЧП3.
 * @param {UiState} s
 * @param {TopupOpen} o
 * @returns {"cp3" | "rev"}
 */
const ctxOf = (s, o) => o.ctx ?? (s.status === "delivered" ? "rev" : "cp3");

/**
 * Нестача, яку має закрити поповнення: старт — ціна ролика (або K3 старту); проєкт — остання
 * відмова в чаті (`need − have`), інакше ціна правки для `rev`; топбар — невідомо.
 * @param {UiState} s
 * @param {TopupOpen} o
 * @returns {number | null}
 */
function shortOf(s, o) {
  const me = s.account.me;
  if (!me) return null;
  const prices = s.account.prices ?? me.prices;
  if (o.from === "start") {
    const k3 = s.ui.startShortage;
    return k3 ? k3.need - k3.have : prices.video - me.balance;
  }
  if (o.from === "ws") {
    for (let i = s.feed.length - 1; i >= 0; i--) {
      const f = s.feed[i];
      if (f?.kind !== "message" || f.role !== "assistant") continue;
      const m = parseCreditMessage(f.text);
      if (m && (m.kind === "insufficient" || m.kind === "insufficientFormats")) return m.need - m.have;
    }
    if (ctxOf(s, o) === "rev") return prices.revision - me.balance;
  }
  return null;
}

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/** @type {Factory} */
export const topupActions = (store, deps) => {
  /** @param {Partial<CabinetState>} patch */
  const cab = (patch) => store.setState((s) => ({ cabinet: { ...s.cabinet, ...patch } }));
  /** @param {Partial<CabinetState["topup"]>} patch */
  const topup = (patch) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, topup: { ...s.cabinet.topup, ...patch } } }));

  // Вхід у кабінет не через openTopup: з проєкту — лише «← до host», з решти — без повернення.
  let opening = false;
  store.subscribe((s, prev) => {
    if (opening || s.route !== "cabinet" || prev.route === "cabinet") return;
    cab({
      backTo:
        prev.route === "project" && prev.projectId
          ? { kind: "project", projectId: prev.projectId, host: prev.site, retry: null }
          : null,
    });
  });

  let pendingSeq = 0;
  async function loadPending() {
    if (deps.offline) return;
    const my = ++pendingSeq;
    try {
      const { topups } = await deps.api.listTopUps();
      if (my !== pendingSeq) return;
      cab({ pendingTopups: (topups ?? []).filter((t) => t.status === "pending") });
    } catch (err) {
      // 401 обробило ядро; список незавершених — не критичний.
      if (statusOf(err) !== 401) console.warn("[topup] listTopUps", err);
    }
  }

  deps.onRoute((r) => {
    if (r.route === "cabinet" && r.section === "balance") void loadPending();
  });

  return {
    openTopup(o) {
      const s = store.getState();
      const fromProject = s.route === "project" && s.projectId !== null;
      /** @type {ReturnTo} */
      let back;
      if (o.from === "start") back = { kind: "start" };
      else if (o.from === "ws" && fromProject && s.projectId)
        back = {
          kind: "project",
          projectId: s.projectId,
          host: s.site,
          retry: { ctx: ctxOf(s, o), text: o.text ?? null },
        };
      else back = { kind: "cabinet" };
      saveReturn(back);

      const me = s.account.me;
      /** @type {Partial<CabinetState["topup"]>} */
      let pick = {};
      if (o.custom !== undefined) pick = { mode: "custom", custom: String(o.custom) };
      else if (o.packageId) pick = { mode: "package", packageId: o.packageId };
      else {
        const short = shortOf(s, o);
        if (me && me.packages.length > 0 && short !== null && short > 0)
          pick = { mode: "package", packageId: closingPackage(me.packages, short).id };
      }
      const backTo =
        back.kind === "cabinet"
          ? fromProject && s.projectId
            ? { kind: /** @type {const} */ ("project"), projectId: s.projectId, host: s.site, retry: null }
            : null
          : back;
      store.setState((st) => ({
        cabinet: {
          ...st.cabinet,
          backTo,
          topup: { ...st.cabinet.topup, ...pick, error: false, busy: false },
        },
      }));
      opening = true;
      try {
        deps.actions().navigate({ route: "cabinet", section: "balance" });
      } finally {
        opening = false;
      }
    },

    selectPackage(id) {
      if (id === "custom") topup({ mode: "custom", error: false });
      else topup({ mode: "package", packageId: id, error: false });
    },

    setCustom(value) {
      topup({ mode: "custom", custom: value, error: false });
    },

    async submitTopup() {
      const s = store.getState();
      const t = s.cabinet.topup;
      const me = s.account.me;
      if (t.busy || !me) return;
      /** @type {{ packageId: string } | { credits: number }} */
      let body;
      if (t.mode === "custom") {
        if (customError(t.custom, me.custom) !== null) {
          topup({ error: true });
          return;
        }
        body = { credits: Number(t.custom.trim()) };
      } else {
        const pkg = selectedPackage(t, me.packages);
        if (!pkg) return;
        body = { packageId: pkg.id };
      }
      if (deps.offline) {
        console.info("[topup] ?mock=1: оплата без бекенду недоступна", body);
        return;
      }
      topup({ busy: true, error: false });
      try {
        const { topup: created } = await deps.api.createTopUp(body);
        topup({ busy: false });
        deps.actions().navigate({ route: "checkout", id: created.id });
      } catch (err) {
        topup({ busy: false });
        if (statusOf(err) !== 401) console.warn("[topup] createTopUp", err);
      }
    },

    continueTopup(id) {
      deps.actions().navigate({ route: "checkout", id });
    },
  };
};
