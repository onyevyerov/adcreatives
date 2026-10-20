// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
/**
 * B9 · Історія (N11-B): назви операцій з kind + ref, дні за локальною датою з підсумком і балансом
 * на кінець, хост проєкту з `projects`, пагінація без дублів, дії `loadHistory` / `openProject`.
 * Час — Київ (як у Референсі): записи фікстур — ISO UTC, дні рахуються за локальною датою.
 */
process.env.TZ = "Europe/Kyiv";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import {
  accountFixture,
  at,
  HISTORY,
  OLENA,
  PACKAGES,
  PROJECTS,
} from "../../public/static/dev/fixtures/_base.js";
import historyFixtures, { LONG_NOTE } from "../../public/static/dev/fixtures/history.js";
import type { Actions, LedgerEntry, PartDeps, Route, UiState } from "../../public/static/js/contracts.js";
import { cabinetActions, HISTORY_LIMIT } from "../../public/static/js/data/cabinet-actions.js";
import { createStore } from "../../public/static/js/store.js";
import {
  groupByDay,
  localParts,
  mount,
  operationLabel,
  sinceDate,
} from "../../public/static/js/views/cab-history.js";

const MINUS = "−";

/** Кабінет Олени на «Історії» з патчем гілки історії. */
function state(history: Partial<UiState["cabinet"]["history"]> = {}, rows = PROJECTS): UiState {
  const s = accountFixture({ route: "cabinet" });
  return {
    ...s,
    cabinet: {
      ...s.cabinet,
      section: "history",
      history: { ...s.cabinet.history, ...history },
      projects: { ...s.cabinet.projects, rows },
    },
  };
}

const entry = (id: string, when: string, credits = -10, balanceAfter = 0): LedgerEntry => ({
  id,
  userId: OLENA.id,
  at: at(when),
  kind: "charge",
  credits,
  balanceAfter,
  ref: { projectId: "p_flor" },
  note: "Відео",
});

/** Фейкові залежності part-фабрики: `api` — лише те, що кличе B9. */
function fakeDeps(api: Partial<PartDeps["api"]>, opts: { offline?: boolean; actions?: Actions } = {}) {
  const routes: ((r: Route) => void)[] = [];
  const deps = {
    params: new URLSearchParams(),
    api: api as PartDeps["api"],
    actions: () => opts.actions as Actions,
    backend: { start: () => {}, stop: () => {} } as unknown as PartDeps["backend"],
    offline: opts.offline ?? false,
    onRoute: (fn: (r: Route) => void) => {
      routes.push(fn);
    },
  } satisfies PartDeps;
  const enter = (r: Route) => {
    for (const fn of routes) fn(r);
  };
  return { deps, enter };
}

/** Відкладений проміс для контролю порядку відповідей. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("views/cab-history.js · чисті функції", () => {
  it("назви операцій з kind + ref — таблиця Референсу", () => {
    expect(HISTORY.map((e) => operationLabel(e, PACKAGES))).toEqual([
      "Додатковий формат 16:9",
      "Ролик",
      "Ролик",
      "Поповнення · своя сума",
      "Коригування",
      "Повернення за збій",
      "Ролик",
      "Правка · рев. 2",
      "Додатковий формат 1:1",
      "Ролик",
      "Поповнення · Кілька роликів",
    ]);
    const bonus: LedgerEntry = { ...entry("bonus:signup:u", "14.10 10:00", 5, 5), kind: "bonus", ref: {} };
    expect(operationLabel(bonus)).toBe("Вітальний бонус");
    // Без пакетів (me ще немає) — «своя сума».
    expect(operationLabel(HISTORY[10] as LedgerEntry)).toBe("Поповнення · своя сума");
  });

  it("дата — за локальним часом; рік — лише не поточний", () => {
    expect(localParts(at("19.10 10:40"), 2026)).toEqual({
      key: "2026-10-19",
      title: "19 жовтня",
      time: "10:40",
    });
    // 00:30 за Києвом — ще 21:30 попереднього дня в UTC: день — київський.
    expect(localParts(at("20.10 00:30"), 2026).title).toBe("20 жовтня");
    expect(localParts(at("01.01 09:05"), 2027).title).toBe("1 січня 2026");
    expect(sinceDate(OLENA.createdAt)).toBe("14.10.2026");
    expect(sinceDate(null)).toBe("");
  });

  it("дні: підсумок — сума credits, «на кінець» — balanceAfter найновішого запису", () => {
    const days = groupByDay(HISTORY);
    expect(days.map((d) => [d.title, d.total, d.end, d.entries.length])).toEqual([
      ["19 жовтня", -12, 12, 2],
      ["18 жовтня", 12, 24, 2],
      ["17 жовтня", 2, 12, 1],
      ["16 жовтня", 0, 10, 2],
      ["15 жовтня", -3, 10, 1],
      ["14 жовтня", 13, 13, 3],
    ]);
  });
});

describe("views/cab-history.js · mount", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    document.body.textContent = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  function mountWith(s: UiState) {
    const store = createStore(s);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((next, prev) => view.update(next, prev));
    const calls = (name: string) => actions.calls.filter((c) => c.name === name);
    return { store, actions, view, calls };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const all = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
  const texts = (sel: string) => all(sel).map((n) => n.textContent);

  it("cab-history: дні, рядки, примітка, хости проєктів, кінець списку", () => {
    const { calls, view } = mountWith(historyFixtures["cab-history"] as UiState);
    expect(q("h1")?.textContent).toBe("Історія");
    expect(texts(".cab-hist__day-title")).toEqual([
      "19 жовтня",
      "18 жовтня",
      "17 жовтня",
      "16 жовтня",
      "15 жовтня",
      "14 жовтня",
    ]);
    const meta = all(".cab-hist__day-meta").map((n) => n.textContent);
    expect(meta[0]).toBe(`за день ${MINUS}12на кінець 12`);
    expect(meta[1]).toBe("за день +12на кінець 24");
    expect(meta[3]).toBe("за день 0на кінець 10");

    const rows = all(".cab-hist__row");
    expect(rows).toHaveLength(11);
    const first = rows[0] as HTMLElement;
    expect(first.querySelector(".cab-hist__time")?.textContent).toBe("10:40");
    expect(first.querySelector(".cab-hist__label")?.textContent).toBe("Додатковий формат 16:9");
    expect(first.querySelector(".cab-hist__credits")?.textContent).toBe(`${MINUS}2`);
    expect(first.querySelector(".cab-hist__after")?.textContent).toBe("→ 12");

    expect(texts(".cab-hist__note")).toEqual(["«Компенсація за затримку»"]);
    // Хост — з projects; проєкт за описом — «Без сайту»; поповнення й коригування — без проєкту.
    expect(texts(".cab-hist__proj")).toEqual([
      "florist-kyiv.example.com",
      "florist-kyiv.example.com",
      "Без сайту",
      "shyna-lviv.example.com",
      "shyna-lviv.example.com",
      "zerno.example.com",
      "zerno.example.com",
      "zerno.example.com",
    ]);
    (q(".cab-hist__proj") as HTMLButtonElement).click();
    expect(calls("openProject")[0]?.args).toEqual(["p_flor"]);

    expect(q(".cab-hist__more")?.hidden).toBe(true);
    expect(q(".cab-hist__end")?.hidden).toBe(false);
    expect(q(".cab-hist__end")?.textContent).toBe("Це всі операції · з 14.10.2026");
    expect(q(".cab-hist__loading")?.hidden).toBe(true);
    expect(q(".cab-hist__empty")?.hidden).toBe(true);

    view.destroy();
    expect(host.children).toHaveLength(0);
  });

  it("проєкти ще не прийшли — рядки без посилань; прийшли — посилання з’являються", () => {
    const { store } = mountWith(state({}, null as unknown as typeof PROJECTS));
    expect(all(".cab-hist__proj")).toHaveLength(0);
    store.setState((s) => ({
      cabinet: { ...s.cabinet, projects: { ...s.cabinet.projects, rows: PROJECTS } },
    }));
    expect(all(".cab-hist__proj")).toHaveLength(8);
  });

  it("порожньо і перше завантаження", () => {
    mountWith(historyFixtures["sheet-n11-empty"] as UiState);
    expect(q(".cab-hist__empty")?.hidden).toBe(false);
    expect(q(".cab-hist__empty")?.textContent).toBe(
      "Операцій ще немаєТут з’являться поповнення, списання за ролики й правки та повернення.",
    );
    expect(q(".cab-hist__days")?.hidden).toBe(true);
    expect(q(".cab-hist__end")?.hidden).toBe(true);

    document.body.textContent = "";
    host = document.createElement("div");
    document.body.append(host);
    mountWith(historyFixtures["sheet-n11-loading"] as UiState);
    const loading = q(".cab-hist__loading");
    expect(loading?.hidden).toBe(false);
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.textContent).toBe("Завантажую операції…");
    expect(q(".cab-hist__empty")?.hidden).toBe(true);
  });

  it("«Показати ще» → loadHistory(true); довантаження — спінер і disabled, стрічка не зникає", () => {
    const { store, calls } = mountWith(historyFixtures["sheet-n11-more"] as UiState);
    const more = q(".cab-hist__more") as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe("Показати ще");
    expect(more.disabled).toBe(false);
    expect(q(".cab-hist__end")?.hidden).toBe(true);
    expect(all(".cab-hist__row")).toHaveLength(5);
    more.click();
    expect(calls("loadHistory")[0]?.args).toEqual([true]);

    store.setState((s) => ({ cabinet: { ...s.cabinet, history: { ...s.cabinet.history, loading: true } } }));
    expect(q(".cab-hist__more")).toBe(more);
    expect(more.disabled).toBe(true);
    expect(more.getAttribute("aria-busy")).toBe("true");
    expect(more.querySelector(".spinner")?.hasAttribute("hidden")).toBe(false);
    expect(all(".cab-hist__row")).toHaveLength(5);
    expect(q(".cab-hist__loading")?.hidden).toBe(true);
  });

  it("довга примітка — у лапках, повністю", () => {
    mountWith(historyFixtures["sheet-n11-long-note"] as UiState);
    expect(q(".cab-hist__note")?.textContent).toBe(`«${LONG_NOTE.note}»`);
    expect(q(".cab-hist__day-meta")?.textContent).toBe(`за день ${MINUS}6на кінець 18`);
  });

  it("стан, що не стосується історії, не перебудовує стрічку", () => {
    const { store } = mountWith(state());
    const day = q(".cab-hist__day");
    store.setState((s) => ({ ui: { ...s.ui, notice: "x" } }));
    expect(q(".cab-hist__day")).toBe(day);
  });

  it("тексти користувача — лише текстом (без розбору HTML)", () => {
    const evil: LedgerEntry = {
      ...entry("adjust:evil", "19.10 12:00", 1, 13),
      kind: "adjust",
      ref: {},
      note: "<img src=x>",
    };
    mountWith(state({ entries: [evil] }));
    expect(q(".cab-hist__note")?.textContent).toBe("«<img src=x>»");
    expect(q("img")).toBeNull();
  });

  it("усі фікстури історії зареєстровані у fixtureStates і монтуються", () => {
    for (const [name, s] of Object.entries(historyFixtures)) {
      expect(fixtureStates[name]).toBe(s);
      expect(s.route).toBe("cabinet");
      expect(s.cabinet.section).toBe("history");
      const view = mountWith(s).view;
      view.destroy();
    }
    expect(Object.keys(historyFixtures)).toEqual([
      "cab-history",
      "sheet-n11-list",
      "sheet-n11-empty",
      "sheet-n11-loading",
      "sheet-n11-more",
      "sheet-n11-more-busy",
      "sheet-n11-long-note",
    ]);
  });
});

describe("data/cabinet-actions.js · історія", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  const empty = () => {
    const s = accountFixture({ route: "cabinet" });
    return createStore<UiState>({
      ...s,
      cabinet: {
        ...s.cabinet,
        section: "history",
        history: { entries: [], nextBefore: null, loading: false, more: false },
        projects: { rows: null, loading: false, open: null },
      },
    });
  };

  it("вхід на «Історію» → перша сторінка (limit 50) і проєкти, якщо їх ще немає", async () => {
    const store = empty();
    const page = deferred<{ entries: LedgerEntry[]; nextBefore: string | null }>();
    const transactions = vi.fn(() => page.promise);
    const listProjects = vi.fn(async () => ({ projects: PROJECTS }));
    const { deps, enter: go } = fakeDeps({ transactions, listProjects });
    cabinetActions(store, deps);
    go({ route: "start" });
    go({ route: "cabinet", section: "balance" });
    expect(transactions).not.toHaveBeenCalled();
    go({ route: "cabinet", section: "history" });
    expect(transactions).toHaveBeenCalledWith({ limit: HISTORY_LIMIT, before: null });
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(store.getState().cabinet.history.loading).toBe(true);
    page.resolve({ entries: HISTORY.slice(0, 5), nextBefore: HISTORY[4]?.at ?? null });
    await vi.waitFor(() => expect(store.getState().cabinet.history.loading).toBe(false));
    const h = store.getState().cabinet.history;
    expect(h.entries).toHaveLength(5);
    expect(h.more).toBe(true);
    expect(h.nextBefore).toBe(HISTORY[4]?.at);
    expect(store.getState().cabinet.projects.rows).toEqual(PROJECTS);

    // Повторний вхід — проєкти вже є, їх не перевантажуємо.
    go({ route: "cabinet", section: "history" });
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it("loadHistory(true): before = nextBefore, дописує без дублів; кінець — more: false", async () => {
    const store = empty();
    const transactions = vi.fn(async (o: { before?: string | null } = {}) =>
      o.before
        ? { entries: HISTORY.slice(4), nextBefore: null } // сторінка перекриває останній запис
        : { entries: HISTORY.slice(0, 5), nextBefore: HISTORY[4]?.at ?? null },
    );
    const { deps } = fakeDeps({ transactions });
    const a = cabinetActions(store, deps);
    await a.loadHistory();
    await a.loadHistory(true);
    expect(transactions).toHaveBeenLastCalledWith({ limit: HISTORY_LIMIT, before: HISTORY[4]?.at });
    const h = store.getState().cabinet.history;
    expect(h.entries.map((e) => e.id)).toEqual(HISTORY.map((e) => e.id));
    expect(h.more).toBe(false);
    expect(h.nextBefore).toBeNull();
    // Далі сторінок немає — нового запиту немає.
    await a.loadHistory(true);
    expect(transactions).toHaveBeenCalledTimes(2);
  });

  it("поки сторінка вантажиться, «Показати ще» не шле другий запит", async () => {
    const store = empty();
    store.setState((s) => ({
      cabinet: {
        ...s.cabinet,
        history: {
          entries: HISTORY.slice(0, 5),
          nextBefore: HISTORY[4]?.at ?? null,
          loading: true,
          more: true,
        },
      },
    }));
    const transactions = vi.fn(async () => ({ entries: [], nextBefore: null }));
    const a = cabinetActions(store, fakeDeps({ transactions }).deps);
    await a.loadHistory(true);
    expect(transactions).not.toHaveBeenCalled();
  });

  it("відповідь, яку обігнав новіший запит, відкидається", async () => {
    const store = empty();
    const slow = deferred<{ entries: LedgerEntry[]; nextBefore: string | null }>();
    const fast = deferred<{ entries: LedgerEntry[]; nextBefore: string | null }>();
    const transactions = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const a = cabinetActions(store, fakeDeps({ transactions }).deps);
    const p1 = a.loadHistory();
    const p2 = a.loadHistory();
    fast.resolve({ entries: HISTORY.slice(0, 2), nextBefore: null });
    await p2;
    slow.resolve({ entries: HISTORY, nextBefore: "x" });
    await p1;
    const h = store.getState().cabinet.history;
    expect(h.entries).toHaveLength(2);
    expect(h.nextBefore).toBeNull();
  });

  it("помилка — loading знімається, записи лишаються; 401 не пишеться в консоль", async () => {
    const store = empty();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transactions = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("401"), { status: 401, code: "unauthorized" }))
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500, code: null }));
    const a = cabinetActions(store, fakeDeps({ transactions }).deps);
    await a.loadHistory();
    expect(store.getState().cabinet.history.loading).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await a.loadHistory();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("offline (?mock=1) — без мережі, історія й проєкти Олени з фікстур", async () => {
    const store = empty();
    const transactions = vi.fn();
    const listProjects = vi.fn();
    const { deps, enter } = fakeDeps({ transactions, listProjects }, { offline: true });
    cabinetActions(store, deps);
    enter({ route: "cabinet", section: "history" });
    await vi.waitFor(() => expect(store.getState().cabinet.history.entries).toHaveLength(HISTORY.length));
    await vi.waitFor(() => expect(store.getState().cabinet.projects.rows).toHaveLength(PROJECTS.length));
    expect(store.getState().cabinet.history.more).toBe(false);
    expect(transactions).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("openProject → navigate на проєкт", () => {
    const store = empty();
    const navigate = vi.fn();
    const a = cabinetActions(store, fakeDeps({}, { actions: { navigate } as unknown as Actions }).deps);
    a.openProject("p_zerno");
    expect(navigate).toHaveBeenCalledWith({ route: "project", projectId: "p_zerno" });
  });
});
