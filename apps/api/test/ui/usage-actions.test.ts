// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ME, accountFixture } from "../../public/static/dev/fixtures/_base.js";
import type {
  PartDeps,
  Route,
  UiState,
  UsageProjectRow,
  UsageProjectsPage,
  UsageState,
  UsageSummary,
  UsageUserRow,
} from "../../public/static/js/contracts.js";
import * as realApi from "../../public/static/js/data/account-api.js";
import { ApiError } from "../../public/static/js/data/api.js";
import { usageActions } from "../../public/static/js/data/usage-actions.js";
import { initialUsage, initialUsageTable } from "../../public/static/js/initial.js";
import { USAGE_PAGE_SIZE, USAGE_SEARCH_DEBOUNCE_MS } from "../../public/static/js/lib/usage.js";
import { createStore } from "../../public/static/js/store.js";

/** «Зараз» тестів: від нього рахуються пресети (30d → 2026-09-23 … 2026-10-22). */
const NOW = new Date("2026-10-22T10:00:00.000Z");
const RANGE_30D = { from: "2026-09-23", to: "2026-10-22" };

// ───────────── Фікстури відповідей ─────────────

const aggregate = (usd: number) => ({
  calls: 1,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  audioSeconds: 0,
  renders: 0,
  usd,
});

const summaryOf = (usd: number) =>
  ({
    from: null,
    to: null,
    source: "chat",
    totals: {
      ...aggregate(usd),
      users: 1,
      projects: 1,
      delivered: 0,
      avgUsdPerDelivered: null,
      avgUsdPerRevision: null,
      creditsCharged: null,
      creditsUsd: null,
      marginUsd: null,
    },
    byModel: [],
    byStage: [],
    system: aggregate(0),
  }) as UsageSummary;

const userOf = (id: string, usd: number) =>
  ({
    ...aggregate(usd),
    id,
    email: `${id}@example.com`,
    name: id,
    createdAt: "2026-10-02T00:00:00.000Z",
    projects: 1,
    delivered: 0,
    creditsCharged: null,
    marginUsd: null,
    byModel: [],
  }) as UsageUserRow;

const projectOf = (projectId: string, usd = 1) =>
  ({
    ...aggregate(usd),
    projectId,
    ownerId: null,
    ownerEmail: null,
    host: "zerno.example.com",
    url: "https://zerno.example.com/",
    status: "delivered",
    createdAt: "2026-10-03T00:00:00.000Z",
    firstDeliveredAt: null,
    revisions: 0,
    firstDeliveryUsd: usd,
    revisionUsd: 0,
    byModel: [],
    byStage: [],
  }) as UsageProjectRow;

const pageOf = (items: UsageProjectRow[], page = 1) =>
  ({
    owner: null,
    from: null,
    to: null,
    source: "chat",
    page,
    pageSize: USAGE_PAGE_SIZE,
    total: items.length,
    items,
    totals: aggregate(items.reduce((s, p) => s + p.usd, 0)),
  }) as UsageProjectsPage;

const usersRes = (users: UsageUserRow[]) => ({ from: null, to: null, users });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Мікрозадачі — щоб доїхали відповіді фейкового API. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// ───────────── Стенд ─────────────

type Query = Record<string, unknown>;

/** API вкладки без мережі: кожна функція — мок; за замовчуванням прості дані. */
function fakeApi() {
  const all = Object.fromEntries(Object.keys(realApi).map((k) => [k, vi.fn(async () => ({}))]));
  return {
    ...all,
    adminUsageSummary: vi.fn(async (_q: Query) => summaryOf(10)),
    adminUsageUsers: vi.fn(async (_q: Query) => usersRes([userOf("u_olena", 5), userOf("u_andriy", 3)])),
    adminUsageProjects: vi.fn(async (q: Query) =>
      pageOf([projectOf(q.owner ? "p_user" : "p_all")], Number(q.page ?? 1)),
    ),
  } as unknown as typeof realApi & {
    adminUsageSummary: ReturnType<typeof vi.fn>;
    adminUsageUsers: ReturnType<typeof vi.fn>;
    adminUsageProjects: ReturnType<typeof vi.fn>;
  };
}

function usageState(usage: Partial<UsageState> = {}, admin: Partial<UiState["admin"]> = {}): UiState {
  const s = accountFixture({ route: "admin", account: { me: ADMIN_ME } });
  return {
    ...s,
    admin: { ...s.admin, tab: "usage", ...admin, usage: { ...initialUsage(NOW), ...usage } },
  };
}

function makeUsage(state: UiState, opts: { offline?: boolean } = {}) {
  const store = createStore<UiState>(state);
  const api = fakeApi();
  const routeFns: ((r: Route) => void)[] = [];
  const deps = {
    params: new URLSearchParams(""),
    api,
    actions: () => {
      throw new Error("не потрібно");
    },
    backend: {},
    offline: opts.offline ?? false,
    onRoute: (fn: (r: Route) => void) => {
      routeFns.push(fn);
    },
  } as unknown as PartDeps;
  const own = usageActions(store, deps);
  const usage = () => store.getState().admin.usage;
  const enter = (route: Route = { route: "admin", tab: "usage" }) => {
    for (const fn of routeFns) fn(route);
  };
  /** Скидає лічильники викликів (стан лишається). */
  const clearCalls = () => {
    api.adminUsageSummary.mockClear();
    api.adminUsageUsers.mockClear();
    api.adminUsageProjects.mockClear();
  };
  return { store, api, own, usage, enter, clearCalls };
}

/** Користувач `u_olena` розгорнутий, його проєкти й проєкт `p_user` завантажені. */
const withExpandedUser = (extra: Partial<UsageState> = {}): Partial<UsageState> => ({
  summary: summaryOf(10),
  users: [userOf("u_olena", 5), userOf("u_andriy", 3)],
  expandedUserId: "u_olena",
  userProjects: { ...initialUsageTable(), data: pageOf([projectOf("p_user")]) },
  all: { ...initialUsageTable(), data: pageOf([projectOf("p_all")]) },
  ...extra,
});

const projectsArgs = (extra: Query = {}) => ({
  ...RANGE_30D,
  search: undefined,
  sort: "usd",
  order: "desc",
  page: 1,
  pageSize: USAGE_PAGE_SIZE,
  ...extra,
});

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ───────────── Вхід у маршрут ─────────────

describe("usage-actions: вхід на /stats", () => {
  it("вантажить summary + users + all (сторінка 1) паралельно; loading летить, далі дані", async () => {
    const { api, usage, enter } = makeUsage(usageState());
    const sum = deferred<UsageSummary>();
    api.adminUsageSummary.mockReturnValueOnce(sum.promise);
    expect(usage().loading).toBe(false);
    enter();
    expect(usage().loading).toBe(true);
    expect(usage().all.loading).toBe(true);
    expect(api.adminUsageSummary).toHaveBeenCalledWith(RANGE_30D);
    expect(api.adminUsageUsers).toHaveBeenCalledWith({ ...RANGE_30D, sort: "usd", order: "desc" });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs());
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(1);
    await settle();
    expect(usage().loading).toBe(true); // summary ще летить
    sum.resolve(summaryOf(42));
    await settle();
    expect(usage().loading).toBe(false);
    expect(usage().all.loading).toBe(false);
    expect(usage().error).toBe(false);
    expect(usage().summary?.totals.usd).toBe(42);
    expect(usage().users.map((u) => u.id)).toEqual(["u_olena", "u_andriy"]);
    expect(usage().all.data?.items.map((p) => p.projectId)).toEqual(["p_all"]);
  });

  it("source ≠ chat і межі потрапляють у запити; search/sort/page таблиці — зі стану", async () => {
    const { api, enter } = makeUsage(
      usageState({
        source: "all",
        // Свій діапазон (`custom`): відносний пресет перерахував би межі від «зараз».
        preset: "custom",
        range: { from: "2026-10-01", to: null },
        usersSort: { key: "email", order: "asc" },
        all: { ...initialUsageTable(), q: " zerno ", sort: { key: "host", order: "asc" }, page: 3 },
      }),
    );
    enter();
    await settle();
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-10-01", source: "all" });
    expect(api.adminUsageUsers).toHaveBeenCalledWith({
      from: "2026-10-01",
      source: "all",
      sort: "email",
      order: "asc",
    });
    expect(api.adminUsageProjects).toHaveBeenCalledWith({
      from: "2026-10-01",
      source: "all",
      search: "zerno",
      sort: "host",
      order: "asc",
      page: 3,
      pageSize: USAGE_PAGE_SIZE,
    });
  });

  it("розгорнутий користувач — вантажаться й його проєкти (owner)", async () => {
    const { api, usage, enter } = makeUsage(usageState(withExpandedUser()));
    enter();
    await settle();
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(2);
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ owner: "u_olena" }));
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs());
    expect(usage().userProjects.loading).toBe(false);
  });

  it("інша вкладка / інший маршрут / forbidden / offline — запитів немає", async () => {
    const a = makeUsage(usageState());
    a.enter({ route: "admin", tab: "users" });
    a.enter({ route: "admin" });
    a.enter({ route: "start" });
    const b = makeUsage(usageState({}, { forbidden: true }));
    b.enter();
    const c = makeUsage(usageState(), { offline: true });
    c.enter();
    await settle();
    for (const t of [a, b, c]) {
      expect(t.api.adminUsageSummary).not.toHaveBeenCalled();
      expect(t.api.adminUsageUsers).not.toHaveBeenCalled();
      expect(t.api.adminUsageProjects).not.toHaveBeenCalled();
    }
    expect(c.usage().loading).toBe(false);
  });

  it("відмова одного з трьох → error: true, дані інших застосовано, старі лишаються; warn", async () => {
    const old = summaryOf(7);
    const { api, usage, enter } = makeUsage(usageState({ summary: old }));
    api.adminUsageSummary.mockRejectedValueOnce(new ApiError("boom", 500, "internal", null));
    enter();
    await settle();
    expect(usage().error).toBe(true);
    expect(usage().loading).toBe(false);
    expect(usage().summary).toBe(old);
    expect(usage().users).toHaveLength(2);
    expect(usage().all.data).not.toBeNull();
    expect(warn).toHaveBeenCalledWith("[usage] load", expect.any(ApiError));
  });

  it("401 не логується; повтор з успіхом знімає error", async () => {
    const { api, usage, own, enter } = makeUsage(usageState());
    api.adminUsageUsers.mockRejectedValueOnce(new ApiError("auth", 401, "unauthorized", null));
    enter();
    await settle();
    expect(usage().error).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    await own.usageReload();
    expect(usage().error).toBe(false);
    expect(usage().users).toHaveLength(2);
  });

  it("відносний пресет після півночі UTC: вхід і «Повторити» перераховують range від «зараз»", async () => {
    const { api, usage, own, enter, clearCalls } = makeUsage(usageState());
    vi.setSystemTime(new Date("2026-10-22T23:40:00.000Z"));
    enter();
    await settle();
    expect(usage().range).toEqual(RANGE_30D); // той самий день — межі ті самі

    vi.setSystemTime(new Date("2026-10-23T00:20:00.000Z"));
    clearCalls();
    enter();
    await settle();
    const next = { from: "2026-09-24", to: "2026-10-23" };
    expect(usage().preset).toBe("30d");
    expect(usage().range).toEqual(next);
    expect(api.adminUsageSummary).toHaveBeenCalledWith(next);
    expect(api.adminUsageUsers).toHaveBeenCalledWith({ ...next, sort: "usd", order: "desc" });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs(next));

    vi.setSystemTime(new Date("2026-11-01T00:05:00.000Z"));
    clearCalls();
    await own.usageReload();
    const nov = { from: "2026-10-03", to: "2026-11-01" };
    expect(usage().range).toEqual(nov);
    expect(api.adminUsageSummary).toHaveBeenCalledWith(nov);
  });

  it("«Цей місяць» через межу місяця і 7d — теж; custom і all не перераховуються", async () => {
    const month = makeUsage(usageState({ preset: "month", range: { from: "2026-10-01", to: "2026-10-31" } }));
    vi.setSystemTime(new Date("2026-11-01T00:05:00.000Z"));
    await month.own.usageReload();
    expect(month.usage().range).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(month.api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-11-01", to: "2026-11-01" });

    const week = makeUsage(usageState({ preset: "7d", range: { from: "2026-10-16", to: "2026-10-22" } }));
    week.enter();
    await settle();
    expect(week.usage().range).toEqual({ from: "2026-10-26", to: "2026-11-01" });

    const custom = { from: "2026-10-01", to: "2026-10-05" };
    const c = makeUsage(usageState({ preset: "custom", range: custom }));
    const before = c.usage().range;
    await c.own.usageReload();
    expect(c.usage().range).toBe(before);
    expect(c.api.adminUsageSummary).toHaveBeenCalledWith(custom);
    const a = makeUsage(usageState({ preset: "all", range: { from: null, to: null } }));
    await a.own.usageReload();
    expect(a.api.adminUsageSummary).toHaveBeenCalledWith({});
  });

  it("той самий день — range не замінюється новим об'єктом", async () => {
    const { usage, own } = makeUsage(usageState());
    const before = usage().range;
    vi.setSystemTime(new Date("2026-10-22T23:59:00.000Z"));
    await own.usageReload();
    expect(usage().range).toBe(before);
  });

  it("відповідь після виходу з адмінки відкидається", async () => {
    const { api, store, usage, enter } = makeUsage(usageState());
    const sum = deferred<UsageSummary>();
    api.adminUsageSummary.mockReturnValueOnce(sum.promise);
    enter();
    store.setState({ route: "cabinet" });
    sum.resolve(summaryOf(99));
    await settle();
    expect(usage().summary).toBeNull();
    expect(usage().users).toEqual([]);
  });
});

// ───────────── Період ─────────────

describe("usage-actions: usagePreset", () => {
  it("7d: preset і range від «зараз», таблиці на сторінку 1, перезавантаження огляду", async () => {
    const { api, usage, own } = makeUsage(
      usageState({
        all: { ...initialUsageTable(), page: 4, q: "x" },
        userProjects: { ...initialUsageTable(), page: 2 },
        rangeError: true,
      }),
    );
    await own.usagePreset("7d");
    expect(usage().preset).toBe("7d");
    expect(usage().range).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(usage().rangeError).toBe(false);
    expect(usage().all.page).toBe(1);
    expect(usage().all.q).toBe("x");
    expect(usage().userProjects.page).toBe(1);
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-10-16", to: "2026-10-22" });
    expect(api.adminUsageUsers).toHaveBeenCalledWith({
      from: "2026-10-16",
      to: "2026-10-22",
      sort: "usd",
      order: "desc",
    });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(
      projectsArgs({ from: "2026-10-16", to: "2026-10-22", search: "x" }),
    );
    expect(usage().summary).not.toBeNull();
  });

  it("month і all", async () => {
    const { api, usage, own } = makeUsage(usageState());
    await own.usagePreset("month");
    expect(usage().range).toEqual({ from: "2026-10-01", to: "2026-10-22" });
    api.adminUsageSummary.mockClear();
    await own.usagePreset("all");
    expect(usage().range).toEqual({ from: null, to: null });
    expect(api.adminUsageSummary).toHaveBeenCalledWith({});
  });

  it("розгорнутий користувач — його проєкти теж перезавантажуються з page 1", async () => {
    const { api, own } = makeUsage(
      usageState(withExpandedUser({ userProjects: { ...initialUsageTable(), page: 3 } })),
    );
    await own.usagePreset("30d");
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ owner: "u_olena" }));
  });

  it("custom: лише preset і rangeError, range не змінюється, запитів немає", async () => {
    const { api, usage, own } = makeUsage(usageState({ rangeError: true }));
    await own.usagePreset("custom");
    expect(usage().preset).toBe("custom");
    expect(usage().rangeError).toBe(false);
    expect(usage().range).toEqual(RANGE_30D);
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
  });

  it("гонка двох змін періоду: у стані відповідь останньої, хоч перша прийшла пізніше", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const s1 = deferred<UsageSummary>();
    const u1 = deferred<ReturnType<typeof usersRes>>();
    const p1 = deferred<UsageProjectsPage>();
    api.adminUsageSummary.mockReturnValueOnce(s1.promise);
    api.adminUsageUsers.mockReturnValueOnce(u1.promise);
    api.adminUsageProjects.mockReturnValueOnce(p1.promise);
    const first = own.usagePreset("7d");
    const second = own.usagePreset("month"); // типові (швидкі) відповіді
    await second;
    expect(usage().summary?.totals.usd).toBe(10);
    expect(usage().loading).toBe(false);
    s1.resolve(summaryOf(111));
    u1.resolve(usersRes([userOf("u_old", 1)]));
    p1.resolve(pageOf([projectOf("p_old")]));
    await first;
    await settle();
    expect(usage().summary?.totals.usd).toBe(10);
    expect(usage().users.map((u) => u.id)).toEqual(["u_olena", "u_andriy"]);
    expect(usage().all.data?.items[0]?.projectId).toBe("p_all");
    expect(usage().range).toEqual({ from: "2026-10-01", to: "2026-10-22" });
  });

  it("гонка: повільна ПОСЛІДНЯ відповідь перемагає, а loading тримається до неї", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const s2 = deferred<UsageSummary>();
    const first = own.usagePreset("7d");
    api.adminUsageSummary.mockReturnValueOnce(s2.promise);
    const second = own.usagePreset("month");
    await first;
    expect(usage().loading).toBe(true);
    expect(usage().summary).toBeNull(); // відповідь першої відкинута
    s2.resolve(summaryOf(222));
    await second;
    expect(usage().loading).toBe(false);
    expect(usage().summary?.totals.usd).toBe(222);
  });
});

describe("usage-actions: usageRange", () => {
  it("коректний період: preset custom, range, rangeError false, таблиці на сторінку 1, запити", async () => {
    const { api, usage, own } = makeUsage(usageState({ all: { ...initialUsageTable(), page: 5 } }));
    await own.usageRange({ from: "2026-10-01", to: "2026-10-15" });
    expect(usage().preset).toBe("custom");
    expect(usage().range).toEqual({ from: "2026-10-01", to: "2026-10-15" });
    expect(usage().rangeError).toBe(false);
    expect(usage().all.page).toBe(1);
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-10-01", to: "2026-10-15" });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(
      projectsArgs({ from: "2026-10-01", to: "2026-10-15" }),
    );
  });

  it("однобічний діапазон (одна межа null) — валідний", async () => {
    const { api, usage, own } = makeUsage(usageState());
    await own.usageRange({ from: null, to: "2026-10-15" });
    expect(usage().rangeError).toBe(false);
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ to: "2026-10-15" });
    api.adminUsageSummary.mockClear();
    await own.usageRange({ from: "2026-10-15", to: null });
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-10-15" });
    expect(usage().rangeError).toBe(false);
  });

  it("to < from → rangeError, запитів немає, дані лишаються; одна й та сама дата валідна", async () => {
    const summary = summaryOf(5);
    const { api, usage, own } = makeUsage(usageState({ summary }));
    await own.usageRange({ from: "2026-10-15", to: "2026-10-14" });
    expect(usage().rangeError).toBe(true);
    expect(usage().preset).toBe("custom");
    expect(usage().range).toEqual({ from: "2026-10-15", to: "2026-10-14" });
    expect(usage().summary).toBe(summary);
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
    await own.usageRange({ from: "2026-10-15", to: "2026-10-15" });
    expect(usage().rangeError).toBe(false);
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ from: "2026-10-15", to: "2026-10-15" });
  });

  it("rangeError відкидає відповіді, що летіли, і гасить loading", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const s = deferred<UsageSummary>();
    api.adminUsageSummary.mockReturnValueOnce(s.promise);
    const flying = own.usagePreset("7d");
    expect(usage().loading).toBe(true);
    await own.usageRange({ from: "2026-10-15", to: "2026-10-01" });
    expect(usage().loading).toBe(false);
    expect(usage().all.loading).toBe(false);
    s.resolve(summaryOf(77));
    await flying;
    await settle();
    expect(usage().summary).toBeNull();
    expect(usage().users).toEqual([]);
    expect(usage().rangeError).toBe(true);
  });

  it("поки стоїть rangeError, інші дії нічого не вантажать", async () => {
    const { api, own } = makeUsage(usageState());
    await own.usageRange({ from: "2026-10-15", to: "2026-10-01" });
    await own.usageSource("all");
    await own.usageReload();
    await own.usageSortUsers("email");
    await own.usageProjects("all", { page: 2 });
    await own.usageToggleUser("u_olena");
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
  });
});

// ───────────── Джерело ─────────────

describe("usage-actions: usageSource", () => {
  it("ставить source, таблиці на сторінку 1, перезавантажує (chat не передається, eval — так)", async () => {
    const { api, usage, own } = makeUsage(usageState({ all: { ...initialUsageTable(), page: 2 } }));
    await own.usageSource("eval");
    expect(usage().source).toBe("eval");
    expect(usage().all.page).toBe(1);
    expect(api.adminUsageSummary).toHaveBeenCalledWith({ ...RANGE_30D, source: "eval" });
    expect(api.adminUsageUsers).toHaveBeenCalledWith({
      ...RANGE_30D,
      source: "eval",
      sort: "usd",
      order: "desc",
    });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ source: "eval" }));
    api.adminUsageSummary.mockClear();
    await own.usageSource("chat");
    expect(api.adminUsageSummary).toHaveBeenCalledWith(RANGE_30D);
  });

  it("розгорнутий користувач — його проєкти теж з новим source", async () => {
    const { api, own } = makeUsage(usageState(withExpandedUser()));
    await own.usageSource("test");
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ source: "test", owner: "u_olena" }));
  });
});

// ───────────── Користувачі ─────────────

describe("usage-actions: usageSortUsers", () => {
  it("новий ключ → desc, той самий → перемикає order; вантажить лише users", async () => {
    const { api, usage, own } = makeUsage(usageState());
    await own.usageSortUsers("email");
    expect(usage().usersSort).toEqual({ key: "email", order: "desc" });
    expect(api.adminUsageUsers).toHaveBeenLastCalledWith({ ...RANGE_30D, sort: "email", order: "desc" });
    await own.usageSortUsers("email");
    expect(usage().usersSort).toEqual({ key: "email", order: "asc" });
    expect(api.adminUsageUsers).toHaveBeenLastCalledWith({ ...RANGE_30D, sort: "email", order: "asc" });
    await own.usageSortUsers("usd"); // не той самий, що попередній
    expect(usage().usersSort).toEqual({ key: "usd", order: "desc" });
    expect(api.adminUsageUsers).toHaveBeenCalledTimes(3);
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
    expect(usage().users).toHaveLength(2);
  });

  it("початковий usd desc: повторний клік по usd → asc", async () => {
    const { usage, own } = makeUsage(usageState());
    await own.usageSortUsers("usd");
    expect(usage().usersSort).toEqual({ key: "usd", order: "asc" });
  });

  it("застаріла відповідь сортування відкидається", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const slow = deferred<ReturnType<typeof usersRes>>();
    api.adminUsageUsers.mockReturnValueOnce(slow.promise);
    const first = own.usageSortUsers("email");
    const second = own.usageSortUsers("projects");
    await second;
    slow.resolve(usersRes([userOf("u_stale", 1)]));
    await first;
    expect(usage().users.map((u) => u.id)).toEqual(["u_olena", "u_andriy"]);
    expect(usage().usersSort.key).toBe("projects");
  });

  it("поки стоїть rangeError — no-op: usersSort не змінюється (заголовок не розходиться з рядками)", async () => {
    const { api, usage, own } = makeUsage(usageState());
    await own.usageRange({ from: "2026-10-15", to: "2026-10-01" });
    const before = usage().usersSort;
    await own.usageSortUsers("email");
    await own.usageSortUsers("usd");
    expect(usage().usersSort).toBe(before);
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    // Період виправлено — сортування знову працює.
    await own.usageRange({ from: "2026-10-01", to: "2026-10-15" });
    await own.usageSortUsers("email");
    expect(usage().usersSort).toEqual({ key: "email", order: "desc" });
  });

  it("відмова → error: true, список лишається", async () => {
    const { api, usage, own } = makeUsage(usageState({ users: [userOf("u_keep", 1)] }));
    api.adminUsageUsers.mockRejectedValueOnce(new ApiError("boom", 500, "internal", null));
    await own.usageSortUsers("email");
    expect(usage().error).toBe(true);
    expect(usage().users.map((u) => u.id)).toEqual(["u_keep"]);
    expect(warn).toHaveBeenCalledWith("[usage] users", expect.any(ApiError));
  });
});

describe("usage-actions: usageToggleUser", () => {
  it("розгортання: expandedUserId, свіжа таблиця з loading, запит з owner, дані після відповіді", async () => {
    const { api, usage, own } = makeUsage(usageState({ summary: summaryOf(1) }));
    const p = deferred<UsageProjectsPage>();
    api.adminUsageProjects.mockReturnValueOnce(p.promise);
    const done = own.usageToggleUser("u_olena");
    expect(usage().expandedUserId).toBe("u_olena");
    expect(usage().userProjects).toEqual({ ...initialUsageTable(), loading: true });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ owner: "u_olena" }));
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    p.resolve(pageOf([projectOf("p_1")]));
    await done;
    expect(usage().userProjects.loading).toBe(false);
    expect(usage().userProjects.data?.items.map((x) => x.projectId)).toEqual(["p_1"]);
  });

  it("інший користувач: попередній згортається, таблиця скидається на сторінку 1 (q і sort — початкові)", async () => {
    const { api, usage, own } = makeUsage(
      usageState(
        withExpandedUser({
          userProjects: {
            q: "abc",
            sort: { key: "host", order: "asc" },
            page: 4,
            data: pageOf([projectOf("p_user")]),
            loading: false,
          },
          expandedProjectId: "p_user",
        }),
      ),
    );
    await own.usageToggleUser("u_andriy");
    expect(usage().expandedUserId).toBe("u_andriy");
    expect(usage().expandedProjectId).toBeNull(); // проєкт був у таблиці попереднього користувача
    expect(usage().userProjects.q).toBe("");
    expect(usage().userProjects.page).toBe(1);
    expect(usage().userProjects.sort).toEqual({ key: "usd", order: "desc" });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ owner: "u_andriy" }));
  });

  it("проєкт з таблиці «Усі проєкти» лишається розгорнутим при зміні користувача", async () => {
    const { usage, own } = makeUsage(usageState(withExpandedUser({ expandedProjectId: "p_all" })));
    await own.usageToggleUser("u_andriy");
    expect(usage().expandedProjectId).toBe("p_all");
  });

  it("той самий id: згортає, таблиця скидається, проєкт з неї згортається, запитів немає", async () => {
    const { api, usage, own } = makeUsage(usageState(withExpandedUser({ expandedProjectId: "p_user" })));
    await own.usageToggleUser("u_olena");
    expect(usage().expandedUserId).toBeNull();
    expect(usage().userProjects).toEqual(initialUsageTable());
    expect(usage().expandedProjectId).toBeNull();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
  });

  it("згортання/зміна відкидає відповідь, що летіла", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const p = deferred<UsageProjectsPage>();
    api.adminUsageProjects.mockReturnValueOnce(p.promise);
    const opening = own.usageToggleUser("u_olena");
    await own.usageToggleUser("u_olena"); // згорнули
    p.resolve(pageOf([projectOf("p_late")]));
    await opening;
    expect(usage().expandedUserId).toBeNull();
    expect(usage().userProjects).toEqual(initialUsageTable());
  });

  it("відмова → error: true, loading таблиці знято", async () => {
    const { api, usage, own } = makeUsage(usageState());
    api.adminUsageProjects.mockRejectedValueOnce(new ApiError("boom", 500, "internal", null));
    await own.usageToggleUser("u_olena");
    expect(usage().error).toBe(true);
    expect(usage().userProjects.loading).toBe(false);
    expect(usage().expandedUserId).toBe("u_olena");
  });
});

// ───────────── Таблиці проєктів ─────────────

describe("usage-actions: usageProjects", () => {
  it("q: пишеться одразу з page 1, запит лише після debounce, проміс завершується одразу", async () => {
    const { api, usage, own } = makeUsage(usageState({ all: { ...initialUsageTable(), page: 3 } }));
    let resolved = false;
    const p = own.usageProjects("all", { q: "zer" }).then(() => {
      resolved = true;
    });
    await p;
    expect(resolved).toBe(true);
    expect(usage().all.q).toBe("zer");
    expect(usage().all.page).toBe(1);
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS - 1);
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(1);
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ search: "zer" }));
    await settle();
    expect(usage().all.loading).toBe(false);
    expect(usage().all.data?.items[0]?.projectId).toBe("p_all");
  });

  it("серія введень скидає таймер: один запит із останнім q", async () => {
    const { api, usage, own } = makeUsage(usageState());
    await own.usageProjects("all", { q: "z" });
    await vi.advanceTimersByTimeAsync(200);
    await own.usageProjects("all", { q: "ze" });
    await vi.advanceTimersByTimeAsync(200);
    await own.usageProjects("all", { q: "zer" });
    expect(usage().all.q).toBe("zer");
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS);
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(1);
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ search: "zer" }));
  });

  it("debounce — окремо на таблицю; «user» шле owner", async () => {
    const { api, own } = makeUsage(usageState(withExpandedUser()));
    await own.usageProjects("all", { q: "aaa" });
    await own.usageProjects("user", { q: "bbb" });
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS);
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(2);
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ search: "aaa" }));
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ search: "bbb", owner: "u_olena" }));
  });

  it("порожній q → search не передається (undefined)", async () => {
    const { api, usage, own } = makeUsage(usageState({ all: { ...initialUsageTable(), q: "abc" } }));
    await own.usageProjects("all", { q: "" });
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS);
    expect(usage().all.q).toBe("");
    const arg = api.adminUsageProjects.mock.calls[0]?.[0] as Query;
    expect(arg.search).toBeUndefined();
  });

  it("sort: новий ключ → desc, той самий → перемикає; page: 1; запит одразу", async () => {
    const { api, usage, own } = makeUsage(usageState({ all: { ...initialUsageTable(), page: 4 } }));
    await own.usageProjects("all", { sort: "host" });
    expect(usage().all.sort).toEqual({ key: "host", order: "desc" });
    expect(usage().all.page).toBe(1);
    expect(api.adminUsageProjects).toHaveBeenLastCalledWith(projectsArgs({ sort: "host", order: "desc" }));
    await own.usageProjects("all", { sort: "host" });
    expect(usage().all.sort).toEqual({ key: "host", order: "asc" });
    expect(api.adminUsageProjects).toHaveBeenLastCalledWith(projectsArgs({ sort: "host", order: "asc" }));
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
  });

  it("page: ставить сторінку, q/sort не чіпає, запит одразу; user — з owner", async () => {
    const { api, usage, own } = makeUsage(
      usageState(withExpandedUser({ all: { ...initialUsageTable(), q: "abc", data: pageOf([]) } })),
    );
    await own.usageProjects("all", { page: 2 });
    expect(usage().all.page).toBe(2);
    expect(usage().all.q).toBe("abc");
    expect(api.adminUsageProjects).toHaveBeenLastCalledWith(projectsArgs({ search: "abc", page: 2 }));
    await own.usageProjects("user", { page: 3 });
    expect(usage().userProjects.page).toBe(3);
    expect(api.adminUsageProjects).toHaveBeenLastCalledWith(projectsArgs({ owner: "u_olena", page: 3 }));
  });

  it("loading таблиці — поки летить запит; дані попередньої сторінки лишаються", async () => {
    const { api, usage, own } = makeUsage(usageState(withExpandedUser()));
    const old = usage().all.data;
    const p = deferred<UsageProjectsPage>();
    api.adminUsageProjects.mockReturnValueOnce(p.promise);
    const done = own.usageProjects("all", { page: 2 });
    expect(usage().all.loading).toBe(true);
    expect(usage().all.data).toBe(old);
    p.resolve(pageOf([projectOf("p_page2")], 2));
    await done;
    expect(usage().all.loading).toBe(false);
    expect(usage().all.data?.items[0]?.projectId).toBe("p_page2");
  });

  it("застаріла відповідь таблиці відкидається (пізніший запит виграє)", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const slow = deferred<UsageProjectsPage>();
    api.adminUsageProjects.mockReturnValueOnce(slow.promise);
    const first = own.usageProjects("all", { page: 2 });
    const second = own.usageProjects("all", { page: 3 });
    await second;
    slow.resolve(pageOf([projectOf("p_stale")], 2));
    await first;
    expect(usage().all.data?.items[0]?.projectId).toBe("p_all");
    expect(usage().all.page).toBe(3);
    expect(usage().all.loading).toBe(false);
  });

  it("запит таблиці під час огляду: відповідь `all` з огляду відкидається", async () => {
    const { api, usage, own, enter } = makeUsage(usageState());
    const overviewAll = deferred<UsageProjectsPage>();
    api.adminUsageProjects.mockReturnValueOnce(overviewAll.promise);
    enter();
    await own.usageProjects("all", { page: 2 });
    overviewAll.resolve(pageOf([projectOf("p_overview")]));
    await settle();
    expect(usage().all.data?.items[0]?.projectId).toBe("p_all");
    expect(usage().all.page).toBe(2);
    expect(usage().loading).toBe(false);
  });

  it("огляд скасовує відкладений пошук таблиці `all` (він і так вантажить її)", async () => {
    const { api, own } = makeUsage(usageState());
    await own.usageProjects("all", { q: "zer" });
    await own.usagePreset("7d");
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(1);
    expect(api.adminUsageProjects).toHaveBeenCalledWith(
      projectsArgs({ from: "2026-10-16", to: "2026-10-22", search: "zer" }),
    );
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS * 2);
    expect(api.adminUsageProjects).toHaveBeenCalledTimes(1);
  });

  it("порожній patch — нічого не робить", async () => {
    const { api, usage, own } = makeUsage(usageState());
    const before = usage();
    await own.usageProjects("all", {});
    expect(usage()).toBe(before);
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
  });
});

describe("usage-actions: usageToggleProject / usageReload", () => {
  it("usageToggleProject: розгортає, перемикає на інший, згортає; запитів немає", () => {
    const { api, usage, own } = makeUsage(usageState());
    own.usageToggleProject("p_1");
    expect(usage().expandedProjectId).toBe("p_1");
    own.usageToggleProject("p_2");
    expect(usage().expandedProjectId).toBe("p_2");
    own.usageToggleProject("p_2");
    expect(usage().expandedProjectId).toBeNull();
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
  });

  it("usageReload: огляд (+ проєкти розгорнутого користувача), стан таблиць зберігається", async () => {
    const { api, usage, own } = makeUsage(
      usageState(
        withExpandedUser({
          error: true,
          usersSort: { key: "email", order: "asc" },
          all: { ...initialUsageTable(), q: "zer", page: 2, sort: { key: "host", order: "desc" } },
        }),
      ),
    );
    await own.usageReload();
    expect(api.adminUsageSummary).toHaveBeenCalledWith(RANGE_30D);
    expect(api.adminUsageUsers).toHaveBeenCalledWith({ ...RANGE_30D, sort: "email", order: "asc" });
    expect(api.adminUsageProjects).toHaveBeenCalledWith(
      projectsArgs({ search: "zer", page: 2, sort: "host", order: "desc" }),
    );
    expect(api.adminUsageProjects).toHaveBeenCalledWith(projectsArgs({ owner: "u_olena" }));
    expect(usage().error).toBe(false);
    expect(usage().loading).toBe(false);
  });

  it("помилка таблиці користувача не знімається успіхом огляду, але знімається наступним reload", async () => {
    const { api, usage, own } = makeUsage(usageState(withExpandedUser()));
    api.adminUsageProjects.mockImplementation(async (q: Query) => {
      if (q.owner) throw new ApiError("boom", 500, "internal", null);
      return pageOf([projectOf("p_all")]);
    });
    await own.usageReload();
    expect(usage().error).toBe(true);
    api.adminUsageProjects.mockImplementation(async () => pageOf([projectOf("p_ok")]));
    await own.usageReload();
    expect(usage().error).toBe(false);
  });
});

// ───────────── Фікстури ─────────────

describe("usage-actions: deps.offline", () => {
  it("зміни стану застосовуються, запитів немає, loading не вмикається", async () => {
    const { api, usage, own, enter } = makeUsage(usageState(), { offline: true });
    enter();
    await own.usagePreset("7d");
    await own.usageRange({ from: "2026-10-01", to: "2026-10-05" });
    await own.usageSource("all");
    await own.usageSortUsers("email");
    await own.usageToggleUser("u_olena");
    await own.usageProjects("all", { sort: "host" });
    await own.usageProjects("all", { q: "x" });
    await vi.advanceTimersByTimeAsync(USAGE_SEARCH_DEBOUNCE_MS);
    own.usageToggleProject("p_1");
    await own.usageReload();
    expect(api.adminUsageSummary).not.toHaveBeenCalled();
    expect(api.adminUsageUsers).not.toHaveBeenCalled();
    expect(api.adminUsageProjects).not.toHaveBeenCalled();
    const u = usage();
    expect(u.preset).toBe("custom");
    expect(u.range).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(u.source).toBe("all");
    expect(u.usersSort).toEqual({ key: "email", order: "desc" });
    expect(u.expandedUserId).toBe("u_olena");
    expect(u.userProjects.loading).toBe(false);
    expect(u.all.sort).toEqual({ key: "host", order: "desc" });
    expect(u.all.q).toBe("x");
    expect(u.expandedProjectId).toBe("p_1");
    expect(u.loading).toBe(false);
  });
});
