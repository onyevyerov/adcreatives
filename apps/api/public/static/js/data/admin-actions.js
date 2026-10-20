// @ts-check
/**
 * B11 · Адмінка (N14-A): дії `admin*` (ключі заморожені в `AccountActions`, contracts.js).
 *
 * - Дані маршруту — у `deps.onRoute`: користувачі, outbox і всі проєкти (`?all=1`) вантажаться
 *   разом, бо лічильники всіх трьох вкладок видно завжди; `loading` — лише поки перших даних
 *   немає, далі оновлення тихе. Обраний користувач (`?admin=users&user=<id>`) — `adminUser` +
 *   останні операції; при старті сторінки ядро ставить `selectedId`, а `selected` лишає `null`.
 * - Пошук фільтрує на клієнті (view), дія лише пише `q`.
 * - Коригування: ціле ≠ 0, примітка ≤ 200; списання нижче нуля — помилка без запиту; списання
 *   ≥ 20 або > 50% балансу — спершу підтвердження. `POST /api/admin/users/:id/credits` →
 *   новий запис зверху, `done`; 402 → `{ need: required, have: available }`.
 * - «Копіювати» — `navigator.clipboard.writeText(link)` → `copied` на `COPIED_MS`.
 * - `deps.offline` (`?mock=1`) — без мережі: дії працюють лише на стані.
 */

/** @typedef {import("../contracts.js").PartFactory<"adminTab" | "adminSearch" | "adminSelect" | "adminField" | "adminAdjust" | "adminCancelConfirm" | "adminCopy">} Factory */
/** @typedef {import("../contracts.js").AdminState} AdminState */
/** @typedef {import("../contracts.js").Route} Route */
/** @typedef {import("../contracts.js").Store} Store */

/** Скільки показує «✓ Скопійовано». */
export const COPIED_MS = 2000;
/** Останні операції в панелі користувача. */
export const PANEL_ENTRIES = 5;
/** Максимум символів примітки (= бекенд). */
export const NOTE_MAX = 200;
/** Списання від стількох кредитів — лише з підтвердженням. */
export const CONFIRM_FROM = 20;

/**
 * Поле «Кредити» → ціле число ≠ 0 або `null` («+5», «−3» з U+2212, пробіли ігноруються).
 * @param {string} raw
 * @returns {number | null}
 */
export function parseCredits(raw) {
  const s = String(raw ?? "")
    .replace(/−/g, "-")
    .replace(/\s/g, "");
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

/**
 * Потрібне підтвердження: списання ≥ 20 або більше половини балансу.
 * @param {number} credits
 * @param {number} balance
 */
export function needsConfirm(credits, balance) {
  return credits < 0 && (-credits >= CONFIRM_FROM || -credits > balance / 2);
}

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/** @param {unknown} err @returns {Record<string, unknown>} */
const bodyOf = (err) =>
  typeof err === "object" && err !== null && "body" in err && typeof err.body === "object" && err.body
    ? /** @type {Record<string, unknown>} */ (err.body)
    : {};

/** @type {Factory} */
export const adminActions = (store, deps) => {
  const { api } = deps;

  /** @param {Partial<AdminState> | ((a: AdminState) => Partial<AdminState>)} patch */
  const setAdmin = (patch) =>
    store.setState((s) => ({
      admin: { ...s.admin, ...(typeof patch === "function" ? patch(s.admin) : patch) },
    }));

  /** @param {Partial<AdminState["adjust"]>} patch */
  const setAdjust = (patch) => setAdmin((a) => ({ adjust: { ...a.adjust, ...patch } }));

  /** Списки вже приходили — далі оновлюємо без «Завантажую…». */
  let loaded = false;
  /** Номер останнього завантаження списків: відповіді старіших відкидаються. */
  let listSeq = 0;
  /** Завантаження обраного користувача, що летить. @type {{ id: string, promise: Promise<void> } | null} */
  let selecting = null;
  /** Обраний користувач — щоб вкладка «Користувачі» повертала його після Outbox / Усіх проєктів. */
  let lastUserId = /** @type {string | null} */ (null);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let copiedTimer = null;

  const onAdmin = () => store.getState().route === "admin";

  async function loadLists() {
    if (deps.offline) return;
    const my = ++listSeq;
    // Після виходу ядро скидає адмінку до початкової — тоді знову з «Завантажую…».
    if (!loaded || store.getState().admin.users.length === 0) setAdmin({ loading: true });
    const [users, outbox, all] = await Promise.allSettled([
      api.adminUsers(),
      api.adminOutbox(),
      api.listProjects({ all: true }),
    ]);
    if (my !== listSeq || !onAdmin()) return;
    /** @type {Partial<AdminState>} */
    const patch = { loading: false };
    if (users.status === "fulfilled") patch.users = users.value.users;
    if (outbox.status === "fulfilled") patch.outbox = outbox.value.mails;
    if (all.status === "fulfilled") patch.allProjects = all.value.projects;
    for (const r of [users, outbox, all])
      if (r.status === "rejected" && statusOf(r.reason) !== 401) console.warn("[admin] load", r.reason);
    if (users.status === "fulfilled") loaded = true;
    setAdmin(patch);
  }

  /**
   * Обраний користувач: профіль, баланс і останні операції.
   * @param {string} id
   * @returns {Promise<void>}
   */
  function loadSelected(id) {
    if (selecting?.id === id) return selecting.promise;
    if (deps.offline) return Promise.resolve();
    const promise = (async () => {
      try {
        const [{ user, balance }, { entries }] = await Promise.all([
          api.adminUser(id),
          api.adminTransactions(id, { limit: PANEL_ENTRIES }),
        ]);
        if (store.getState().admin.selectedId !== id) return;
        setAdmin((a) => ({
          selected: { user, balance, entries },
          users: a.users.map((u) => (u.id === id ? { ...u, ...user, balance } : u)),
        }));
      } catch (err) {
        if (statusOf(err) !== 401) console.warn("[admin] user", err);
      } finally {
        if (selecting?.id === id) selecting = null;
      }
    })();
    selecting = { id, promise };
    return promise;
  }

  deps.onRoute((route) => {
    if (route.route !== "admin") return;
    const s = store.getState().admin;
    if (s.forbidden) return;
    void loadLists();
    if (s.selectedId) {
      lastUserId = s.selectedId;
      if (s.selected?.user.id !== s.selectedId) void loadSelected(s.selectedId);
    }
  });

  return {
    adminTab(tab) {
      const s = store.getState().admin;
      if (store.getState().route === "admin" && s.tab === tab) return;
      if (s.selectedId) lastUserId = s.selectedId;
      setAdjust({ confirm: false, error: null, done: null });
      deps.actions().navigate({
        route: "admin",
        tab,
        ...(tab === "users" && lastUserId ? { userId: lastUserId } : {}),
      });
    },

    adminSearch(q) {
      setAdmin({ q });
    },

    async adminSelect(id) {
      const s = store.getState();
      lastUserId = id;
      if (s.route === "admin" && s.admin.tab === "users" && s.admin.selectedId === id && s.admin.selected)
        return;
      setAdjust({ credits: "", note: "", busy: false, confirm: false, error: null, done: null });
      deps.actions().navigate({ route: "admin", tab: "users", userId: id });
      // Навігація вже могла запустити завантаження з onRoute — тоді той самий проміс.
      if (store.getState().admin.selectedId === id && store.getState().admin.selected?.user.id !== id)
        await loadSelected(id);
    },

    adminField(key, value) {
      setAdjust({ [key]: value, error: null, done: null, ...(key === "credits" ? { confirm: false } : {}) });
    },

    async adminAdjust(confirmed = false) {
      const { admin } = store.getState();
      const { adjust, selected } = admin;
      if (adjust.busy || !selected) return;
      const credits = parseCredits(adjust.credits);
      if (credits === null) return setAdjust({ error: "zero", confirm: false, done: null });
      if (adjust.note.length > NOTE_MAX) return setAdjust({ error: "note", confirm: false, done: null });
      const balance = selected.balance;
      if (balance + credits < 0)
        return setAdjust({ error: { need: -credits, have: balance }, confirm: false, done: null });
      if (needsConfirm(credits, balance) && !confirmed)
        return setAdjust({ confirm: true, error: null, done: null });
      if (deps.offline) return;

      const id = selected.user.id;
      const note = adjust.note.trim();
      setAdjust({ busy: true, confirm: false, error: null, done: null });
      try {
        const res = await api.adminCredits(id, { credits, note });
        setAdmin((a) => ({
          users: a.users.map((u) => (u.id === id ? { ...u, balance: res.balance } : u)),
          selected:
            a.selected?.user.id === id
              ? { ...a.selected, balance: res.balance, entries: [res.entry, ...a.selected.entries] }
              : a.selected,
          adjust: {
            credits: "",
            note: "",
            busy: false,
            confirm: false,
            error: null,
            done: { credits, note, balance: res.balance },
          },
        }));
        // Адмін скоригував сам себе — баланс у топбарі.
        if (store.getState().account.me?.user.id === id) void deps.actions().refreshMe();
      } catch (err) {
        const status = statusOf(err);
        if (status === 402) {
          const body = bodyOf(err);
          const need = typeof body.required === "number" ? body.required : -credits;
          const have = typeof body.available === "number" ? body.available : balance;
          setAdmin((a) => ({
            selected: a.selected?.user.id === id ? { ...a.selected, balance: have } : a.selected,
            adjust: { ...a.adjust, busy: false, error: { need, have } },
          }));
        } else if (status === 400) {
          setAdjust({ busy: false, error: "zero" });
        } else {
          if (status !== 401) console.warn("[admin] credits", err);
          setAdjust({ busy: false });
        }
      }
    },

    adminCancelConfirm() {
      setAdjust({ confirm: false });
    },

    async adminCopy(mailId) {
      const mail = store.getState().admin.outbox.find((m) => m.id === mailId);
      if (!mail) return;
      try {
        await globalThis.navigator.clipboard.writeText(mail.link);
      } catch (err) {
        console.warn("[admin] clipboard", err);
        return;
      }
      if (copiedTimer) clearTimeout(copiedTimer);
      setAdmin({ copied: mailId });
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        if (store.getState().admin.copied === mailId) setAdmin({ copied: null });
      }, COPIED_MS);
    },
  };
};
