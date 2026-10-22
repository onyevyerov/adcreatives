// @ts-check
/**
 * Вкладка «Використання» адмінки: дії `usage*` (ключі заморожені в `UsageActions`, contracts.js).
 *
 * - Стан — `store.getState().admin.usage`; усі зміни імутабельні (`admin: { ...s.admin, usage: { … } }`).
 * - Вхід на `?admin=usage` (`deps.onRoute`, адмін не `forbidden`) і будь-яка зміна періоду/джерела →
 *   «огляд»: `summary` + `users` + таблиця `all` (сторінка з її стану) паралельно через
 *   `Promise.allSettled`; розгорнутий користувач — ще й його `userProjects`. `loading` — поки летить
 *   огляд (чи показувати «Завантажую…», вирішує view: лише без даних). Успіх усіх трьох знімає `error`;
 *   будь-яка відмова → `error: true`, наявні дані лишаються. 401 не логується (обробляє ядро).
 * - Запити: огляд — `usageQuery(usage)`; `users` додає `{ sort, order }` з `usersSort`; таблиця проєктів —
 *   `{ search, sort, order, page, pageSize: USAGE_PAGE_SIZE }` (для «user» ще й `owner: expandedUserId`).
 * - Застарілі відповіді відкидаються окремими лічильниками послідовності: огляд, сортування користувачів
 *   і кожна таблиця. Гонка двох змін періоду закінчується даними останньої. Відповіді після виходу з
 *   адмінки відкидаються (як `onAdmin()` в admin-actions).
 * - Пошук таблиці: `q` пишеться одразу, `page: 1`, запит — через `USAGE_SEARCH_DEBOUNCE_MS` (таймер на
 *   таблицю); проміс дії завершується одразу після планування. Сортування й сторінка — запит одразу.
 * - `rangeError` (`to < from`) — запитів немає, відповіді, що летіли, відкидаються; доки він стоїть,
 *   жодна дія нічого не вантажить (діапазон хибний).
 * - `deps.offline` (`?mock=1`) — зміни стану працюють, запитів немає.
 */

import { initialUsageTable } from "../initial.js";
import { presetRange, USAGE_PAGE_SIZE, USAGE_SEARCH_DEBOUNCE_MS, usageQuery } from "../lib/usage.js";

/** @typedef {import("../contracts.js").PartFactory<keyof import("../contracts.js").UsageActions>} Factory */
/** @typedef {import("../contracts.js").UsageState} UsageState */
/** @typedef {import("../contracts.js").UsageProjectsTable} UsageProjectsTable */
/** @typedef {import("../contracts.js").UsageSort} UsageSort */
/** @typedef {"user" | "all"} TableName */

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/** Ключ таблиці у стані. @type {Record<TableName, "userProjects" | "all">} */
const TABLE_KEY = { user: "userProjects", all: "all" };

/**
 * Сортування: той самий ключ перемикає порядок, новий — `desc`.
 * @param {UsageSort} sort
 * @param {string} key
 * @returns {UsageSort}
 */
const toggleSort = (sort, key) => ({
  key,
  order: sort.key === key ? (sort.order === "desc" ? "asc" : "desc") : "desc",
});

/** @type {Factory} */
export const usageActions = (store, deps) => {
  const { api } = deps;

  /** @param {Partial<UsageState> | ((u: UsageState) => Partial<UsageState>)} patch */
  const setUsage = (patch) =>
    store.setState((s) => ({
      admin: {
        ...s.admin,
        usage: { ...s.admin.usage, ...(typeof patch === "function" ? patch(s.admin.usage) : patch) },
      },
    }));

  /** @param {TableName} which @param {Partial<UsageProjectsTable>} patch */
  const setTable = (which, patch) =>
    setUsage((u) => ({ [TABLE_KEY[which]]: { ...u[TABLE_KEY[which]], ...patch } }));

  const getUsage = () => store.getState().admin.usage;
  const onAdmin = () => store.getState().route === "admin";
  /** Запити можливі: не фікстури й період коректний. */
  const canFetch = () => !deps.offline && !getUsage().rangeError;

  /** Номери останніх запитів по потоках: відповіді старіших відкидаються. */
  let overviewSeq = 0;
  let usersSeq = 0;
  const tableSeq = { user: 0, all: 0 };
  /** Таймери debounce пошуку по таблицях. @type {Record<TableName, ReturnType<typeof setTimeout> | null>} */
  const timers = { user: null, all: null };

  /** @param {TableName} which */
  const clearTimer = (which) => {
    const t = timers[which];
    if (t !== null) clearTimeout(t);
    timers[which] = null;
  };

  /** Усі запити, що летять, і відкладені пошуки втрачають чинність. */
  const invalidateAll = () => {
    overviewSeq++;
    usersSeq++;
    tableSeq.user++;
    tableSeq.all++;
    clearTimer("user");
    clearTimer("all");
  };

  /** @param {string} what @param {unknown} err */
  const logFail = (what, err) => {
    if (statusOf(err) !== 401) console.warn(`[usage] ${what}`, err);
  };

  /**
   * Запит таблиці проєктів зі стану.
   * @param {UsageState} u
   * @param {TableName} which
   */
  const tableQuery = (u, which) => {
    const t = u[TABLE_KEY[which]];
    return {
      ...usageQuery(u),
      ...(which === "user" && u.expandedUserId ? { owner: u.expandedUserId } : {}),
      search: t.q.trim() || undefined,
      sort: t.sort.key,
      order: t.sort.order,
      page: t.page,
      pageSize: USAGE_PAGE_SIZE,
    };
  };

  /**
   * Огляд: summary + users + таблиця `all` паралельно. Скасовує запити users і `all`, що летіли.
   * @returns {Promise<boolean>} `false` — актуальний запит завершився відмовою
   */
  async function loadOverview() {
    if (!canFetch()) return true;
    const my = ++overviewSeq;
    const myUsers = ++usersSeq;
    const myAll = ++tableSeq.all;
    clearTimer("all");
    const u = getUsage();
    const q = usageQuery(u);
    setUsage((cur) => ({ loading: true, all: { ...cur.all, loading: true } }));

    const [summary, users, all] = await Promise.allSettled([
      api.adminUsageSummary(q),
      api.adminUsageUsers({ ...q, sort: u.usersSort.key, order: u.usersSort.order }),
      api.adminUsageProjects(tableQuery(u, "all")),
    ]);
    if (!onAdmin()) return true;

    const live = my === overviewSeq;
    const usersLive = myUsers === usersSeq;
    const allLive = myAll === tableSeq.all;
    let failed = false;
    for (const [r, isLive] of /** @type {const} */ ([
      [summary, live],
      [users, usersLive],
      [all, allLive],
    ])) {
      if (r.status === "rejected" && isLive) {
        failed = true;
        logFail("load", r.reason);
      }
    }

    setUsage((cur) => {
      /** @type {Partial<UsageState>} */
      const patch = {};
      if (live) {
        patch.loading = false;
        if (summary.status === "fulfilled") patch.summary = summary.value;
        patch.error = failed;
      } else if (failed) {
        patch.error = true;
      }
      if (usersLive && users.status === "fulfilled") patch.users = users.value.users;
      if (allLive)
        patch.all = {
          ...cur.all,
          loading: false,
          ...(all.status === "fulfilled" ? { data: all.value } : {}),
        };
      return patch;
    });
    return !failed;
  }

  /**
   * Таблиця проєктів: «all» або «user» (проєкти розгорнутого користувача).
   * @param {TableName} which
   * @returns {Promise<boolean>} `false` — актуальний запит завершився відмовою
   */
  async function loadTable(which) {
    clearTimer(which);
    if (!canFetch()) return true;
    const u = getUsage();
    if (which === "user" && !u.expandedUserId) return true;
    const my = ++tableSeq[which];
    setTable(which, { loading: true });
    try {
      const data = await api.adminUsageProjects(tableQuery(u, which));
      if (my !== tableSeq[which] || !onAdmin()) return true;
      setTable(which, { data, loading: false });
      return true;
    } catch (err) {
      if (my !== tableSeq[which] || !onAdmin()) return true;
      logFail(which === "user" ? "user projects" : "projects", err);
      setTable(which, { loading: false });
      setUsage({ error: true });
      return false;
    }
  }

  /** Користувачі з поточним сортуванням (без огляду). @returns {Promise<void>} */
  async function loadUsers() {
    if (!canFetch()) return;
    const my = ++usersSeq;
    const u = getUsage();
    try {
      const res = await api.adminUsageUsers({
        ...usageQuery(u),
        sort: u.usersSort.key,
        order: u.usersSort.order,
      });
      if (my !== usersSeq || !onAdmin()) return;
      setUsage({ users: res.users });
    } catch (err) {
      if (my !== usersSeq || !onAdmin()) return;
      logFail("users", err);
      setUsage({ error: true });
    }
  }

  /**
   * Огляд + проєкти розгорнутого користувача. Успіх огляду не знімає відмову таблиці користувача
   * з того ж перезавантаження.
   * @returns {Promise<void>}
   */
  async function reloadAll() {
    const ok = await Promise.all([loadOverview(), getUsage().expandedUserId ? loadTable("user") : true]);
    if (ok.includes(false)) setUsage({ error: true });
  }

  /** Обидві таблиці — на першу сторінку (зміна періоду / джерела). */
  const resetPages = () =>
    setUsage((u) => ({
      userProjects: { ...u.userProjects, page: 1 },
      all: { ...u.all, page: 1 },
    }));

  deps.onRoute((route) => {
    if (route.route !== "admin" || route.tab !== "usage") return;
    if (store.getState().admin.forbidden) return;
    void reloadAll();
  });

  return {
    async usagePreset(preset) {
      if (preset === "custom") {
        setUsage({ preset: "custom", rangeError: false });
        return;
      }
      setUsage({ preset, range: presetRange(preset, new Date()), rangeError: false });
      resetPages();
      await reloadAll();
    },

    async usageRange(range) {
      setUsage({ preset: "custom", range });
      if (range.from && range.to && range.to < range.from) {
        invalidateAll();
        setUsage((u) => ({
          rangeError: true,
          loading: false,
          userProjects: { ...u.userProjects, loading: false },
          all: { ...u.all, loading: false },
        }));
        return;
      }
      setUsage({ rangeError: false });
      resetPages();
      await reloadAll();
    },

    async usageSource(source) {
      setUsage({ source });
      resetPages();
      await reloadAll();
    },

    async usageSortUsers(key) {
      setUsage((u) => ({ usersSort: toggleSort(u.usersSort, key) }));
      await loadUsers();
    },

    async usageToggleUser(id) {
      const u = getUsage();
      // Попередня таблиця користувача (і відкладений пошук по ній) втрачає чинність.
      tableSeq.user++;
      clearTimer("user");
      const projectInIt =
        u.expandedProjectId !== null &&
        !!u.userProjects.data?.items.some((p) => p.projectId === u.expandedProjectId);
      const expandedProjectId = projectInIt ? null : u.expandedProjectId;
      if (u.expandedUserId === id) {
        setUsage({ expandedUserId: null, userProjects: initialUsageTable(), expandedProjectId });
        return;
      }
      setUsage({
        expandedUserId: id,
        userProjects: { ...initialUsageTable(), loading: canFetch() },
        expandedProjectId,
      });
      await loadTable("user");
    },

    async usageProjects(table, patch) {
      const key = TABLE_KEY[table];
      const t = getUsage()[key];
      const hasQ = patch.q !== undefined;
      const hasSort = patch.sort !== undefined;
      /** @type {Partial<UsageProjectsTable>} */
      const next = {};
      if (hasQ) next.q = patch.q;
      if (hasSort && patch.sort !== undefined) next.sort = toggleSort(t.sort, patch.sort);
      next.page = patch.page ?? (hasQ || hasSort ? 1 : t.page);
      if (!hasQ && !hasSort && patch.page === undefined) return;
      setTable(table, next);
      if (hasQ) {
        clearTimer(table);
        timers[table] = setTimeout(() => {
          timers[table] = null;
          void loadTable(table);
        }, USAGE_SEARCH_DEBOUNCE_MS);
        return;
      }
      await loadTable(table);
    },

    usageToggleProject(id) {
      setUsage((u) => ({ expandedProjectId: u.expandedProjectId === id ? null : id }));
    },

    async usageReload() {
      await reloadAll();
    },
  };
};
