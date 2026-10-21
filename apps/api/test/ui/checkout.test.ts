// @vitest-environment happy-dom
/**
 * B8 · Тестова оплата (N10-A): view чека за фікстурами, дії `confirmCheckout` / `checkoutAgain` /
 * `checkoutReturn`, завантаження чека через `onRoute`, гість на чеку (ядро + модалка B1).
 *
 * Чужі блоки не потрапляють у тест своїм кодом: контроли акаунта (B3) і part-файли інших блоків —
 * моки, перевіряється лише факт монтування / виклику.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ME, meOf, OLENA, PENDING_TOPUP } from "../../public/static/dev/fixtures/_base.js";
import type {
  AccountApi,
  Actions,
  PartDeps,
  ReturnTo,
  Route,
  TopUp,
  UiState,
} from "../../public/static/js/contracts.js";
import { createAccountActions } from "../../public/static/js/data/account.js";
import { ApiError } from "../../public/static/js/data/api.js";
import { checkoutActions, RETURN_DELAY_MS } from "../../public/static/js/data/checkout-actions.js";
import { checkoutState, initialState, projectState } from "../../public/static/js/initial.js";
import { RETURN_KEY, saveReturn } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";
import {
  ERROR_EYEBROW,
  ERROR_LEAD,
  ERROR_TITLE,
  FOOT_TEXT,
  formatAt,
  LOADING_TEXT,
  mount,
  NOT_FOUND_LEAD,
  NOT_FOUND_TITLE,
} from "../../public/static/js/views/checkout.js";

// ───────────── моки чужих блоків ─────────────

const others = vi.hoisted(() => {
  const accountMount = vi.fn((_el: HTMLElement, _ctx: unknown, _o: unknown) => ({
    update: vi.fn(),
    destroy: vi.fn(),
  }));
  const openAuth = vi.fn();
  /** Part-фабрика без логіки: рівно ключі блоку, кожен — vi.fn. */
  const factory = (name: string, keys: string[], own: Record<string, unknown> = {}) => ({
    [name]: () => ({ ...Object.fromEntries(keys.map((k) => [k, vi.fn(async () => {})])), ...own }),
  });
  return { accountMount, openAuth, factory };
});

vi.mock("../../public/static/js/views/account-controls.js", () => ({ mount: others.accountMount }));
vi.mock("../../public/static/js/data/auth-actions.js", () =>
  others.factory("authActions", ["closeAuth", "setAuthField", "submitAuth", "resendAuthMail", "authGoogle"], {
    openAuth: others.openAuth,
  }),
);
vi.mock("../../public/static/js/data/start-actions.js", () =>
  others.factory("startActions", ["submitStart", "startPending", "dismissFlash"]),
);
vi.mock("../../public/static/js/data/retry-actions.js", () =>
  others.factory("retryActions", ["retryAfterTopup"]),
);
vi.mock("../../public/static/js/data/topup-actions.js", () =>
  others.factory("topupActions", ["openTopup", "selectPackage", "setCustom", "submitTopup", "continueTopup"]),
);
vi.mock("../../public/static/js/data/cabinet-actions.js", () =>
  others.factory("cabinetActions", ["loadHistory", "loadProjects", "toggleProjectCredits", "openProject"]),
);
vi.mock("../../public/static/js/data/profile-actions.js", () =>
  others.factory("profileActions", ["setProfileField", "saveName", "changePassword"]),
);
vi.mock("../../public/static/js/data/admin-actions.js", () =>
  others.factory("adminActions", [
    "adminTab",
    "adminSearch",
    "adminSelect",
    "adminField",
    "adminAdjust",
    "adminCancelConfirm",
    "adminCopy",
  ]),
);

// ───────────── спільне ─────────────

const NBSP = "\u00A0";
const plain = (node: Element | null) => (node?.textContent ?? "").replaceAll(NBSP, " ").trim();
const flush = () => new Promise((r) => setTimeout(r, 0));

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

/** Мережі в тестах немає: будь-який fetch — помилка тесту. */
const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`fetch у тесті: ${String(input)}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockClear();
  others.accountMount.mockClear();
  others.openAuth.mockClear();
});

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────── view ─────────────

function viewActions() {
  return {
    confirmCheckout: vi.fn(async (_o: "paid" | "failed") => {}),
    checkoutAgain: vi.fn(async () => {}),
    checkoutReturn: vi.fn(),
    navigate: vi.fn(),
  };
}

function setup(state: UiState, actions = viewActions()) {
  const el = document.createElement("section");
  document.body.append(el);
  const store = createStore(state);
  const view = mount(el, { store, actions: actions as unknown as Actions });
  let prev = store.getState();
  store.subscribe((next) => {
    view.update(next, prev);
    prev = next;
  });
  const q = <T extends Element = HTMLElement>(sel: string) => {
    const node = el.querySelector<T>(sel);
    if (!node) throw new Error(`немає ${sel}`);
    return node;
  };
  /** Видимі кнопки дій: [текст, disabled]. */
  const buttons = () =>
    [...el.querySelectorAll<HTMLButtonElement>(".co-actions .co-btn")]
      .filter((b) => !b.hidden)
      .map((b) => [plain(b.querySelector(".co-btn__label")), b.disabled] as const);
  const btn = (label: string) => {
    const b = [...el.querySelectorAll<HTMLButtonElement>(".co-btn")].find(
      (x) => !x.hidden && plain(x.querySelector(".co-btn__label")) === label,
    );
    if (!b) throw new Error(`немає кнопки «${label}»`);
    return b;
  };
  const visible = (sel: string) => !q(sel).hidden && !q(sel).closest("[hidden]");
  return { el, store, view, q, buttons, btn, visible, actions };
}

describe("views/checkout.js", () => {
  it("шапка: вордмарк і контроли акаунта (B3) з place start", () => {
    const { q, actions } = setup(fixture("n10-pending"));
    expect(q(".co-head .wordmark").textContent).toBe("AdCreative");
    expect(others.accountMount).toHaveBeenCalledTimes(1);
    const [host, , opts] = others.accountMount.mock.calls[0] ?? [];
    expect(host).toBe(q(".co-head .co-account"));
    expect(opts).toEqual({ place: "start" });
    q(".co-head .wordmark").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(actions.navigate).toHaveBeenCalledWith({ route: "start" });
  });

  it("n10-loading: спінер «Завантажую поповнення…», без суми й дій", () => {
    const { q, visible } = setup(fixture("n10-loading"));
    expect(q(".co-tag").textContent).toBe("Тестова оплата · гроші не списуються");
    expect(visible(".co-loading")).toBe(true);
    expect(q(".co-loading").getAttribute("role")).toBe("status");
    expect(plain(q(".co-loading"))).toBe(LOADING_TEXT);
    expect(visible(".co-sum")).toBe(false);
    expect(visible(".co-actions")).toBe(false);
    expect(visible(".co-foot")).toBe(false);
  });

  it("n10-pending: «До сплати», 25 кредитів, «Оплатити» і «Скасувати», примітка", () => {
    const { q, buttons, visible } = setup(fixture("n10-pending"));
    expect(q(".co-eyebrow").textContent).toBe("До сплати");
    expect(q(".co-num").textContent).toBe("25");
    expect(q(".co-word").textContent).toBe("кредитів");
    expect(q(".co-lead").textContent).toBe(
      "Пакет «Кілька роликів». Кредити зарахую одразу після підтвердження.",
    );
    expect(q(".co-meta").textContent).toBe(
      `поповнення t_9q4m · створено ${formatAt(PENDING_TOPUP.createdAt)}`,
    );
    expect(buttons()).toEqual([
      ["Оплатити", false],
      ["Скасувати", false],
    ]);
    expect(visible(".btn--primary .co-btn__arrow")).toBe(true);
    expect(visible(".co-foot")).toBe(true);
    expect(q(".co-foot").textContent).toBe(FOOT_TEXT);
    expect(visible(".co-loading")).toBe(false);
    expect(visible(".co-title")).toBe(false);
  });

  it("formatAt: місцевий час «ДД.ММ ГГ:ХХ»", () => {
    const d = new Date(2026, 9, 19, 11, 20);
    expect(formatAt(d.toISOString())).toBe("19.10 11:20");
    expect(formatAt(null)).toBe("");
  });

  it("n10-confirming: «Підтверджую…» зі спінером, обидві кнопки disabled, без примітки", () => {
    const { q, buttons, visible } = setup(fixture("n10-confirming"));
    expect(buttons()).toEqual([
      ["Підтверджую…", true],
      ["Скасувати", true],
    ]);
    expect(visible(".btn--primary .co-btn__spinner")).toBe(true);
    expect(visible(".btn--primary .co-btn__arrow")).toBe(false);
    expect(visible(".co-foot")).toBe(false);
    expect(q(".co-eyebrow").textContent).toBe("До сплати");
  });

  it("n10-paid: «Зараховано», +25, баланс 37, «До кабінету →»", () => {
    const { q, buttons, visible, btn, actions } = setup(fixture("n10-paid"));
    expect(q(".co-eyebrow").textContent).toBe("Зараховано");
    expect(q(".co-num").textContent).toBe("+25");
    expect(plain(q(".co-lead"))).toBe("Зараховано 25 кредитів. Баланс: 37.");
    expect(buttons()).toEqual([["До кабінету", false]]);
    expect(visible(".btn--primary .co-btn__arrow")).toBe(true);
    expect(visible(".co-auto")).toBe(false);
    btn("До кабінету").click();
    expect(actions.checkoutReturn).toHaveBeenCalledTimes(1);
  });

  it("n10-paid-start: рядок автоповернення з хостом відкладеного старту, без кнопок", () => {
    const { q, visible } = setup(fixture("n10-paid-start"));
    expect(visible(".co-auto")).toBe(true);
    expect(q(".co-auto").getAttribute("role")).toBe("status");
    expect(plain(q(".co-auto"))).toBe("Повертаю на старт — ролик для zerno.example.com почнеться сам…");
    expect(plain(q(".co-lead"))).toBe("Зараховано 25 кредитів. Баланс: 25.");
    expect(visible(".co-actions")).toBe(false);
  });

  it("paid · старт без відкладеного старту — «Повертаю на старт…»", () => {
    const s = fixture("n10-paid-start");
    const { q } = setup({ ...s, account: { ...s.account, pending: null } });
    expect(plain(q(".co-auto"))).toBe("Повертаю на старт…");
  });

  it("n10-paid-ws: +10 «Старт», баланс 11, «Повернутися до проєкту →»", () => {
    const { q, buttons, btn, actions } = setup(fixture("n10-paid-ws"));
    expect(q(".co-num").textContent).toBe("+10");
    expect(plain(q(".co-lead"))).toBe("Зараховано 10 кредитів. Баланс: 11.");
    expect(buttons()).toEqual([["Повернутися до проєкту", false]]);
    btn("Повернутися до проєкту").click();
    expect(actions.checkoutReturn).toHaveBeenCalledTimes(1);
  });

  it("n10-failed: «0 зараховано», «Спробувати ще раз →» і «До кабінету»", () => {
    const { q, buttons, btn, actions } = setup(fixture("n10-failed"));
    expect(q(".co-eyebrow").textContent).toBe("Оплату скасовано");
    expect(q(".co-num").textContent).toBe("0");
    expect(q(".co-word").textContent).toBe("зараховано");
    expect(q(".co-lead").textContent).toBe(
      "Кредити не зараховано. Можна спробувати ще раз — я створю нове поповнення.",
    );
    expect(buttons()).toEqual([
      ["Спробувати ще раз", false],
      ["До кабінету", false],
    ]);
    btn("Спробувати ще раз").click();
    expect(actions.checkoutAgain).toHaveBeenCalledTimes(1);
    btn("До кабінету").click();
    expect(actions.checkoutReturn).toHaveBeenCalledTimes(1);
  });

  it("failed з проєкту — «До проєкту»", () => {
    const s = fixture("n10-failed");
    const co = s.checkout;
    if (!co) throw new Error("немає чека");
    const returnTo: ReturnTo = {
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: null,
    };
    const { buttons } = setup({ ...s, checkout: { ...co, returnTo } });
    expect(buttons()).toEqual([
      ["Спробувати ще раз", false],
      ["До проєкту", false],
    ]);
  });

  it("n10-revisit: «Уже оплачено · дата», мета повторного відкриття, «До кабінету»", () => {
    const s = fixture("n10-revisit");
    const { q, buttons } = setup(s);
    expect(q(".co-eyebrow").textContent).toBe(`Уже оплачено · ${formatAt(s.checkout?.topup?.paidAt)}`);
    expect(q(".co-meta").textContent).toBe("повторне відкриття — другого зарахування немає · t_9q4m");
    expect(buttons()).toEqual([["До кабінету", false]]);
  });

  it("n10-404: «Поповнення не знайдено» + «До кабінету»", () => {
    const { q, buttons, visible, btn, actions } = setup(fixture("n10-404"));
    expect(q(".co-eyebrow").textContent).toBe("Поповнення · t_zz00");
    expect(q("h1.co-title").textContent).toBe(NOT_FOUND_TITLE);
    expect(visible(".co-title")).toBe(true);
    expect(q(".co-lead").textContent).toBe(NOT_FOUND_LEAD);
    expect(visible(".co-amount")).toBe(false);
    expect(visible(".co-meta")).toBe(false);
    expect(buttons()).toEqual([["До кабінету", false]]);
    btn("До кабінету").click();
    expect(actions.checkoutReturn).toHaveBeenCalledTimes(1);
  });

  it("n10-net: «З'єднання втрачено» з крапкою, role=alert, «Спробувати ще раз» і «До кабінету»", () => {
    const { q, buttons, visible, btn, actions } = setup(fixture("n10-net"));
    expect(q(".co-eyebrow").textContent).toBe(ERROR_EYEBROW);
    expect(visible(".co-eyebrow .dot--danger")).toBe(true);
    expect(q(".co-sum").getAttribute("role")).toBe("alert");
    expect(q("h1.co-title").textContent).toBe(ERROR_TITLE);
    expect(q(".co-lead").textContent).toBe(ERROR_LEAD);
    expect(q(".co-meta").textContent).toBe("поповнення t_9q4m");
    expect(visible(".co-amount")).toBe(false);
    expect(visible(".co-loading")).toBe(false);
    expect(visible(".co-foot")).toBe(false);
    expect(buttons()).toEqual([
      ["Спробувати ще раз", false],
      ["До кабінету", false],
    ]);
    expect(visible(".btn--primary .co-btn__arrow")).toBe(false);
    btn("Спробувати ще раз").click();
    expect(actions.checkoutAgain).toHaveBeenCalledTimes(1);
    btn("До кабінету").click();
    expect(actions.checkoutReturn).toHaveBeenCalledTimes(1);
  });

  it("error → loading → pending: крапка і role=alert зникають", () => {
    const { q, store, visible } = setup(fixture("n10-net"));
    store.setState((s) => ({ checkout: s.checkout && { ...s.checkout, status: "loading" } }));
    expect(visible(".co-loading")).toBe(true);
    expect(visible(".co-sum")).toBe(false);
    store.setState((s) => ({
      checkout: s.checkout && { ...s.checkout, status: "pending", topup: PENDING_TOPUP },
    }));
    expect(q(".co-eyebrow").textContent).toBe("До сплати");
    expect(visible(".co-eyebrow .dot")).toBe(false);
    expect(q(".co-sum").hasAttribute("role")).toBe(false);
    expect(visible(".co-title")).toBe(false);
  });

  it("клік «Оплатити» / «Скасувати» → confirmCheckout(paid / failed); кнопка — той самий вузол", () => {
    const { store, btn, actions, q } = setup(fixture("n10-pending"));
    const pay = btn("Оплатити");
    pay.click();
    expect(actions.confirmCheckout).toHaveBeenLastCalledWith("paid");
    btn("Скасувати").click();
    expect(actions.confirmCheckout).toHaveBeenLastCalledWith("failed");
    store.setState((s) => ({ checkout: s.checkout && { ...s.checkout, status: "confirming" } }));
    expect(q(".btn--primary")).toBe(pay);
    expect(pay.disabled).toBe(true);
  });

  it("своя сума — «Своя сума. …»", () => {
    const s = fixture("n10-pending");
    const co = s.checkout;
    if (!co?.topup) throw new Error("немає чека");
    const { q } = setup({
      ...s,
      checkout: { ...co, topup: { ...co.topup, packageId: "custom", credits: 22 } },
    });
    expect(q(".co-lead").textContent).toBe("Своя сума. Кредити зарахую одразу після підтвердження.");
    expect(q(".co-word").textContent).toBe("кредити");
  });

  it("destroy знімає вузли і контроли акаунта", () => {
    const { el, view } = setup(fixture("n10-pending"));
    const handle = others.accountMount.mock.results[0]?.value;
    view.destroy();
    expect(el.querySelector(".co")).toBeNull();
    expect(handle?.destroy).toHaveBeenCalledTimes(1);
  });

  it("фікстури N10 з карти Референсу є", () => {
    for (const name of [
      "n10-loading",
      "n10-pending",
      "n10-confirming",
      "n10-paid",
      "n10-paid-start",
      "n10-paid-ws",
      "n10-failed",
      "n10-revisit",
      "n10-404",
      "n10-guest",
      "n10-net",
    ]) {
      expect(fixture(name).route).toBe("checkout");
    }
    expect(fixture("n10-guest").auth?.context).toBe("checkout");
    expect(fixture("n10-guest").account.meStatus).toBe("anon");
  });
});

// ───────────── дії ─────────────

const PAID: TopUp = { ...PENDING_TOPUP, status: "paid", paidAt: new Date().toISOString() };

type TopUpApi = Pick<AccountApi, "getTopUp" | "confirmTopUp" | "createTopUp">;

function fakeApi(getTopUp: TopUpApi["getTopUp"] = async () => ({ topup: PENDING_TOPUP })) {
  return {
    getTopUp: vi.fn<TopUpApi["getTopUp"]>(getTopUp),
    confirmTopUp: vi.fn<TopUpApi["confirmTopUp"]>(async (_id, outcome) => ({
      topup: { ...PENDING_TOPUP, status: outcome, paidAt: outcome === "paid" ? PAID.paidAt : null },
      balance: outcome === "paid" ? 37 : 12,
    })),
    createTopUp: vi.fn<TopUpApi["createTopUp"]>(async () => ({
      topup: { ...PENDING_TOPUP, id: "t_new1" },
      checkoutUrl: "/?checkout=t_new1",
    })),
  };
}

/** Стан на маршруті checkout (чек ще вантажиться), Олена з балансом 12. */
function checkoutRoute(id = PENDING_TOPUP.id): UiState {
  const s = initialState("checkout", null);
  return {
    ...s,
    checkout: checkoutState(id),
    account: { ...s.account, me: ME, meStatus: "ready", prices: ME.prices },
  };
}

/**
 * Part-файл B8 з ручними deps: `navigate` поводиться як ядро (вхід у проєкт скидає гілки
 * проєкту, новий чек — свіжий `checkoutState`), `onRoute` — один підписник.
 */
function setupActions(o: { state?: UiState; api?: ReturnType<typeof fakeApi>; offline?: boolean } = {}) {
  const store = createStore(o.state ?? checkoutRoute());
  const api = o.api ?? fakeApi();
  let listener: ((r: Route) => void) | null = null;
  const enter = (r: Route) => listener?.(r);
  const navigate = vi.fn((to: Route) => {
    if (to.route === "project") store.setState({ ...projectState(to.projectId), route: "project" });
    else if (to.route === "checkout")
      store.setState((s) => ({
        route: "checkout",
        checkout: s.checkout?.id === to.id ? s.checkout : checkoutState(to.id),
      }));
    else if (to.route === "start") store.setState({ ...projectState(null), route: "start" });
    else store.setState({ route: to.route });
    enter(to);
  });
  const refreshMe = vi.fn(async () => {
    store.setState((s) => ({ account: { ...s.account, me: meOf(OLENA, 37) } }));
  });
  const startPending = vi.fn(async () => {});
  const all = { navigate, refreshMe, startPending };
  const deps: PartDeps = {
    params: new URLSearchParams(),
    api: api as unknown as AccountApi,
    actions: () => all as unknown as Actions,
    backend: { start: vi.fn(async () => {}), stop: vi.fn() } as unknown as PartDeps["backend"],
    offline: o.offline ?? false,
    onRoute: (fn) => {
      listener = fn;
    },
  };
  const own = checkoutActions(store, deps);
  const co = () => {
    const c = store.getState().checkout;
    if (!c) throw new Error("немає чека");
    return c;
  };
  return { store, api, own, navigate, refreshMe, startPending, enter, co };
}

const notFound = () => new ApiError("Поповнення не знайдено.", 404, "not_found", { error: "not_found" });

describe("data/checkout-actions.js", () => {
  it("рівно ключі B8 з 2.1", () => {
    const { own } = setupActions();
    expect(Object.keys(own).sort()).toEqual(["checkoutAgain", "checkoutReturn", "confirmCheckout"]);
  });

  it("вхід на маршрут: GET topup → pending; returnTo за замовчуванням — кабінет", async () => {
    const { api, enter, co } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    expect(co().status).toBe("loading");
    await flush();
    expect(api.getTopUp).toHaveBeenCalledWith("t_9q4m");
    expect(co()).toMatchObject({ status: "pending", topup: PENDING_TOPUP, revisit: false });
    expect(co().returnTo).toEqual({ kind: "cabinet" });
  });

  it("інші маршрути onRoute ігнорує", async () => {
    const { api, enter } = setupActions();
    enter({ route: "cabinet", section: "balance" });
    await flush();
    expect(api.getTopUp).not.toHaveBeenCalled();
  });

  it("returnTo = takeReturn() при першому відкритті; запис з sessionStorage прибрано", async () => {
    const back: ReturnTo = { kind: "start" };
    saveReturn(back);
    const { enter, co } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    expect(co().returnTo).toEqual(back);
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
    // повторний вхід на той самий чек не губить точку повернення
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    expect(co().returnTo).toEqual(back);
  });

  it("paid / failed з сервера — revisit: true, confirm не викликається", async () => {
    const api = fakeApi(async () => ({ topup: PAID }));
    const { enter, co, own } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    expect(co()).toMatchObject({ status: "paid", revisit: true });
    await own.confirmCheckout("paid");
    expect(api.confirmTopUp).not.toHaveBeenCalled();
    expect(co().status).toBe("paid");
  });

  it("404 → notfound", async () => {
    const api = fakeApi(async () => {
      throw notFound();
    });
    const { enter, co } = setupActions({ api });
    enter({ route: "checkout", id: "t_zz00" });
    await flush();
    expect(co().status).toBe("loading"); // чек іншого id не чіпаємо
    const s2 = setupActions({ api, state: checkoutRoute("t_zz00") });
    s2.enter({ route: "checkout", id: "t_zz00" });
    await flush();
    expect(s2.co()).toMatchObject({ status: "notfound", topup: null });
  });

  it("мережа / 5xx на GET topup → error; checkoutAgain → loading → pending", async () => {
    for (const err of [
      new ApiError("мережа", 0, "network", null),
      new ApiError("Внутрішня помилка.", 500, "internal", { error: "internal" }),
    ]) {
      const api = fakeApi();
      api.getTopUp.mockRejectedValueOnce(err);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      saveReturn({ kind: "start" });
      const { enter, co, own } = setupActions({ api });
      enter({ route: "checkout", id: "t_9q4m" });
      await flush();
      expect(co()).toMatchObject({ status: "error", topup: null, returnTo: { kind: "start" } });
      const again = own.checkoutAgain();
      expect(co().status).toBe("loading");
      await again;
      expect(api.getTopUp).toHaveBeenCalledTimes(2);
      expect(api.createTopUp).not.toHaveBeenCalled();
      // точка повернення, забрана при першому відкритті, лишається
      expect(co()).toMatchObject({ status: "pending", topup: PENDING_TOPUP, returnTo: { kind: "start" } });
      warn.mockRestore();
    }
  });

  it("повторний збій — знову error; збій при вже показаному чеку — чек лишається", async () => {
    const api = fakeApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.getTopUp.mockRejectedValueOnce(new ApiError("мережа", 0, "network", null));
    api.getTopUp.mockRejectedValueOnce(new ApiError("мережа", 0, "network", null));
    const { enter, co, own } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.checkoutAgain();
    expect(co().status).toBe("error");
    await own.checkoutAgain();
    expect(co().status).toBe("pending");
    api.getTopUp.mockRejectedValueOnce(new ApiError("Внутрішня помилка.", 503, "internal", null));
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    expect(co()).toMatchObject({ status: "pending", topup: PENDING_TOPUP });
    warn.mockRestore();
  });

  it("401 на GET topup — лишається loading (ядро відкриває вхід)", async () => {
    const api = fakeApi();
    api.getTopUp.mockRejectedValueOnce(new ApiError("Увійдіть.", 401, "unauthorized", null));
    const { enter, co } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    expect(co().status).toBe("loading");
  });

  it("error з проєкту — «До проєкту» без ui.retry; з кабінету — cabinet/balance", async () => {
    const back: ReturnTo = {
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: { ctx: "cp3", text: null },
    };
    const state = checkoutRoute();
    const s = setupActions({
      state: { ...state, checkout: { ...checkoutState("t_9q4m"), status: "error", returnTo: back } },
    });
    s.own.checkoutReturn();
    expect(s.navigate).toHaveBeenCalledWith({ route: "project", projectId: "p_zerno" });
    expect(s.store.getState().ui.retry).toBeNull();
    const c = setupActions({
      state: { ...state, checkout: { ...checkoutState("t_9q4m"), status: "error" } },
    });
    c.own.checkoutReturn();
    expect(c.navigate).toHaveBeenCalledWith({ route: "cabinet", section: "balance" });
  });

  it("confirmCheckout(paid): confirming → POST confirm → refreshMe → paid", async () => {
    const api = fakeApi();
    let release: () => void = () => {};
    api.confirmTopUp.mockImplementationOnce(
      (_id, outcome) =>
        new Promise((resolve) => {
          release = () =>
            resolve({ topup: { ...PENDING_TOPUP, status: outcome, paidAt: PAID.paidAt }, balance: 37 });
        }),
    );
    const { enter, co, own, refreshMe } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    const done = own.confirmCheckout("paid");
    expect(co().status).toBe("confirming");
    // подвійний клік під час confirming не шле другий запит
    await own.confirmCheckout("paid");
    expect(api.confirmTopUp).toHaveBeenCalledTimes(1);
    expect(api.confirmTopUp).toHaveBeenCalledWith("t_9q4m", "paid");
    release();
    await done;
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(co()).toMatchObject({ status: "paid", revisit: false });
    expect(co().topup?.status).toBe("paid");
  });

  it("confirmCheckout(failed) → failed без refreshMe", async () => {
    const { enter, co, own, api, refreshMe } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("failed");
    expect(api.confirmTopUp).toHaveBeenCalledWith("t_9q4m", "failed");
    expect(refreshMe).not.toHaveBeenCalled();
    expect(co()).toMatchObject({ status: "failed", revisit: false });
  });

  it("збій confirm (мережа) → знову pending", async () => {
    const api = fakeApi();
    api.confirmTopUp.mockRejectedValueOnce(new ApiError("мережа", 0, "network", null));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { enter, co, own } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("paid");
    expect(co().status).toBe("pending");
    warn.mockRestore();
  });

  it("paid зі старту: через 1.4 с navigate(start) + startPending()", async () => {
    vi.useFakeTimers();
    saveReturn({ kind: "start" });
    const { enter, own, navigate, startPending, co } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await vi.advanceTimersByTimeAsync(0);
    await own.confirmCheckout("paid");
    expect(co().status).toBe("paid");
    await vi.advanceTimersByTimeAsync(RETURN_DELAY_MS - 1);
    expect(navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(navigate).toHaveBeenCalledWith({ route: "start" });
    expect(startPending).toHaveBeenCalledTimes(1);
  });

  it("paid зі старту: пішли з чека до 1.4 с — автоповернення не спрацьовує", async () => {
    vi.useFakeTimers();
    saveReturn({ kind: "start" });
    const { enter, own, navigate, startPending, store } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await vi.advanceTimersByTimeAsync(0);
    await own.confirmCheckout("paid");
    store.setState({ route: "cabinet" });
    await vi.advanceTimersByTimeAsync(RETURN_DELAY_MS);
    expect(navigate).not.toHaveBeenCalled();
    expect(startPending).not.toHaveBeenCalled();
  });

  it("paid з проєкту: checkoutReturn → navigate(project), потім ui.retry {ctx, plus, text}", async () => {
    saveReturn({
      kind: "project",
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: { ctx: "rev", text: "Зроби темніше" },
    });
    const { enter, own, navigate, store } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("paid");
    own.checkoutReturn();
    expect(navigate).toHaveBeenCalledWith({ route: "project", projectId: "p_zerno" });
    // navigate скинув гілки проєкту — картка «Повторити» лягла після нього
    expect(store.getState().ui.retry).toEqual({ ctx: "rev", plus: 25, text: "Зроби темніше" });
    expect(store.getState().projectId).toBe("p_zerno");
  });

  it("paid з кабінету / повторне відкриття — «До кабінету» → cabinet/balance", async () => {
    const { enter, own, navigate } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("paid");
    own.checkoutReturn();
    expect(navigate).toHaveBeenCalledWith({ route: "cabinet", section: "balance" });
  });

  it("failed з проєкту — «До проєкту» без ui.retry", async () => {
    saveReturn({ kind: "project", projectId: "p_zerno", host: null, retry: { ctx: "cp3", text: null } });
    const { enter, own, navigate, store } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("failed");
    own.checkoutReturn();
    expect(navigate).toHaveBeenCalledWith({ route: "project", projectId: "p_zerno" });
    expect(store.getState().ui.retry).toBeNull();
  });

  it("checkoutAgain: той самий пакет → новий чек з тією самою точкою повернення", async () => {
    const back: ReturnTo = {
      kind: "project",
      projectId: "p_zerno",
      host: null,
      retry: { ctx: "cp3", text: null },
    };
    saveReturn(back);
    const { enter, own, navigate, api, co } = setupActions();
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.confirmCheckout("failed");
    await own.checkoutAgain();
    expect(api.createTopUp).toHaveBeenCalledWith({ packageId: "standard" });
    expect(navigate).toHaveBeenLastCalledWith({ route: "checkout", id: "t_new1" });
    await flush();
    expect(co()).toMatchObject({ id: "t_new1", status: "pending", revisit: false });
    expect(co().returnTo).toEqual(back);
  });

  it("checkoutAgain зі своєю сумою — {credits}", async () => {
    const custom: TopUp = { ...PENDING_TOPUP, packageId: "custom", credits: 22, status: "failed" };
    const api = fakeApi(async () => ({ topup: custom }));
    const { enter, own } = setupActions({ api });
    enter({ route: "checkout", id: "t_9q4m" });
    await flush();
    await own.checkoutAgain();
    expect(api.createTopUp).toHaveBeenCalledWith({ credits: 22 });
  });

  it("?mock=1 (offline): без мережі — чек, оплата, баланс", async () => {
    const api = fakeApi();
    const { enter, own, co, store } = setupActions({ api, offline: true, state: checkoutRoute("t_mock") });
    enter({ route: "checkout", id: "t_mock" });
    await vi.waitFor(() => expect(co().status).toBe("pending"));
    await own.confirmCheckout("paid");
    expect(co().status).toBe("paid");
    expect(store.getState().account.me?.balance).toBe(12 + PENDING_TOPUP.credits);
    expect(api.getTopUp).not.toHaveBeenCalled();
    expect(api.confirmTopUp).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

// ───────────── ядро + B8: гість на чеку ─────────────

describe("гість на чеку (ядро + B8)", () => {
  it("гість → модалка входу з контекстом checkout; після входу чек вантажиться один раз", async () => {
    const unauthorized = () => new ApiError("Потрібен вхід.", 401, "unauthorized", { error: "unauthorized" });
    let signedIn = false;
    const api = {
      ...fakeApi(),
      me: vi.fn(async () => {
        if (!signedIn) throw unauthorized();
        return ME;
      }),
      packages: vi.fn(async () => ({
        prices: ME.prices,
        packages: ME.packages,
        custom: ME.custom,
        creditsPerUsd: 1,
      })),
      listProjects: vi.fn(async () => ({ projects: [] })),
    };
    const params = new URLSearchParams("checkout=t_9q4m");
    const s = initialState("checkout", null);
    const store = createStore<UiState>({ ...s, checkout: checkoutState("t_9q4m") });
    const actions = createAccountActions(store, {
      params,
      api: api as unknown as AccountApi,
      backend: { start: vi.fn(async () => {}), stop: vi.fn() } as unknown as PartDeps["backend"],
    });
    await actions.meReady;
    await flush();
    expect(store.getState().account.meStatus).toBe("anon");
    expect(others.openAuth).toHaveBeenCalledWith("login", "checkout");
    expect(api.getTopUp).not.toHaveBeenCalled();

    // B1 після входу викликає лише refreshMe(); ядро повторно запускає onRoute.
    signedIn = true;
    await actions.refreshMe();
    await flush();
    expect(api.getTopUp).toHaveBeenCalledTimes(1);
    expect(store.getState().checkout).toMatchObject({ status: "pending", topup: PENDING_TOPUP });
    expect(fetchStub).not.toHaveBeenCalled();
    actions.dispose();
  });
});
