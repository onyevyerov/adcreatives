// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates, LEGACY_FIXTURES } from "../../public/static/dev/fixture-states.js";
import { ADMIN_ME, accountFixture, ME } from "../../public/static/dev/fixtures/_base.js";
import { boot } from "../../public/static/js/app.js";
import { type Me, STATUS_LABELS, STATUSES, type UiState } from "../../public/static/js/contracts.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";
import { formatUsd, hostSlot, mount, statusKind } from "../../public/static/js/views/topbar.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

/** Старий стан проєкту (без акаунта) + акаунт: клієнт Олена (12) або адмін. */
function withMe(name: string, me: Me = ME): UiState {
  const s = fixture(name);
  return { ...s, account: { ...s.account, me, meStatus: "ready", projectCount: 4 } };
}

/** Мережі в тестах немає: `/api/auth/me` → 401 (гість), решта — 404. */
function stubFetch() {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const me = url.includes("/api/auth/me");
    const body = me
      ? { error: "unauthorized", message: "Потрібно увійти." }
      : { error: "not_found", message: "Не знайдено." };
    return new Response(JSON.stringify(body), {
      status: me ? 401 : 404,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Видимий текст (без вузлів під `[hidden]`). */
function visibleText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node instanceof Element && node.hasAttribute("hidden")) return;
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return parts.join(" ");
}

describe("views/topbar.js", () => {
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

  function mountWith(state: UiState) {
    const store = createStore(state);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);

  it("хост, вордмарк, «Новий проєкт», «Статистика» (адмін)", () => {
    const { view } = mountWith(withMe("awaitingBrand", ADMIN_ME));
    expect(q(".tb-wordmark")?.textContent).toBe("Crealab");
    expect(q(".tb-host")?.textContent).toBe("zerno.example.com");
    expect(q(".tb-host")?.getAttribute("title")).toBe("zerno.example.com");
    expect(q(".tb-host")?.classList.contains("mono")).toBe(true);
    expect(q(".tb-sep")?.textContent).toBe("/");
    const btn = q("button.tb-new");
    expect(btn?.textContent).toBe("Новий проєкт");
    expect(btn?.classList.contains("btn--ghost")).toBe(true);
    const stats = q("a.tb-stats");
    expect(stats?.textContent).toBe("Статистика");
    expect(stats?.getAttribute("href")).toBe("/stats");
    expect(stats?.getAttribute("target")).toBeNull();
    expect(stats?.hidden).toBe(false);
    expect(q(".tb-cost")?.hidden).toBe(false);
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("«Статистика» → вкладка «Використання» роутером; з модифікатором — як звичайне посилання", () => {
    const { actions, view } = mountWith(withMe("awaitingBrand", ADMIN_ME));
    const navigate = vi.spyOn(actions, "navigate");
    const stats = q("a.tb-stats");
    const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    stats?.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    stats?.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ route: "admin", tab: "usage" });
    view.destroy();
  });

  it("клієнт не бачить «Витрачено $» і «Статистика»; адмін — бачить", () => {
    const { store, view } = mountWith(withMe("awaitingBrand"));
    expect(q(".tb-cost")?.hidden).toBe(true);
    expect(q("a.tb-stats")?.hidden).toBe(true);
    expect(visibleText(host)).not.toContain("$");
    expect(visibleText(host)).not.toContain("Статистика");
    // завантаження /me — так само
    store.setState((s) => ({ account: { ...s.account, me: null, meStatus: "loading" } }));
    expect(q(".tb-cost")?.hidden).toBe(true);
    expect(q("a.tb-stats")?.hidden).toBe(true);
    // адмін — з'явились
    store.setState((s) => ({ account: { ...s.account, me: ADMIN_ME, meStatus: "ready" } }));
    expect(q(".tb-cost")?.hidden).toBe(false);
    expect(q("a.tb-stats")?.hidden).toBe(false);
    expect(visibleText(host)).toContain("$");
    view.destroy();
  });

  it("контроли акаунта всередині топбару (place page); destroy прибирає", () => {
    const { store, view } = mountWith(withMe("awaitingBrand"));
    expect(q(".tb-right .tb-acct .ac.ac--page")).not.toBeNull();
    expect(q(".ac-pill__num")?.textContent).toBe("12");
    expect(q(".ac-pill__word")?.textContent).toBe("кредитів");
    expect(q(".ac-trigger")?.textContent).toBe("ОК");
    store.setState((s) => ({ account: { ...s.account, me: { ...ME, balance: 9 } } }));
    expect(q(".ac-pill__num")?.textContent).toBe("9");
    view.destroy();
    expect(host.querySelector(".ac")).toBeNull();
  });

  it("порядок Tab = видимий: пілюля → «Новий проєкт» → «Статистика» → коло", () => {
    const { view } = mountWith(withMe("awaitingBrand", ADMIN_ME));
    const focusable = [...host.querySelectorAll<HTMLElement>(".tb-right a, .tb-right button")].map((n) =>
      n.className.split(" ").find((c) => c.startsWith("tb-") || c.startsWith("ac-")),
    );
    expect(focusable).toEqual(["ac-pill__bal", "ac-pill__plus", "tb-new", "tb-stats", "ac-trigger"]);
    view.destroy();
  });

  it("хост-слот: project — хост, cabinet — «Кабінет», admin — «Адмінка»; статус лише на project", () => {
    const { store, view } = mountWith(withMe("awaitingBrand"));
    expect(q(".tb-status")?.hidden).toBe(false);
    store.setState({ route: "cabinet" });
    expect(q(".tb-host")?.textContent).toBe("Кабінет");
    expect(q(".tb-host")?.hidden).toBe(false);
    expect(q(".tb-host")?.hasAttribute("title")).toBe(false);
    expect(q(".tb-sep")?.hidden).toBe(false);
    expect(q(".tb-status")?.hidden).toBe(true);
    store.setState({ route: "admin" });
    expect(q(".tb-host")?.textContent).toBe("Адмінка");
    expect(q(".tb-status")?.hidden).toBe(true);
    store.setState({ route: "project" });
    expect(q(".tb-host")?.textContent).toBe("zerno.example.com");
    expect(q(".tb-status")?.hidden).toBe(false);
    expect(hostSlot({ ...fixture("awaitingBrand"), route: "start" })).toBe("");
    view.destroy();
  });

  it("без хоста ховає «/» і хост", () => {
    const { store, view } = mountWith({ ...fixture("crawling"), site: null });
    expect(q(".tb-host")?.hidden).toBe(true);
    expect(q(".tb-sep")?.hidden).toBe(true);
    store.setState({ site: "a.example.com" });
    expect(q(".tb-host")?.hidden).toBe(false);
    expect(q(".tb-host")?.textContent).toBe("a.example.com");
    view.destroy();
  });

  it.each([...STATUSES])("статус %s — підпис зі STATUS_LABELS", (status) => {
    const { view } = mountWith({ ...fixture("crawling"), status });
    expect(q(".tb-status__label")?.textContent).toBe(STATUS_LABELS[status]);
    expect(q(".tb-status")?.dataset.status).toBe(status);
    view.destroy();
  });

  it("крапка статусу за C2", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const dot = () => q(".tb-status .dot");
    expect(q(".tb-status")?.classList.contains("tb-status--busy")).toBe(true);
    expect(dot()?.className).toBe("dot dot--accent dot--pulse");
    store.setState({ status: "awaiting_brand" });
    expect(dot()?.className).toBe("dot dot--accent");
    store.setState({ status: "delivered" });
    expect(dot()?.className).toBe("dot");
    store.setState({ status: "failed" });
    expect(dot()?.className).toBe("dot dot--danger");
    expect(q(".tb-status")?.classList.contains("tb-status--failed")).toBe(true);
    expect(statusKind("intake")).toBe("idle");
    expect(statusKind("revising")).toBe("busy");
    view.destroy();
  });

  it("витрати (адмін) — «Витрачено $X.XX», оновлюються на місці", () => {
    const { store, view } = mountWith({ ...withMe("crawling", ADMIN_ME), totalUsd: 0 });
    const cost = q(".tb-cost");
    expect(cost?.textContent).toBe("Витрачено $0.00");
    store.setState({ totalUsd: 2.305 });
    expect(q(".tb-cost")).toBe(cost);
    expect(q(".tb-cost__sum")?.textContent).toBe("$2.31");
    store.setState({ totalUsd: 12 });
    expect(cost?.textContent).toBe("Витрачено $12.00");
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    view.destroy();
  });

  it("клік на вордмарк і «Новий проєкт» → newProject", () => {
    const { actions, view } = mountWith(fixture("awaitingBrand"));
    const newProjectCalls = () => actions.calls.filter((c) => c.name === "newProject").length;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    q(".tb-wordmark")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(newProjectCalls()).toBe(1);
    q("button.tb-new")?.click();
    expect(newProjectCalls()).toBe(2);
    // клік з модифікатором — звичайне посилання (нова вкладка), без newProject
    q(".tb-wordmark")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(newProjectCalls()).toBe(2);
    view.destroy();
  });

  it("update не перестворює DOM", () => {
    const { store, view } = mountWith(withMe("crawling"));
    const root = host.firstElementChild;
    const btn = q("button.tb-new");
    const pill = q(".ac-pill");
    store.setState({ ...withMe("delivered") });
    expect(host.firstElementChild).toBe(root);
    expect(q("button.tb-new")).toBe(btn);
    expect(q(".ac-pill")).toBe(pill);
    expect(q(".tb-status__label")?.textContent).toBe("готово");
    view.destroy();
  });
});

describe("app.js з топбаром і таймлайном", () => {
  const errors = vi.spyOn(console, "error");
  beforeEach(() => {
    stubFetch();
  });
  afterEach(() => {
    errors.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.textContent = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  /** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
  function mountIndexHtml() {
    const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
    if (!body) throw new Error("index.html без <body>");
    document.body.innerHTML = body;
  }

  it("старі стани проєкту — у наборі фікстур робочого простору", () => {
    for (const name of LEGACY_FIXTURES.filter((n) => n !== "start"))
      expect(fixtureStates[name]?.route).toBe("project");
  });

  // Фікстури робочого простору: старі стани й фікстури блоків на маршруті project.
  it.each(Object.keys(fixtureStates).filter((n) => fixtureStates[n]?.route === "project"))(
    "фікстура %s: монтується без помилок і прибирається",
    async (name) => {
      vi.useFakeTimers();
      mountIndexHtml();
      const app = await boot({ params: new URLSearchParams(), state: fixture(name) });
      expect(document.querySelector("#topbar .tb")).not.toBeNull();
      expect(document.querySelector("#timeline .tl")).not.toBeNull();
      expect(document.querySelector("#topbar .tb-status__label")?.textContent).toBe(
        STATUS_LABELS[fixture(name).status],
      );
      app.destroy();
      expect(document.querySelector(".tb, .tl, .ac")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["cabinet", "cab-topbar", "Кабінет"],
    ["admin", "admin-topbar", "Адмінка"],
  ] as const)("маршрут %s: топбар у #%s з хост-слотом «%s», без статусу", async (route, id, label) => {
    mountIndexHtml();
    const state = accountFixture({ route }, initialState("start", null));
    const app = await boot({ params: new URLSearchParams(), state, actions: createDevActions });
    const tb = document.querySelector(`#${id} .tb`);
    expect(tb).not.toBeNull();
    expect(tb?.querySelector(".tb-host")?.textContent).toBe(label);
    expect(tb?.querySelector<HTMLElement>(".tb-status")?.hidden).toBe(true);
    expect(tb?.querySelector(".ac-pill__num")?.textContent).toBe("12");
    app.destroy();
    expect(document.querySelector(".tb")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it("«Новий проєкт» у топбарі повертає на старт (справжні дії, /me → 401)", async () => {
    mountIndexHtml();
    const fetch = stubFetch();
    const app = await boot({ params: new URLSearchParams(), state: fixture("awaitingBrand") });
    await vi.waitFor(() => expect(app.store.getState().account.meStatus).toBe("anon"));
    expect(fetch).toHaveBeenCalled();
    // гість: пілюлі й кола немає, «Новий проєкт» лишається
    expect(document.querySelector("#topbar .ac-pill")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#topbar .ac-trigger")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#topbar .tb-new")?.closest("[hidden]")).toBeNull();
    document.querySelector<HTMLButtonElement>("#topbar .tb-new")?.click();
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    expect(document.querySelector(".tb, .tl")).toBeNull();
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });
});
