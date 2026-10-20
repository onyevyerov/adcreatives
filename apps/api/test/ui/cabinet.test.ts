// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
/**
 * B7 · views/cabinet.js (N8-B): ліва колонка (розділи, мета, «← до host», «Адмінка →», e-mail,
 * «Вийти»), завантаження, монтування розділів `cab-*.js`. Розділи B9/B10 тут — моки (після
 * злиття там справжній код): перевіряється лише факт монтування / оновлення / знищення.
 * Наскрізно: справжній index.html + app.js + ядро акаунта на стабі `fetch`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ADMIN_ME, ME, PENDING_TOPUP, PROJECTS } from "../../public/static/dev/fixtures/_base.js";
import type { Actions, UiState } from "../../public/static/js/contracts.js";
import { RETURN_KEY } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

/** Розділи інших блоків — моки з лічильниками. */
const sections = vi.hoisted(() => {
  const make = (name: string) => {
    const update = vi.fn();
    const destroy = vi.fn();
    const mount = vi.fn((el: HTMLElement) => {
      const node = document.createElement("div");
      node.dataset.section = name;
      el.append(node);
      return {
        update,
        destroy: () => {
          destroy();
          node.remove();
        },
      };
    });
    return { mount, update, destroy };
  };
  return { history: make("history"), projects: make("projects"), profile: make("profile") };
});
vi.mock("../../public/static/js/views/cab-history.js", () => ({ mount: sections.history.mount }));
vi.mock("../../public/static/js/views/cab-projects.js", () => ({ mount: sections.projects.mount }));
vi.mock("../../public/static/js/views/cab-profile.js", () => ({ mount: sections.profile.mount }));

const { mainKind, mount, navMeta, SECTIONS } = await import("../../public/static/js/views/cabinet.js");

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

function viewActions() {
  return {
    navigate: vi.fn(),
    logout: vi.fn(async () => {}),
    selectPackage: vi.fn(),
    setCustom: vi.fn(),
    submitTopup: vi.fn(async () => {}),
    continueTopup: vi.fn(),
  };
}

function setup(state: UiState = fixture("cab-balance"), actions = viewActions()) {
  const el = document.createElement("div");
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
  const items = () => [...el.querySelectorAll<HTMLButtonElement>(".cab-nav__item")];
  const section = (id: UiState["cabinet"]["section"]) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, section: id } }));
  return { el, store, view, q, items, section, actions };
}

const NBSP = " ";
const plain = (node: Element | null | undefined) => (node?.textContent ?? "").replaceAll(NBSP, " ");

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`fetch у тесті: ${String(input)}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockClear();
  for (const s of Object.values(sections)) {
    s.mount.mockClear();
    s.update.mockClear();
    s.destroy.mockClear();
  }
});

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("views/cabinet.js · ліва колонка", () => {
  it("розділи в порядку Референсу, активний — aria-current=page, мета праворуч", () => {
    const { items, q } = setup();
    expect(SECTIONS.map((s) => s.id)).toEqual(["balance", "history", "projects", "profile"]);
    const list = items().filter((b) => !b.hidden);
    expect(list.map((b) => b.firstElementChild?.textContent)).toEqual([
      "Баланс і поповнення",
      "Історія",
      "Мої проєкти",
      "Профіль",
    ]);
    expect(list.map((b) => b.querySelector(".cab-nav__meta")?.textContent)).toEqual(["12", "11", "4", ""]);
    expect(list.map((b) => b.getAttribute("aria-current"))).toEqual(["page", null, null, null]);
    expect(q("h2.cab-nav__title").textContent).toBe("Кабінет");
    expect(q(".cab-nav__list").getAttribute("aria-label")).toBe("Розділи кабінету");
    expect(q(".cab-nav__email").textContent).toBe("olena@zerno.example.com");
    expect(q<HTMLButtonElement>(".cab-nav__back").hidden).toBe(true);
  });

  it("клік по розділу → navigate; по активному — нічого", () => {
    const { items, actions } = setup();
    items()[0]?.click();
    expect(actions.navigate).not.toHaveBeenCalled();
    items()[2]?.click();
    expect(actions.navigate).toHaveBeenCalledWith({ route: "cabinet", section: "projects" });
  });

  it("«Вийти» → logout", () => {
    const { q, actions } = setup();
    const out = [...q(".cab-nav__foot").querySelectorAll("button")].find((b) => b.textContent === "Вийти");
    out?.click();
    expect(actions.logout).toHaveBeenCalledTimes(1);
  });

  it("«← до host» лише з проєкту → назад у проєкт", () => {
    const { q, actions } = setup(fixture("cab-from-ws"));
    const back = q<HTMLButtonElement>(".cab-nav__back");
    expect(back.hidden).toBe(false);
    expect(back.textContent).toBe("← до zerno.example.com");
    expect(back.querySelector(".cab-link__mono")?.textContent).toBe("zerno.example.com");
    back.click();
    expect(actions.navigate).toHaveBeenCalledWith({ route: "project", projectId: "p_zerno" });
    expect(setup(fixture("n6-start-return")).q<HTMLButtonElement>(".cab-nav__back").hidden).toBe(true);
  });

  it("«Адмінка →» — лише адміну", () => {
    const user = setup();
    expect(user.items().filter((b) => !b.hidden).length).toBe(4);
    const admin = setup(fixture("cab-admin"));
    const adm = admin.items().at(-1);
    expect(adm?.hidden).toBe(false);
    expect(adm?.firstElementChild?.textContent).toBe("Адмінка");
    expect(adm?.querySelector(".cab-nav__meta")?.textContent).toBe("→");
    adm?.click();
    expect(admin.actions.navigate).toHaveBeenCalledWith({ route: "admin", tab: "users" });
    expect(plain(admin.items()[0]?.querySelector(".cab-nav__meta"))).toBe("500");
    expect(admin.q(".cab-nav__email").textContent).toBe(ADMIN_ME.user.email);
  });

  it("мета: баланс з тисячами, історія — лише завантажена, проєкти — projectCount або рядки", () => {
    const s = fixture("cab-balance");
    expect(navMeta({ ...s, account: { ...s.account, me: { ...ME, balance: 1250 } } }, "balance")).toBe(
      `1${NBSP}250`,
    );
    expect(
      navMeta({ ...s, cabinet: { ...s.cabinet, history: { ...s.cabinet.history, entries: [] } } }, "history"),
    ).toBe("");
    expect(navMeta({ ...s, account: { ...s.account, projectCount: null } }, "projects")).toBe(
      String(PROJECTS.length),
    );
    expect(
      navMeta(
        {
          ...s,
          account: { ...s.account, projectCount: null },
          cabinet: { ...s.cabinet, projects: { ...s.cabinet.projects, rows: null } },
        },
        "projects",
      ),
    ).toBe("");
    expect(navMeta(s, "profile")).toBe("");
  });
});

describe("права колонка", () => {
  it("«Баланс» монтує cab-balance", () => {
    const { q } = setup();
    expect(q(".cab-main .cab-bal h1").textContent).toBe("Баланс і поповнення");
  });

  it("cab-loading: рядок завантаження, розділу немає", () => {
    const { q, el } = setup(fixture("cab-loading"));
    const row = q(".cab-loading");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toBe("Завантажую кабінет…");
    expect(row.querySelector(".spinner")).not.toBeNull();
    expect(el.querySelector(".cab-bal")).toBeNull();
  });

  it("mainKind: me вантажиться → loading; гість → нічого (модалка входу)", () => {
    const s = fixture("cab-balance");
    expect(mainKind(s)).toBe("section");
    expect(mainKind({ ...s, account: { ...s.account, meStatus: "loading" } })).toBe("loading");
    expect(mainKind({ ...s, account: { ...s.account, me: null, meStatus: "anon" } })).toBe("none");
    expect(mainKind({ ...s, cabinet: { ...s.cabinet, loading: true } })).toBe("loading");
  });

  it("зміна розділу: старий знищується, новий монтується, оновлення йдуть у поточний", () => {
    const { section, el, store, q } = setup();
    section("history");
    expect(el.querySelector(".cab-bal")).toBeNull();
    expect(sections.history.mount).toHaveBeenCalledTimes(1);
    expect(sections.history.mount.mock.calls[0]?.[0]).toBe(q(".cab-main__inner"));
    expect(q(".cab-nav__item[aria-current='page']").firstElementChild?.textContent).toBe("Історія");

    store.setState((s) => ({ account: { ...s.account, delta: { credits: 1, key: 1 } } }));
    expect(sections.history.update).toHaveBeenCalled();
    expect(sections.history.mount).toHaveBeenCalledTimes(1);

    section("projects");
    expect(sections.history.destroy).toHaveBeenCalledTimes(1);
    expect(sections.projects.mount).toHaveBeenCalledTimes(1);
    section("profile");
    expect(sections.profile.mount).toHaveBeenCalledTimes(1);
    expect(el.querySelectorAll("[data-section]").length).toBe(1);
    section("balance");
    expect(sections.profile.destroy).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".cab-bal")).not.toBeNull();
  });

  it("помилка розділу не валить каркас", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    sections.projects.mount.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { section, q } = setup();
    section("projects");
    expect(err).toHaveBeenCalled();
    expect(q(".cab-nav")).not.toBeNull();
    err.mockRestore();
  });

  it("loading → розділ: розділ монтується після завантаження", () => {
    const { store, el } = setup(fixture("cab-loading"));
    store.setState((s) => ({ cabinet: { ...s.cabinet, loading: false } }));
    expect(el.querySelector(".cab-loading")).toBeNull();
    expect(el.querySelector(".cab-bal")).not.toBeNull();
  });

  it("destroy прибирає каркас і розділ", () => {
    const { view, el, section } = setup();
    section("history");
    view.destroy();
    expect(sections.history.destroy).toHaveBeenCalledTimes(1);
    expect(el.childNodes.length).toBe(0);
  });
});

// ───────────── Наскрізно: index.html + app.js + ядро на стабі fetch ─────────────

function mountIndexHtml() {
  const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (!body) throw new Error("index.html без <body>");
  document.body.innerHTML = body;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("кабінет у сторінці", () => {
  let app: Awaited<ReturnType<typeof import("../../public/static/js/app.js").boot>> | null = null;

  beforeEach(() => {
    history.replaceState(null, "", "/");
    mountIndexHtml();
  });

  afterEach(() => {
    app?.destroy();
    app = null;
  });

  const until = async (pred: () => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`не дочекались: ${label}`);
  };

  it("/?cabinet=balance: me → незавершене поповнення → «Продовжити оплату» → чек", async () => {
    const calls: string[] = [];
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/auth/me")) return json(200, ME);
      if (url.endsWith("/api/projects")) return json(200, { projects: PROJECTS });
      if (url.endsWith("/api/billing/topups")) return json(200, { topups: [PENDING_TOPUP] });
      return json(404, { error: { code: "not_found", message: "—" } });
    });
    const { boot } = await import("../../public/static/js/app.js");
    app = await boot({ params: new URLSearchParams("cabinet=balance") });
    const a = app;
    await until(() => a.store.getState().cabinet.pendingTopups.length === 1, "GET topups");
    expect(document.getElementById("app")?.dataset.route).toBe("cabinet");
    const main = document.getElementById("cab-main");
    expect(main?.querySelector(".cab-bal__pending-title")?.textContent).toBe(
      "Незавершене поповнення · Кілька роликів",
    );
    expect(calls).toContain("GET /api/billing/topups");
    main?.querySelector<HTMLButtonElement>(".cab-bal__continue")?.click();
    expect(a.store.getState().route).toBe("checkout");
    expect(location.search).toBe("?checkout=t_9q4m");
  });

  it("старт → openTopup({from:'start'}) → «Поповнити на 10 кредитів» → POST topups → чек", async () => {
    const posted: unknown[] = [];
    fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/me")) return json(200, { ...ME, balance: 4 });
      if (url.endsWith("/api/projects")) return json(200, { projects: PROJECTS });
      if (url.endsWith("/api/billing/topups") && init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return json(201, { topup: { ...PENDING_TOPUP, id: "t_new1" }, checkoutUrl: "/?checkout=t_new1" });
      }
      if (url.endsWith("/api/billing/topups")) return json(200, { topups: [] });
      return json(404, { error: { code: "not_found", message: "—" } });
    });
    const { boot } = await import("../../public/static/js/app.js");
    app = await boot({ params: new URLSearchParams("") });
    const a = app;
    await until(() => a.store.getState().account.meStatus === "ready", "me");
    a.actions.openTopup({ from: "start" });
    expect(location.search).toBe("?cabinet=balance");
    expect(JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? "null")).toEqual({ kind: "start" });
    const main = document.getElementById("cab-main");
    const submit = main?.querySelector<HTMLButtonElement>(".cab-tu__submit");
    expect(plain(submit?.firstElementChild?.nextElementSibling)).toBe("Поповнити на 10 кредитів");
    main?.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => a.store.getState().route === "checkout", "чек");
    expect(posted).toEqual([{ packageId: "starter" }]);
    expect(location.search).toBe("?checkout=t_new1");
  });

  it("?mock=1: кабінет без жодного fetch", async () => {
    const { boot } = await import("../../public/static/js/app.js");
    app = await boot({ params: new URLSearchParams("mock=1") });
    const a = app;
    await until(() => a.store.getState().account.meStatus === "ready", "me");
    a.actions.navigate({ route: "cabinet", section: "balance" });
    expect(document.querySelector("#cab-main .cab-bal")).not.toBeNull();
    a.actions.selectPackage("pro");
    await a.actions.submitTopup();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
