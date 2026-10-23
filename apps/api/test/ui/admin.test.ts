// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import {
  ADMIN,
  ADMIN_HISTORY,
  ADMIN_ME,
  ALL_PROJECTS,
  ANDRIY,
  accountFixture,
  IRYNA,
  ME,
  OLENA,
  OUTBOX,
  PACKAGES,
  PRICES,
  USERS,
} from "../../public/static/dev/fixtures/_base.js";
import adminFixtures from "../../public/static/dev/fixtures/admin.js";
import type {
  Actions,
  AdminState,
  LedgerEntry,
  PartDeps,
  Route,
  UiState,
} from "../../public/static/js/contracts.js";
import { createAccountActions, stateForUrl } from "../../public/static/js/data/account.js";
import * as realApi from "../../public/static/js/data/account-api.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import {
  adminActions,
  COPIED_MS,
  needsConfirm,
  parseCredits,
} from "../../public/static/js/data/admin-actions.js";
import { ApiError } from "../../public/static/js/data/api.js";
import { createStore } from "../../public/static/js/store.js";
import {
  entryLabel,
  entrySub,
  filterUsers,
  formatDate,
  formatDayTime,
  hostOf,
  mount,
} from "../../public/static/js/views/admin.js";

// 403 малює B12 (views/session.js) — тест не спирається на її вивід, лише на виклик.
const forbidden = vi.hoisted(() => ({
  mount: vi.fn((el: HTMLElement) => {
    const node = document.createElement("div");
    node.className = "fake-403";
    el.append(node);
    return { update: vi.fn(), destroy: vi.fn(() => node.remove()) };
  }),
}));
vi.mock("../../public/static/js/views/session.js", () => ({
  mount: () => ({ update() {}, destroy() {} }),
  mountForbidden: forbidden.mount,
  emptyChatText: () => null,
}));

const MINUS = "−";
const NBSP = " ";

/** Стан адмінки під адміном (дані з `_base.js`); `admin` зливається поверх. */
function adminState(admin: Partial<AdminState> = {}, rest: Partial<UiState> = {}): UiState {
  const s = accountFixture({ route: "admin", account: { me: ADMIN_ME } });
  return { ...s, ...rest, admin: { ...s.admin, ...admin } };
}

const selectedOf = (user: typeof OLENA, balance: number, entries?: LedgerEntry[]) => ({
  selectedId: user.id,
  selected: { user, balance, entries: entries ?? ADMIN_HISTORY[user.id] ?? [] },
});

/** API адмінки без мережі: кожна функція — мок; за замовчуванням дані `_base.js`. */
function fakeApi() {
  const all = Object.fromEntries(Object.keys(realApi).map((k) => [k, vi.fn(async () => ({}))]));
  return {
    ...all,
    adminUsers: vi.fn(async () => ({ users: USERS })),
    adminOutbox: vi.fn(async () => ({ mails: OUTBOX })),
    listProjects: vi.fn(async (_o?: { all?: boolean }) => ({ projects: ALL_PROJECTS })),
    adminUser: vi.fn(async (id: string) => {
      const u = USERS.find((x) => x.id === id);
      if (!u) throw new ApiError("Користувача не знайдено.", 404, "not_found", null);
      const { balance, ...user } = u;
      return { user, balance };
    }),
    adminTransactions: vi.fn(async (id: string, _o?: { limit?: number }) => ({
      entries: ADMIN_HISTORY[id] ?? [],
      nextBefore: null,
    })),
    adminCredits: vi.fn(async (id: string, body: { credits: number; note: string }) => {
      const before = USERS.find((u) => u.id === id)?.balance ?? 0;
      const balance = before + body.credits;
      const entry: LedgerEntry = {
        id: "adjust:new",
        userId: id,
        at: "2026-10-19T08:30:00.000Z",
        kind: "adjust",
        credits: body.credits,
        balanceAfter: balance,
        ref: { byUserId: ADMIN.id },
        note: body.note,
      };
      return { entry, balance };
    }),
  } as unknown as typeof realApi;
}

const fakeBackend = (): Backend => ({
  start: async () => {},
  stop: () => {},
  createProject: async () => "p_new",
  sendMessage: async () => {},
  sendCommand: async () => {},
  uploadPhotos: async () => {},
});

/**
 * Дії адмінки над store; `navigate` застосовує маршрут адмінки як ядро (selectedId, tab) і
 * викликає підписників `onRoute`. Решта дій — dev-заглушки.
 */
function makeAdmin(state: UiState, opts: { offline?: boolean } = {}) {
  const store = createStore<UiState>(state);
  const api = fakeApi();
  const routeFns: ((r: Route) => void)[] = [];
  const navigate = vi.fn((to: Route) => {
    if (to.route === "admin") {
      store.setState((s) => {
        const selectedId = to.userId ?? null;
        return {
          route: "admin",
          admin: {
            ...s.admin,
            tab: to.tab ?? "users",
            selectedId,
            selected: selectedId === s.admin.selectedId ? s.admin.selected : null,
          },
        };
      });
    }
    for (const fn of routeFns) fn(to);
  });
  const refreshMe = vi.fn(async () => {});
  let all: Actions;
  const deps: PartDeps = {
    params: new URLSearchParams(""),
    api,
    actions: () => all,
    backend: fakeBackend(),
    offline: opts.offline ?? false,
    onRoute: (fn) => {
      routeFns.push(fn);
    },
  };
  const own = adminActions(store, deps);
  all = Object.assign(createDevActions(store), { navigate, refreshMe }, own) as unknown as Actions;
  const enter = () => {
    for (const fn of routeFns) fn({ route: "admin", tab: store.getState().admin.tab });
  };
  return { store, api, actions: all, own, navigate, refreshMe, enter };
}

/** Мікрозадачі й таймери нуля — щоб доїхали відповіді фейкового API. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const fetchStub = vi.fn(async () => {
  throw new Error("тест не ходить у мережу");
});

beforeEach(() => {
  globalThis.fetch = fetchStub as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
});

// ───────────── Чисті функції ─────────────

describe("admin-actions: розбір і поріг", () => {
  it("parseCredits: ціле ≠ 0, «+5», «−3» (U+2212), пробіли; решта — null", () => {
    expect(parseCredits("+5")).toBe(5);
    expect(parseCredits(`${MINUS}3`)).toBe(-3);
    expect(parseCredits(" - 1 0 ")).toBe(-10);
    expect(parseCredits("12")).toBe(12);
    for (const bad of ["", "0", "+0", "abc", "1.5", "1e2", "--3", "5+"]) expect(parseCredits(bad)).toBeNull();
  });

  it("needsConfirm: списання ≥ 20 або > 50% балансу", () => {
    expect(needsConfirm(-20, 500)).toBe(true);
    expect(needsConfirm(-19, 500)).toBe(false);
    expect(needsConfirm(-7, 12)).toBe(true);
    expect(needsConfirm(-6, 12)).toBe(false);
    expect(needsConfirm(-10, 12)).toBe(true);
    expect(needsConfirm(25, 12)).toBe(false);
  });
});

describe("views/admin.js: назви операцій і формати", () => {
  const olena = ADMIN_HISTORY[OLENA.id] ?? [];
  const byId = (id: string) => olena.find((e) => e.id === id) as LedgerEntry;

  it("назви з kind + ref (таблиця Референсу)", () => {
    expect(entryLabel(byId("video:p_flor"), PACKAGES)).toBe("Ролик");
    expect(entryLabel(byId("format:p_flor:landscape"), PACKAGES)).toBe("Додатковий формат 16:9");
    expect(entryLabel(byId("revision:p_zerno:r2"), PACKAGES)).toBe("Правка · рев. 2");
    expect(entryLabel(byId("refund:p_shyna"), PACKAGES)).toBe("Повернення за збій");
    expect(entryLabel(byId("adjust:k8Hd"), PACKAGES)).toBe("Коригування");
    expect(entryLabel(byId("topup:t_8f2k"), PACKAGES)).toBe("Поповнення · Кілька роликів");
    expect(entryLabel(byId("topup:t_c22"), PACKAGES)).toBe("Поповнення · своя сума");
    expect(entryLabel(byId("topup:t_c22"), [])).toBe("Поповнення");
    expect(entryLabel({ ...byId("adjust:k8Hd"), kind: "bonus" }, PACKAGES)).toBe("Вітальний бонус");
  });

  it("підрядок: хост проєкту або «Без сайту», примітка лише в коригування", () => {
    expect(entrySub(byId("video:p_flor"), ALL_PROJECTS)).toBe("florist-kyiv.example.com");
    expect(entrySub(byId("video:p_kav"), ALL_PROJECTS)).toBe("Без сайту");
    expect(entrySub(byId("adjust:k8Hd"), ALL_PROJECTS)).toBe("«Компенсація за затримку»");
    expect(entrySub(byId("topup:t_8f2k"), ALL_PROJECTS)).toBe("");
    expect(entrySub(byId("video:p_flor"), [])).toBe("");
  });

  it("хост з адреси, дати в локальному часі", () => {
    expect(hostOf("https://zerno.example.com/menu")).toBe("zerno.example.com");
    expect(hostOf("zerno.example.com")).toBe("zerno.example.com");
    const d = new Date(2026, 9, 14, 10, 5);
    expect(formatDate(d.toISOString())).toBe("14.10.2026");
    expect(formatDayTime(d.toISOString())).toBe("14.10 10:05");
    expect(formatDate(null)).toBe("");
  });

  it("filterUsers: за e-mail без урахування регістру", () => {
    expect(filterUsers(USERS, "FLORIST").map((u) => u.id)).toEqual([IRYNA.id]);
    expect(filterUsers(USERS, "  ")).toHaveLength(4);
    expect(filterUsers(USERS, "нікого")).toEqual([]);
  });
});

// ───────────── Дії ─────────────

describe("data/admin-actions.js", () => {
  it("вхід на admin: users, outbox і всі проєкти (?all=1); loading лише до перших даних", async () => {
    const { store, api, enter } = makeAdmin(adminState({ users: [], outbox: [], allProjects: [] }));
    enter();
    expect(store.getState().admin.loading).toBe(true);
    await settle();
    const a = store.getState().admin;
    expect(a.loading).toBe(false);
    expect(a.users).toEqual(USERS);
    expect(a.outbox).toEqual(OUTBOX);
    expect(a.allProjects).toEqual(ALL_PROJECTS);
    expect(api.listProjects).toHaveBeenCalledWith({ all: true });
    // Повторний вхід (вкладка) — тихо, без «Завантажую…».
    enter();
    expect(store.getState().admin.loading).toBe(false);
    await settle();
    expect(api.adminUsers).toHaveBeenCalledTimes(2);
  });

  it("на інших маршрутах, при forbidden і offline — без запитів", async () => {
    const a = makeAdmin(adminState());
    a.navigate({ route: "cabinet", section: "balance" });
    const b = makeAdmin(adminState({ forbidden: true }));
    b.enter();
    const c = makeAdmin(adminState(), { offline: true });
    c.enter();
    await settle();
    for (const { api } of [a, b, c]) {
      expect(api.adminUsers).not.toHaveBeenCalled();
      expect(api.adminUser).not.toHaveBeenCalled();
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("старт на ?admin=users&user=X: selectedId є, selected — null → вантажить користувача", async () => {
    const { store, api, enter } = makeAdmin(adminState({ selectedId: ANDRIY.id, selected: null }));
    enter();
    await settle();
    expect(api.adminUser).toHaveBeenCalledWith(ANDRIY.id);
    expect(api.adminTransactions).toHaveBeenCalledWith(ANDRIY.id, { limit: 5 });
    const sel = store.getState().admin.selected;
    expect(sel?.user.id).toBe(ANDRIY.id);
    expect(sel?.balance).toBe(0);
    expect(sel?.entries).toEqual(ADMIN_HISTORY[ANDRIY.id]);
  });

  it("adminSelect → маршрут з userId і одне завантаження; скидає чернетку", async () => {
    const { store, api, own, navigate } = makeAdmin(
      adminState({ adjust: { ...adminState().admin.adjust, credits: "+5", note: "x" } }),
    );
    await own.adminSelect(OLENA.id);
    expect(navigate).toHaveBeenCalledWith({ route: "admin", tab: "users", userId: OLENA.id });
    expect(api.adminUser).toHaveBeenCalledTimes(1);
    const a = store.getState().admin;
    expect(a.selected?.user.id).toBe(OLENA.id);
    expect(a.adjust.credits).toBe("");
    expect(a.adjust.note).toBe("");
  });

  it("adminTab → navigate; «Користувачі» повертає обраного", () => {
    const { own, navigate, store } = makeAdmin(adminState(selectedOf(OLENA, 12)));
    own.adminTab("outbox");
    expect(navigate).toHaveBeenLastCalledWith({ route: "admin", tab: "outbox" });
    expect(store.getState().admin.selectedId).toBeNull();
    own.adminTab("users");
    expect(navigate).toHaveBeenLastCalledWith({ route: "admin", tab: "users", userId: OLENA.id });
    own.adminTab("users");
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("adminSearch пише q без запиту; adminField скидає помилку і done", () => {
    const { own, store, api } = makeAdmin(
      adminState({
        ...selectedOf(OLENA, 12),
        adjust: { credits: "x", note: "", busy: false, confirm: false, error: "zero", done: null },
      }),
    );
    own.adminSearch("florist");
    expect(store.getState().admin.q).toBe("florist");
    own.adminField("credits", "+5");
    expect(store.getState().admin.adjust).toMatchObject({ credits: "+5", error: null, done: null });
    own.adminField("note", "компенсація");
    expect(store.getState().admin.adjust.note).toBe("компенсація");
    expect(api.adminUsers).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  describe("adminAdjust", () => {
    const withAdjust = (credits: string, note = "", sel = selectedOf(OLENA, 12)) =>
      adminState({ ...sel, adjust: { credits, note, busy: false, confirm: false, error: null, done: null } });

    it("валідація без запиту: не ціле / 0 → zero; > 200 → note; нижче нуля → {need, have}", async () => {
      for (const credits of ["", "0", "abc", "1.5"]) {
        const { own, store, api } = makeAdmin(withAdjust(credits));
        await own.adminAdjust();
        expect(store.getState().admin.adjust.error).toBe("zero");
        expect(api.adminCredits).not.toHaveBeenCalled();
      }
      const long = makeAdmin(withAdjust("+5", "x".repeat(201)));
      await long.own.adminAdjust();
      expect(long.store.getState().admin.adjust.error).toBe("note");
      const below = makeAdmin(withAdjust(`${MINUS}5`, "тест", selectedOf(ANDRIY, 0)));
      await below.own.adminAdjust(true);
      expect(below.store.getState().admin.adjust.error).toEqual({ need: 5, have: 0 });
      expect(below.api.adminCredits).not.toHaveBeenCalled();
    });

    it("нарахування +5 → POST, запис зверху, баланс у таблиці, done; поля очищено", async () => {
      const { own, store, api, refreshMe } = makeAdmin(withAdjust("+5", " компенсація "));
      await own.adminAdjust();
      expect(api.adminCredits).toHaveBeenCalledWith(OLENA.id, { credits: 5, note: "компенсація" });
      const a = store.getState().admin;
      expect(a.adjust).toEqual({
        credits: "",
        note: "",
        busy: false,
        confirm: false,
        error: null,
        done: { credits: 5, note: "компенсація", balance: 17 },
      });
      expect(a.selected?.balance).toBe(17);
      expect(a.selected?.entries[0]?.id).toBe("adjust:new");
      expect(a.selected?.entries).toHaveLength((ADMIN_HISTORY[OLENA.id] ?? []).length + 1);
      expect(a.users.find((u) => u.id === OLENA.id)?.balance).toBe(17);
      expect(refreshMe).not.toHaveBeenCalled();
    });

    it("busy під час запиту; повторний виклик ігнорується", async () => {
      const { own, store, api } = makeAdmin(withAdjust("+5"));
      let release: () => void = () => {};
      vi.mocked(api.adminCredits).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ entry: { ...(ADMIN_HISTORY[OLENA.id]?.[0] as LedgerEntry) }, balance: 17 });
          }),
      );
      const p = own.adminAdjust();
      expect(store.getState().admin.adjust.busy).toBe(true);
      await own.adminAdjust();
      expect(api.adminCredits).toHaveBeenCalledTimes(1);
      release();
      await p;
      expect(store.getState().admin.adjust.busy).toBe(false);
    });

    it("велике списання: спершу confirm, «Так, списати» → POST; «Скасувати» → назад", async () => {
      const { own, store, api } = makeAdmin(withAdjust(`${MINUS}10`, "помилкове нарахування"));
      await own.adminAdjust();
      expect(store.getState().admin.adjust.confirm).toBe(true);
      expect(api.adminCredits).not.toHaveBeenCalled();
      own.adminCancelConfirm();
      expect(store.getState().admin.adjust.confirm).toBe(false);
      await own.adminAdjust();
      await own.adminAdjust(true);
      expect(api.adminCredits).toHaveBeenCalledWith(OLENA.id, {
        credits: -10,
        note: "помилкове нарахування",
      });
      expect(store.getState().admin.adjust.done).toEqual({
        credits: -10,
        note: "помилкове нарахування",
        balance: 2,
      });
    });

    it("мале списання — без підтвердження", async () => {
      const { own, store, api } = makeAdmin(withAdjust("-3"));
      await own.adminAdjust();
      expect(store.getState().admin.adjust.confirm).toBe(false);
      expect(api.adminCredits).toHaveBeenCalledWith(OLENA.id, { credits: -3, note: "" });
    });

    it("402 від сервера → {need: required, have: available}", async () => {
      const { own, store, api } = makeAdmin(withAdjust("-3"));
      vi.mocked(api.adminCredits).mockRejectedValueOnce(
        new ApiError("Баланс не може стати від'ємним", 402, "insufficient_credits", {
          error: "insufficient_credits",
          required: 3,
          available: 1,
        }),
      );
      await own.adminAdjust();
      const a = store.getState().admin;
      expect(a.adjust.error).toEqual({ need: 3, have: 1 });
      expect(a.adjust.busy).toBe(false);
      expect(a.selected?.balance).toBe(1);
    });

    it("адмін коригує себе → refreshMe (баланс у топбарі)", async () => {
      const { own, refreshMe } = makeAdmin(withAdjust("+5", "", selectedOf(ADMIN, 500)));
      await own.adminAdjust();
      expect(refreshMe).toHaveBeenCalledTimes(1);
    });
  });

  it("adminCopy → clipboard.writeText(link), «copied» на 2 с", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { own, store } = makeAdmin(adminState({ tab: "outbox" }));
    await own.adminCopy("m1");
    expect(writeText).toHaveBeenCalledWith(OUTBOX[0]?.link);
    expect(store.getState().admin.copied).toBe("m1");
    vi.advanceTimersByTime(COPIED_MS - 1);
    expect(store.getState().admin.copied).toBe("m1");
    vi.advanceTimersByTime(1);
    expect(store.getState().admin.copied).toBeNull();
  });
});

describe("ядро + admin-actions (createAccountActions)", () => {
  function boot(query: string, me = ADMIN_ME) {
    const params = new URLSearchParams(query);
    const store = createStore<UiState>(stateForUrl(params));
    const api = fakeApi();
    vi.mocked(api.me).mockImplementation(async () => me);
    const actions = createAccountActions(store, { params, backend: fakeBackend(), api });
    return { store, api, actions };
  }

  it("?admin=users&user=X: після me вантажить списки й обраного користувача", async () => {
    const { store, api, actions } = boot("admin=users&user=u_olena01");
    expect(store.getState().admin.selectedId).toBe(OLENA.id);
    expect(store.getState().admin.selected).toBeNull();
    await actions.meReady;
    await settle();
    expect(api.adminUsers).toHaveBeenCalled();
    expect(api.adminUser).toHaveBeenCalledWith(OLENA.id);
    expect(store.getState().admin.selected?.user.id).toBe(OLENA.id);
    actions.dispose();
  });

  it("не-адмін на admin → forbidden, без запитів адмінки", async () => {
    const { store, api, actions } = boot("admin=users", ME);
    await actions.meReady;
    await settle();
    expect(store.getState().admin.forbidden).toBe(true);
    expect(api.adminUsers).not.toHaveBeenCalled();
    actions.dispose();
  });
});

// ───────────── View ─────────────

describe("views/admin.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  function mountWith(state: UiState) {
    const made = makeAdmin(state);
    const view = mount(host, { store: made.store, actions: made.actions });
    made.store.subscribe((next, prev) => view.update(next, prev));
    return { ...made, view };
  }

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const all = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
  const visible = (sel: string) => {
    const el = q(sel);
    return !!el && !el.closest("[hidden]");
  };
  const input = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("підшапка: «Адмінка», вкладки з лічильниками; «Статистики» немає", () => {
    const { view } = mountWith(adminState(selectedOf(OLENA, 12)));
    expect(q(".adm-title")?.textContent).toBe("Адмінка");
    const tabs = all('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Користувачі 4",
      "Outbox 2",
      "Усі проєкти 7",
      "Використання",
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(q(".adm-stats")).toBeNull();
    expect(q(".adm-head")?.querySelector("a")).toBeNull();
    expect(q(".adm-head")?.textContent).not.toContain("Статистика");
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("клік і стрілки по вкладках → adminTab", () => {
    const { navigate } = mountWith(adminState());
    all('[role="tab"]')[2]?.click();
    expect(navigate).toHaveBeenLastCalledWith({ route: "admin", tab: "all" });
    const tab = all('[role="tab"]')[2] as HTMLElement;
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(navigate).toHaveBeenLastCalledWith({ route: "admin", tab: "usage" });
    const last = all('[role="tab"]')[3] as HTMLElement;
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(navigate).toHaveBeenLastCalledWith({ route: "admin", tab: "users" });
  });

  it("таблиця: рядки, «адмін», активація, баланс, обраний — aria-selected", () => {
    mountWith(adminState(selectedOf(OLENA, 12)));
    const rows = all(".adm-urow--user");
    expect(rows).toHaveLength(4);
    expect(q(".adm-count")?.textContent).toBe("4 з 4");
    expect(rows[0]?.querySelector<HTMLElement>(".adm-urow__admin")?.hidden).toBe(false);
    expect(rows[1]?.querySelector<HTMLElement>(".adm-urow__admin")?.hidden).toBe(true);
    expect(rows[3]?.querySelector(".adm-urow__act")?.textContent).toBe("не активовано");
    expect(rows[0]?.querySelector(".adm-urow__bal")?.textContent).toBe("500");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
  });

  it("пошук фільтрує на клієнті без запиту; порожньо — «Нікого не знайдено за «…».»", () => {
    const { api } = mountWith(adminState());
    const search = q<HTMLInputElement>(".adm-search__input") as HTMLInputElement;
    input(search, "florist");
    expect(all(".adm-urow--user").map((r) => r.dataset.id)).toEqual([IRYNA.id]);
    expect(q(".adm-count")?.textContent).toBe("1 з 4");
    input(search, "zzz");
    expect(all(".adm-urow--user")).toHaveLength(0);
    expect(q(".adm-empty--table")?.textContent).toBe("Нікого не знайдено за «zzz».");
    expect(api.adminUsers).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("клік по рядку → adminSelect: панель показує користувача, фокус лишається на рядку", async () => {
    const { navigate, store } = mountWith(adminState());
    expect(q(".adm-panel__hint")?.hidden).toBe(false);
    const row = all(".adm-urow--user")[2] as HTMLButtonElement;
    row.focus();
    row.click();
    await settle();
    expect(navigate).toHaveBeenCalledWith({ route: "admin", tab: "users", userId: ANDRIY.id });
    expect(store.getState().admin.selected?.user.id).toBe(ANDRIY.id);
    expect(document.activeElement).toBe(row);
    expect(q(".adm-panel__hint")?.hidden).toBe(true);
    expect(q(".adm-panel__name")?.textContent).toBe("Андрій Мельник");
    expect(q(".adm-panel .label-s")?.textContent).toBe("клієнт");
    expect(q(".adm-balance")?.textContent).toBe("0кредитів");
    expect(all(".adm-op__label").map((e) => e.textContent)).toEqual(["Ролик", "Поповнення · Старт"]);
    expect(all(".adm-op__after").map((e) => e.textContent)).toEqual(["→ 0", "→ 10"]);
  });

  it("панель: останні 5 операцій, суми зі знаком U+2212", () => {
    mountWith(adminState(selectedOf(OLENA, 12)));
    expect(all(".adm-op")).toHaveLength(5);
    expect(q(".adm-op__sum")?.textContent).toBe(`${MINUS}2`);
    expect(q(".adm-panel__meta")?.textContent).toMatch(/^створено \d\d\.\d\d\.2026 · активовано /);
  });

  it("коригування: прев’ю, «Нарахувати» / «Списати», лічильник примітки", () => {
    mountWith(adminState(selectedOf(OLENA, 12)));
    const credits = q<HTMLInputElement>(".adm-field__input--credits") as HTMLInputElement;
    const note = q<HTMLInputElement>(".adm-field__input--note") as HTMLInputElement;
    expect(credits.placeholder).toBe(`+5 або ${MINUS}3`);
    expect(visible(".adm-adjust__preview")).toBe(false);
    input(credits, "+5");
    expect(q(".adm-adjust__preview")?.textContent).toBe("баланс 12 → 17");
    expect(q(".adm-submit")?.textContent).toBe("Нарахувати");
    input(credits, `${MINUS}3`);
    expect(q(".adm-adjust__preview")?.textContent).toBe("баланс 12 → 9");
    expect(q(".adm-submit")?.textContent).toBe("Списати");
    input(note, "компенсація");
    expect(q(".adm-field__count")?.textContent).toBe("11/200");
    input(note, "x".repeat(201));
    expect(q(".adm-field__count")?.classList.contains("is-over")).toBe(true);
  });

  it("велике списання: блок підтвердження з фокусом, «Скасувати» повертає кнопку", async () => {
    mountWith(adminState(selectedOf(OLENA, 12)));
    input(q<HTMLInputElement>(".adm-field__input--credits") as HTMLInputElement, `${MINUS}10`);
    (q(".adm-submit") as HTMLButtonElement).click();
    await settle();
    expect(visible(".adm-confirm")).toBe(true);
    expect(q(".adm-confirm")?.getAttribute("role")).toBe("alertdialog");
    expect(q(".adm-confirm__text")?.textContent).toBe(
      `Списати 10${NBSP}кредитів у ${OLENA.email}? Баланс стане 2.`,
    );
    expect(visible(".adm-submit")).toBe(false);
    expect(document.activeElement?.textContent).toBe("Так, списати");
    const cancel = all(".adm-confirm button")[1] as HTMLButtonElement;
    cancel.focus();
    cancel.click();
    expect(visible(".adm-confirm")).toBe(false);
    expect(document.activeElement).toBe(q(".adm-submit"));
  });

  it("«Так, списати» → запит і «✓ Списано −10 · «…». Баланс 2.», новий запис зверху з fade", async () => {
    const { api } = mountWith(adminState(selectedOf(OLENA, 12)));
    input(q<HTMLInputElement>(".adm-field__input--credits") as HTMLInputElement, `${MINUS}10`);
    input(q<HTMLInputElement>(".adm-field__input--note") as HTMLInputElement, "помилкове нарахування");
    (q(".adm-submit") as HTMLButtonElement).click();
    await settle();
    (all(".adm-confirm button")[0] as HTMLButtonElement).click();
    await settle();
    expect(api.adminCredits).toHaveBeenCalledWith(OLENA.id, { credits: -10, note: "помилкове нарахування" });
    expect(q(".adm-adjust__done")?.textContent).toBe(
      `✓ Списано ${MINUS}10 · «помилкове нарахування». Баланс 2.`,
    );
    expect(q(".adm-adjust__done")?.getAttribute("role")).toBe("status");
    const first = q(".adm-op");
    expect(first?.classList.contains("adm-op--fresh")).toBe(true);
    expect(first?.querySelector(".adm-op__label")?.textContent).toBe("Коригування");
    expect(all(".adm-op--fresh")).toHaveLength(1);
    expect(q(".adm-balance__num")?.textContent).toBe("2");
    expect((q(".adm-field__input--credits") as HTMLInputElement).value).toBe("");
  });

  it("помилки: zero, note, 402 — тексти з кадру, aria-invalid", () => {
    const base = adminState(selectedOf(ANDRIY, 0)).admin.adjust;
    const { store } = mountWith(adminState({ ...selectedOf(ANDRIY, 0), adjust: { ...base, error: "zero" } }));
    expect(q(".adm-adjust__error")?.textContent).toBe(`Ціле число, не нуль: +5 або ${MINUS}3.`);
    expect(q(".adm-field__input--credits")?.getAttribute("aria-invalid")).toBe("true");
    store.setState((s) => ({ admin: { ...s.admin, adjust: { ...base, error: "note" } } }));
    expect(q(".adm-adjust__error")?.textContent).toBe("Примітка — до 200 символів.");
    expect(q(".adm-field__input--note")?.getAttribute("aria-invalid")).toBe("true");
    expect(q(".adm-field__input--credits")?.getAttribute("aria-invalid")).toBe("false");
    store.setState((s) => ({
      admin: { ...s.admin, adjust: { ...base, credits: "-5", error: { need: 5, have: 0 } } },
    }));
    expect(q(".adm-adjust__error")?.textContent).toBe("Не вистачає кредитів: потрібно 5, у вас 0.");
    expect(q(".adm-adjust__error")?.getAttribute("role")).toBe("alert");
    expect(visible(".adm-adjust__preview")).toBe(false);
  });

  it("busy: кнопка disabled зі спінером", () => {
    const base = adminState().admin.adjust;
    mountWith(adminState({ ...selectedOf(OLENA, 12), adjust: { ...base, credits: "+5", busy: true } }));
    const submit = q<HTMLButtonElement>(".adm-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(q(".adm-submit__spinner")?.hidden).toBe(false);
  });

  it("outbox: тема, pill, адреса, «Копіювати» → «✓ Скопійовано», «Відкрити ↗» → window.open", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    mountWith(adminState({ tab: "outbox" }));
    expect(visible(".adm-outbox")).toBe(true);
    expect(visible(".adm-users")).toBe(false);
    expect(visible(".adm-panel")).toBe(false);
    const rows = all(".adm-mail");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector(".adm-mail__subject")?.textContent).toBe("Активація акаунта AdCreative");
    expect(rows[0]?.querySelector(".adm-mail__kind")?.textContent).toBe("активація");
    expect(rows[1]?.querySelector(".adm-mail__kind")?.textContent).toBe("скидання");
    expect(rows[0]?.querySelector(".adm-mail__link")?.getAttribute("title")).toBe(OUTBOX[0]?.link);
    const [copy, openBtn] = [...(rows[0]?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
    expect(copy?.textContent).toBe("Копіювати");
    copy?.focus();
    copy?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(OUTBOX[0]?.link);
    expect(copy?.textContent).toBe("✓ Скопійовано");
    expect(document.activeElement).toBe(copy);
    vi.advanceTimersByTime(COPIED_MS);
    expect(copy?.textContent).toBe("Копіювати");
    openBtn?.click();
    expect(open).toHaveBeenCalledWith(OUTBOX[0]?.link, "_blank", "noopener");
  });

  it("outbox порожній — «Листів ще немає.»", () => {
    mountWith(adminState({ tab: "outbox", outbox: [] }));
    expect(visible(".adm-empty--outbox")).toBe(true);
    expect(q(".adm-empty--outbox")?.textContent).toBe("Листів ще немає.");
  });

  it("усі проєкти: хост / «Без сайту», власник за e-mail або «без власника · eval/CLI», $", () => {
    mountWith(adminState({ tab: "all" }));
    const rows = all(".adm-all [role='rowgroup'] .adm-prow");
    expect(rows).toHaveLength(7);
    const cells = (i: number) => [...(rows[i]?.children ?? [])].map((c) => c.textContent);
    expect(cells(0)).toEqual([
      "florist-kyiv.example.com",
      OLENA.email,
      "рендерю",
      "9:16 · 16:9",
      expect.stringMatching(/^\d\d\.10$/),
      "$2.40",
    ]);
    expect(cells(1)[0]).toBe("Без сайту");
    expect(cells(4)[1]).toBe(ANDRIY.email);
    expect(cells(5)[1]).toBe("без власника · eval/CLI");
    expect(rows[5]?.querySelector(".adm-prow__owner--none")).not.toBeNull();
    expect(rows[2]?.querySelector(".adm-prow__status--failed")).not.toBeNull();
  });

  it("loading: «Завантажую…», без таблиці й панелі", () => {
    mountWith(adminState({ loading: true }));
    expect(visible(".adm-loading")).toBe(true);
    expect(q(".adm-loading")?.getAttribute("role")).toBe("status");
    expect(visible(".adm-users")).toBe(false);
    expect(visible(".adm-panel")).toBe(false);
  });

  it("порожньо: «Користувачів ще немає.», «0 з 0», підказка в панелі", () => {
    mountWith(adminState({ users: [], outbox: [] }));
    expect(q(".adm-empty--table")?.textContent).toBe("Користувачів ще немає.");
    expect(q(".adm-count")?.textContent).toBe("0 з 0");
    expect(q(".adm-panel__hint")?.textContent).toBe(
      "Оберіть користувача в списку — деталі, баланс і коригування з’являться тут.",
    );
  });

  it("forbidden → mountForbidden (B12) замість адмінки; знято — destroy", () => {
    const { store, view } = mountWith(adminState({ forbidden: true }));
    expect(forbidden.mount).toHaveBeenCalledTimes(1);
    expect(q(".fake-403")).not.toBeNull();
    expect(q(".adm-tabs")?.hidden).toBe(true);
    expect(visible(".adm-users")).toBe(false);
    expect(visible(".adm-panel")).toBe(false);
    const handle = forbidden.mount.mock.results[0]?.value as { destroy: ReturnType<typeof vi.fn> };
    store.setState((s) => ({ admin: { ...s.admin, forbidden: false } }));
    expect(handle.destroy).toHaveBeenCalled();
    expect(q(".fake-403")).toBeNull();
    expect(visible(".adm-users")).toBe(true);
    view.destroy();
  });

  it("DOM без HTML-рядків: e-mail з «<b>» лишається текстом", () => {
    const evil = { ...IRYNA, id: "u_evil0001", email: "<b>x</b>@example.com", name: "<img src=x>" };
    mountWith(adminState({ users: [{ ...evil, balance: 0 }] }));
    expect(q(".adm-urow__email-text")?.textContent).toBe("<b>x</b>@example.com");
    expect(host.querySelector("b.adm-urow__email-text b, img")).toBeNull();
  });
});

describe("dev/fixtures/admin.js", () => {
  const NAMES = [
    "adm-users",
    "adm-user",
    "adm-done",
    "adm-confirm",
    "adm-402",
    "adm-outbox",
    "adm-all",
    "adm-search",
    "adm-empty",
    "adm-loading",
  ];

  it("рівно кадри #N14, у fixtureStates, під адміном на маршруті admin", () => {
    expect(Object.keys(adminFixtures).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      const s = fixtureStates[name] as UiState;
      expect(s, name).toBeDefined();
      expect(s.route).toBe("admin");
      expect(s.account.me?.user.isAdmin).toBe(true);
      expect(s.account.prices).toEqual(PRICES);
    }
  });

  it("кожна фікстура монтується; ключові тексти кадрів", () => {
    const text = (name: string, sel: string) => {
      const el = document.createElement("div");
      document.body.append(el);
      const store = createStore<UiState>(fixtureStates[name] as UiState);
      const view = mount(el, { store, actions: createDevActions(store) });
      const out = el.querySelector(sel)?.textContent ?? null;
      view.destroy();
      el.remove();
      return out;
    };
    expect(text("adm-user", ".adm-adjust__preview")).toBe("баланс 12 → 17");
    expect(text("adm-done", ".adm-adjust__done")).toBe("✓ Нараховано +5 · «компенсація». Баланс 17.");
    expect(text("adm-confirm", ".adm-confirm__text")).toBe(
      `Списати 10${NBSP}кредитів у ${OLENA.email}? Баланс стане 2.`,
    );
    expect(text("adm-402", ".adm-adjust__error")).toBe("Не вистачає кредитів: потрібно 5, у вас 0.");
    expect(text("adm-outbox", ".adm-tag")).toBe("✓ Скопійовано");
    expect(text("adm-search", ".adm-count")).toBe("1 з 4");
    expect(text("adm-empty", ".adm-empty--table")).toBe("Користувачів ще немає.");
    expect(text("adm-loading", ".adm-loading")).toBe("Завантажую…");
    expect(text("adm-all", ".adm-prow__owner--none")).toBe("без власника · eval/CLI");
    expect(text("adm-users", ".adm-panel__name")).toBe("Олена Коваль");
    expect(warn).not.toHaveBeenCalled();
  });
});
