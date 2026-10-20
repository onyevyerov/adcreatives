// @ts-check
/**
 * B9 · Історія і мої проєкти (N11-B, N12-B).
 *
 * - Дані — на вході в маршрут (`deps.onRoute`): «Історія» → перша сторінка леджера і, якщо ще не
 *   завантажені, проєкти (хост у рядку історії рахує фронтенд з `projects`); «Мої проєкти» →
 *   `GET /api/projects`.
 * - `loadHistory(more?)` — сторінка по `HISTORY_LIMIT`, новіші першими; `more` — наступна від
 *   `nextBefore`, дописується в кінець без дублів (за `id`). Відповідь, яку обігнав новіший запит,
 *   відкидається.
 * - `loadProjects()` — рядки кабінету + `account.projectCount` («Мої проєкти · N»).
 * - `toggleProjectCredits(id)` — розгорнути / згорнути розбивку витрат картки.
 * - `openProject(id)` — маршрут project.
 * У `?mock=1` (`deps.offline`) мережі немає: дані — з dev/fixtures/_base.js (Олена).
 */

/** @typedef {import("../contracts.js").PartFactory<"loadHistory" | "loadProjects" | "toggleProjectCredits" | "openProject">} Factory */
/** @typedef {import("../contracts.js").CabinetState} CabinetState */
/** @typedef {import("../contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../contracts.js").Store} Store */

/** Записів леджера на сторінку («Показати ще»). */
export const HISTORY_LIMIT = 50;

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/**
 * Старі записи + нова сторінка без повторів (за `id`), порядок — як прийшов.
 * @param {LedgerEntry[]} entries
 * @param {LedgerEntry[]} page
 * @returns {LedgerEntry[]}
 */
function appendPage(entries, page) {
  const seen = new Set(entries.map((e) => e.id));
  const out = [...entries];
  for (const e of page) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** @type {Factory} */
export const cabinetActions = (store, deps) => {
  /** @param {Partial<CabinetState["history"]>} patch */
  const setHistory = (patch) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, history: { ...s.cabinet.history, ...patch } } }));
  /** @param {Partial<CabinetState["projects"]>} patch */
  const setProjects = (patch) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, projects: { ...s.cabinet.projects, ...patch } } }));

  /** Номери останніх запитів: відповіді старіших відкидаються. */
  let historySeq = 0;
  let projectsSeq = 0;

  /** Дані Олени для `?mock=1` — без мережі. */
  const mockData = () => import("../../dev/fixtures/_base.js");

  /** @param {boolean} [more] */
  async function loadHistory(more = false) {
    const h = store.getState().cabinet.history;
    if (more && (h.loading || !h.nextBefore)) return;
    const before = more ? h.nextBefore : null;
    const my = ++historySeq;
    setHistory({ loading: true });
    try {
      const page = deps.offline
        ? { entries: (await mockData()).HISTORY, nextBefore: null }
        : await deps.api.transactions({ limit: HISTORY_LIMIT, before });
      if (my !== historySeq) return;
      const entries = Array.isArray(page.entries) ? page.entries : [];
      const nextBefore = page.nextBefore ?? null;
      setHistory({
        entries: more ? appendPage(store.getState().cabinet.history.entries, entries) : entries,
        nextBefore,
        more: nextBefore !== null,
        loading: false,
      });
    } catch (err) {
      if (my !== historySeq) return;
      setHistory({ loading: false });
      // 401 обробило ядро (setUnauthorizedHandler).
      if (statusOf(err) !== 401) console.warn("[cabinet] transactions", err);
    }
  }

  async function loadProjects() {
    const my = ++projectsSeq;
    setProjects({ loading: true });
    try {
      const rows = deps.offline ? (await mockData()).PROJECTS : (await deps.api.listProjects()).projects;
      if (my !== projectsSeq) return;
      const list = Array.isArray(rows) ? rows : [];
      setProjects({ rows: list, loading: false });
      store.setState((s) => ({ account: { ...s.account, projectCount: list.length } }));
    } catch (err) {
      if (my !== projectsSeq) return;
      setProjects({ loading: false });
      if (statusOf(err) !== 401) console.warn("[cabinet] listProjects", err);
    }
  }

  deps.onRoute((route) => {
    if (route.route !== "cabinet") return;
    if (route.section === "history") {
      void loadHistory();
      if (store.getState().cabinet.projects.rows === null) void loadProjects();
    } else if (route.section === "projects") void loadProjects();
  });

  return {
    loadHistory,
    loadProjects,
    toggleProjectCredits(id) {
      const open = store.getState().cabinet.projects.open;
      setProjects({ open: open === id ? null : id });
    },
    openProject(id) {
      deps.actions().navigate({ route: "project", projectId: id });
    },
  };
};
