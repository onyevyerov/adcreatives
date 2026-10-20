// @vitest-environment happy-dom
/**
 * B7 · data/topup-actions.js: openTopup (точка повернення, банер, передвибір), вибір пакета і своєї
 * суми, submitTopup (перевірка, POST topups → чек), continueTopup, незавершені поповнення на вході
 * в «Баланс», `cabinet.backTo` при вході в кабінет не через openTopup.
 */
import { t } from "@adc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountFixture,
  meOf,
  OLENA,
  PACKAGES,
  PENDING_TOPUP,
  TOPUPS,
} from "../../public/static/dev/fixtures/_base.js";
import type {
  AccountApi,
  Actions,
  PartDeps,
  Route,
  TopUp,
  UiState,
} from "../../public/static/js/contracts.js";
import {
  customError,
  defaultPackage,
  selectedCredits,
  selectedPackage,
  topupActions,
} from "../../public/static/js/data/topup-actions.js";
import { initialState } from "../../public/static/js/initial.js";
import { RETURN_KEY, takeReturn } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";

const CUSTOM = { min: 5, max: 500 };

/** Робочий простір проєкту з балансом `balance`. */
function project(balance: number, patch: Partial<UiState> = {}): UiState {
  const base = {
    ...initialState("project", "p_zerno"),
    site: "zerno.example.com",
    status: "awaiting_storyboard" as const,
  };
  const s = accountFixture({ account: { me: meOf(OLENA, balance) } }, base);
  return { ...s, route: "project", ...patch };
}

function start(balance: number): UiState {
  return accountFixture({ account: { me: meOf(OLENA, balance) } });
}

function cabinet(patch: Partial<UiState["cabinet"]> = {}, balance = 12): UiState {
  const s = accountFixture({ route: "cabinet", account: { me: meOf(OLENA, balance) } });
  return { ...s, cabinet: { ...s.cabinet, section: "balance", ...patch } };
}

const assistant = (text: string) => ({
  kind: "message" as const,
  id: `m${text.length}`,
  at: "2026-10-19T08:00:00.000Z",
  role: "assistant" as const,
  text,
  buttons: [],
});

/** Store + фабрика з підміненими залежностями; `navigate` застосовує маршрут до стану. */
function setup(state: UiState, opts: { offline?: boolean; api?: Partial<AccountApi> } = {}) {
  const store = createStore(state);
  const routes: ((r: Route) => void)[] = [];
  // Тіло loadHistory — B9; тут лише факт виклику.
  const loadHistory = vi.fn(async () => {});
  const navigate = vi.fn((to: Route) => {
    store.setState((s) =>
      to.route === "cabinet"
        ? { route: "cabinet", cabinet: { ...s.cabinet, section: to.section } }
        : to.route === "project"
          ? { route: "project", projectId: to.projectId }
          : { route: to.route },
    );
  });
  const api = {
    listTopUps: vi.fn(async () => ({ topups: [] as TopUp[] })),
    createTopUp: vi.fn(async (_body: { packageId: string } | { credits: number }) => ({
      topup: { ...PENDING_TOPUP, id: "t_new1" },
      checkoutUrl: "/?checkout=t_new1",
    })),
    ...opts.api,
  };
  const deps = {
    params: new URLSearchParams(),
    api: api as unknown as AccountApi,
    actions: () => ({ navigate, loadHistory }) as unknown as Actions,
    backend: { start: vi.fn(), stop: vi.fn() },
    offline: opts.offline ?? false,
    onRoute: (fn: (r: Route) => void) => {
      routes.push(fn);
    },
  } as unknown as PartDeps;
  const actions = topupActions(store, deps);
  const enter = (r: Route) => {
    for (const fn of routes) fn(r);
  };
  return { store, actions, api, navigate, enter, loadHistory };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`fetch у тесті: ${String(input)}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockClear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("topupActions: ключі part-файла", () => {
  it("рівно ключі B7 з AccountActions", () => {
    const { actions } = setup(cabinet());
    expect(Object.keys(actions).sort()).toEqual(
      ["continueTopup", "openTopup", "selectPackage", "setCustom", "submitTopup"].sort(),
    );
  });
});

describe("customError і вибір", () => {
  it("порожньо / не ціле / поза межами / ок", () => {
    expect(customError("", CUSTOM)).toBe("empty");
    expect(customError("   ", CUSTOM)).toBe("empty");
    expect(customError("12.5", CUSTOM)).toBe("integer");
    expect(customError("12,5", CUSTOM)).toBe("integer");
    expect(customError("abc", CUSTOM)).toBe("integer");
    expect(customError("700", CUSTOM)).toBe("range");
    expect(customError("4", CUSTOM)).toBe("range");
    expect(customError("5", CUSTOM)).toBeNull();
    expect(customError(" 40 ", CUSTOM)).toBeNull();
    expect(customError("500", CUSTOM)).toBeNull();
  });

  it("пакет за замовчуванням — середній; невідомий id — нічого", () => {
    expect(defaultPackage(PACKAGES)?.id).toBe("standard");
    expect(defaultPackage(PACKAGES.slice(0, 1))?.id).toBe("starter");
    expect(defaultPackage([])).toBeNull();
    const t0 = { mode: "package" as const, packageId: null, custom: "", error: false, busy: false };
    expect(selectedPackage(t0, PACKAGES)?.id).toBe("standard");
    expect(selectedPackage({ ...t0, packageId: "pro" }, PACKAGES)?.id).toBe("pro");
    expect(selectedPackage({ ...t0, packageId: "gone" }, PACKAGES)).toBeNull();
    expect(selectedPackage({ ...t0, mode: "custom" }, PACKAGES)).toBeNull();
    const me = meOf(OLENA, 12);
    expect(selectedCredits({ ...t0, packageId: "pro" }, me)).toBe(60);
    expect(selectedCredits({ ...t0, mode: "custom", custom: "40" }, me)).toBe(40);
    expect(selectedCredits({ ...t0, mode: "custom", custom: "700" }, me)).toBeNull();
  });
});

describe("openTopup", () => {
  it("зі старту: повернення на старт, пакет закриває нестачу на ролик, перехід у «Баланс»", () => {
    const { store, actions, navigate } = setup(start(4));
    actions.openTopup({ from: "start" });
    expect(JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? "null")).toEqual({ kind: "start" });
    expect(navigate).toHaveBeenCalledWith({ route: "cabinet", section: "balance" });
    const s = store.getState();
    expect(s.route).toBe("cabinet");
    expect(s.cabinet.backTo).toEqual({ kind: "start" });
    expect(s.cabinet.topup).toMatchObject({ mode: "package", packageId: "starter", error: false });
  });

  it("зі старту з K3: нестача з ui.startShortage", () => {
    const s0 = start(0);
    const { store, actions } = setup({ ...s0, ui: { ...s0.ui, startShortage: { need: 10, have: -5 } } });
    actions.openTopup({ from: "start" });
    expect(store.getState().cabinet.topup.packageId).toBe("standard");
  });

  it("з проєкту: повернення в проєкт з retry, нестача — з останньої відмови в чаті", () => {
    const refusal = t("insufficientCreditsFormats", { need: 2, have: 1 });
    const { store, actions } = setup(project(1, { feed: [assistant("Привіт"), assistant(refusal)] }));
    actions.openTopup({ from: "ws", ctx: "cp3" });
    expect(takeReturn()).toEqual({
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: { ctx: "cp3", text: null },
    });
    const s = store.getState();
    expect(s.cabinet.backTo).toMatchObject({ kind: "project", retry: { ctx: "cp3", text: null } });
    expect(s.cabinet.topup.packageId).toBe("starter");
  });

  it("з проєкту, правка: текст правки в retry; нестача — ціна правки", () => {
    const { store, actions } = setup(project(0, { status: "delivered" }));
    actions.openTopup({ from: "ws", text: "Зроби заголовок коротшим" });
    expect(store.getState().cabinet.backTo).toMatchObject({
      kind: "project",
      retry: { ctx: "rev", text: "Зроби заголовок коротшим" },
    });
    expect(store.getState().cabinet.topup.packageId).toBe("starter");
  });

  it("велика нестача — найбільший пакет", () => {
    const refusal = t("insufficientCredits", { need: 999, have: 0 });
    const { store, actions } = setup(project(0, { feed: [assistant(refusal)] }));
    actions.openTopup({ from: "ws", ctx: "cp3" });
    expect(store.getState().cabinet.topup.packageId).toBe("pro");
  });

  it("packageId і custom мають пріоритет над нестачею", () => {
    const a = setup(start(0));
    a.actions.openTopup({ from: "start", packageId: "pro" });
    expect(a.store.getState().cabinet.topup).toMatchObject({ mode: "package", packageId: "pro" });

    const b = setup(start(0));
    b.actions.openTopup({ from: "start", custom: 13 });
    expect(b.store.getState().cabinet.topup).toMatchObject({ mode: "custom", custom: "13" });
  });

  it("з топбару: повернення в кабінет; з проєкту — лише «← до host», без банера", () => {
    const { store, actions } = setup(project(12));
    actions.openTopup({ from: "topbar" });
    expect(takeReturn()).toEqual({ kind: "cabinet" });
    expect(store.getState().cabinet.backTo).toEqual({
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: null,
    });

    const c = setup(cabinet({ backTo: { kind: "start" } }));
    c.actions.openTopup({ from: "topbar" });
    expect(c.store.getState().cabinet.backTo).toBeNull();
    // Нестача невідома — вибір лишається.
    expect(c.store.getState().cabinet.topup.packageId).toBeNull();
  });

  it("знімає помилку і busy своєї суми", () => {
    const { store, actions } = setup(
      cabinet({ topup: { mode: "custom", packageId: null, custom: "", error: true, busy: false } }),
    );
    actions.openTopup({ from: "topbar" });
    expect(store.getState().cabinet.topup.error).toBe(false);
  });
});

describe("вхід у кабінет не через openTopup", () => {
  it("з проєкту — backTo без retry; зі старту — null", () => {
    const a = setup(project(12));
    a.store.setState({ route: "cabinet" });
    expect(a.store.getState().cabinet.backTo).toEqual({
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: null,
    });
    // Розділи всередині кабінету backTo не чіпають.
    a.store.setState((s) => ({ cabinet: { ...s.cabinet, section: "history" } }));
    expect(a.store.getState().cabinet.backTo?.kind).toBe("project");

    const b = setup({ ...start(12), cabinet: { ...start(12).cabinet, backTo: { kind: "start" } } });
    b.store.setState({ route: "cabinet" });
    expect(b.store.getState().cabinet.backTo).toBeNull();
  });
});

describe("selectPackage / setCustom", () => {
  it("тайл пакета, «Своя сума» і поле", () => {
    const { store, actions } = setup(
      cabinet({ topup: { mode: "custom", packageId: "pro", custom: "x", error: true, busy: false } }),
    );
    actions.selectPackage("starter");
    expect(store.getState().cabinet.topup).toMatchObject({
      mode: "package",
      packageId: "starter",
      error: false,
    });
    actions.selectPackage("custom");
    expect(store.getState().cabinet.topup).toMatchObject({
      mode: "custom",
      packageId: "starter",
      custom: "x",
    });
    actions.setCustom("40");
    expect(store.getState().cabinet.topup).toMatchObject({ mode: "custom", custom: "40", error: false });
  });
});

describe("submitTopup", () => {
  it.each([
    ["", "empty"],
    ["12.5", "integer"],
    ["700", "range"],
  ])("своя сума «%s» → помилка без запиту", async (custom) => {
    const { store, actions, api, navigate } = setup(
      cabinet({ topup: { mode: "custom", packageId: null, custom, error: false, busy: false } }),
    );
    await actions.submitTopup();
    expect(store.getState().cabinet.topup.error).toBe(true);
    expect(api.createTopUp).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("своя сума → POST {credits} → чек", async () => {
    const { store, actions, api, navigate } = setup(
      cabinet({ topup: { mode: "custom", packageId: null, custom: " 40 ", error: false, busy: false } }),
    );
    const p = actions.submitTopup();
    expect(store.getState().cabinet.topup.busy).toBe(true);
    await p;
    expect(api.createTopUp).toHaveBeenCalledWith({ credits: 40 });
    expect(navigate).toHaveBeenCalledWith({ route: "checkout", id: "t_new1" });
    expect(store.getState().cabinet.topup.busy).toBe(false);
  });

  it("пакет (за замовчуванням — середній) → POST {packageId}", async () => {
    const { actions, api } = setup(cabinet());
    await actions.submitTopup();
    expect(api.createTopUp).toHaveBeenCalledWith({ packageId: "standard" });
  });

  it("повторне натискання під час busy не шле другий запит", async () => {
    const { actions, api } = setup(
      cabinet({ topup: { mode: "package", packageId: "pro", custom: "", error: false, busy: true } }),
    );
    await actions.submitTopup();
    expect(api.createTopUp).not.toHaveBeenCalled();
  });

  it("невідомий пакет — нічого", async () => {
    const { actions, api } = setup(
      cabinet({ topup: { mode: "package", packageId: "gone", custom: "", error: false, busy: false } }),
    );
    await actions.submitTopup();
    expect(api.createTopUp).not.toHaveBeenCalled();
  });

  it("помилка сервера знімає busy, на чек не йдемо", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, actions, navigate } = setup(cabinet(), {
      api: {
        createTopUp: vi.fn(async () => {
          throw Object.assign(new Error("500"), { status: 500, code: null });
        }),
      },
    });
    await actions.submitTopup();
    expect(store.getState().cabinet.topup.busy).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("?mock=1 — без мережі", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { actions, api } = setup(cabinet(), { offline: true });
    await actions.submitTopup();
    expect(api.createTopUp).not.toHaveBeenCalled();
  });
});

describe("історія для мети «Історія · N» і бонусу", () => {
  const empty = (patch: Partial<UiState["cabinet"]["history"]> = {}) => {
    const s = cabinet();
    return { ...s, cabinet: { ...s.cabinet, history: { ...s.cabinet.history, entries: [], ...patch } } };
  };

  it("вхід у будь-який розділ кабінету з порожньою історією — loadHistory один раз", () => {
    const { enter, loadHistory } = setup(empty());
    enter({ route: "cabinet", section: "profile" });
    enter({ route: "cabinet", section: "balance" });
    enter({ route: "cabinet", section: "history" });
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledWith();
  });

  it("інший користувач після виходу — знову", () => {
    const { enter, loadHistory, store } = setup(empty());
    enter({ route: "cabinet", section: "balance" });
    store.setState((s) => ({
      account: { ...s.account, me: { ...meOf(OLENA, 3), user: { ...OLENA, id: "u_other001" } } },
    }));
    enter({ route: "cabinet", section: "balance" });
    expect(loadHistory).toHaveBeenCalledTimes(2);
  });

  it("не просимо: історія вже є, вантажиться, ?mock=1, інший маршрут, гість", () => {
    const a = setup(cabinet());
    a.enter({ route: "cabinet", section: "balance" });
    expect(a.loadHistory).not.toHaveBeenCalled();

    const b = setup(empty({ loading: true }));
    b.enter({ route: "cabinet", section: "balance" });
    expect(b.loadHistory).not.toHaveBeenCalled();

    const c = setup(empty(), { offline: true });
    c.enter({ route: "cabinet", section: "balance" });
    expect(c.loadHistory).not.toHaveBeenCalled();

    const d = setup(empty());
    d.enter({ route: "start" });
    d.enter({ route: "checkout", id: "t_1" });
    expect(d.loadHistory).not.toHaveBeenCalled();

    const s = empty();
    const e = setup({ ...s, account: { ...s.account, me: null, meStatus: "anon" } });
    e.enter({ route: "cabinet", section: "balance" });
    expect(e.loadHistory).not.toHaveBeenCalled();
  });

  it("збій loadHistory не валить вхід", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enter, loadHistory, api } = setup(empty());
    loadHistory.mockRejectedValueOnce(new Error("boom"));
    enter({ route: "cabinet", section: "balance" });
    await flush();
    expect(api.listTopUps).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("continueTopup і незавершені поповнення", () => {
  it("continueTopup → чек", () => {
    const { actions, navigate } = setup(cabinet());
    actions.continueTopup("t_9q4m");
    expect(navigate).toHaveBeenCalledWith({ route: "checkout", id: "t_9q4m" });
  });

  it("вхід у «Баланс» → GET topups, лишаються pending", async () => {
    const { store, enter, api } = setup(cabinet(), {
      api: { listTopUps: vi.fn(async () => ({ topups: [PENDING_TOPUP, ...TOPUPS] })) },
    });
    enter({ route: "cabinet", section: "balance" });
    await flush();
    expect(api.listTopUps).toHaveBeenCalledTimes(1);
    expect(store.getState().cabinet.pendingTopups.map((x) => x.id)).toEqual(["t_9q4m"]);
  });

  it("інші маршрути й розділи — без запиту; ?mock=1 — без запиту", async () => {
    const a = setup(cabinet());
    a.enter({ route: "cabinet", section: "history" });
    a.enter({ route: "start" });
    a.enter({ route: "checkout", id: "t_1" });
    expect(a.api.listTopUps).not.toHaveBeenCalled();

    const b = setup(cabinet(), { offline: true });
    b.enter({ route: "cabinet", section: "balance" });
    await flush();
    expect(b.api.listTopUps).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
