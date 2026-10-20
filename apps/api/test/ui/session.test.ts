// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { boot } from "../../public/static/js/app.js";
import type { UiState, ViewHandle } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { viewFor } from "../../public/static/js/view.js";
import { mountAuthForm } from "../../public/static/js/views/auth.js";
import {
  emptyChatText,
  mount,
  mountForbidden,
  NOT_FOUND_CHAT,
  notFoundEyebrow,
} from "../../public/static/js/views/session.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

/**
 * Форма входу — B1: тест не спирається на її розмітку (ні на заглушку, ні на реалізацію), лише на
 * виклик `mountAuthForm(el, ctx, { layout: "stage" })` і проксі update/destroy.
 */
const form = vi.hoisted(() => ({
  update: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("../../public/static/js/views/auth.js", () => ({
  mount: vi.fn((el: HTMLElement) => {
    const node = document.createElement("div");
    node.dataset.mock = "auth-modal";
    el.append(node);
    return { update: () => {}, destroy: () => node.remove() };
  }),
  mountAuthForm: vi.fn((el: HTMLElement): ViewHandle => {
    const node = document.createElement("form");
    node.dataset.mock = "auth-form";
    el.append(node);
    return {
      update: (s, prev) => form.update(s, prev),
      destroy: () => {
        form.destroy();
        node.remove();
      },
    };
  }),
}));

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

/** Мережі в тестах немає: будь-який запит — гість (401). */
function stubFetch() {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized", message: "Потрібно увійти." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const cleanups: Array<() => void> = [];
beforeEach(() => {
  stubFetch();
});
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Монтує view у порожній `<main id="stage">` з dev-діями (записують виклики). */
function setup(state: UiState, mountFn = mount) {
  const el = document.createElement("main");
  el.id = "stage";
  document.body.append(el);
  const store = createStore(state);
  const actions = createDevActions(store);
  const ctx = { store, actions };
  const view = mountFn(el, ctx);
  const off = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    off();
    view.destroy();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T | null;
  const button = (action: string) =>
    $<HTMLButtonElement>(`button[data-action="${action}"]`) as HTMLButtonElement;
  const navigations = () => actions.calls.filter((c) => c.name === "navigate").map((c) => c.args[0]);
  return { el, store, actions, ctx, view, $, button, navigations };
}

describe("session · фікстури N15", () => {
  it.each(["n15-401", "n15-401-err", "n15-404", "n15-403", "n15-net"])("%s є у fixtureStates", (name) => {
    expect(fixtureStates).toHaveProperty(name);
  });

  it("401: екран сцени session, форма login у контексті session", () => {
    for (const name of ["n15-401", "n15-401-err"]) {
      const s = fixture(name);
      expect(s.route, name).toBe("project");
      expect(viewFor(s), name).toBe("session");
      expect(s.auth, name).toMatchObject({
        view: "login",
        context: "session",
        email: "olena@zerno.example.com",
      });
    }
    expect(fixture("n15-401").auth?.error).toBeNull();
    expect(fixture("n15-401-err").auth).toMatchObject({ error: "invalid_credentials", password: "kava" });
  });

  it("404: екран notfound, порожня стрічка, без хоста", () => {
    const s = fixture("n15-404");
    expect(s.route).toBe("project");
    expect(viewFor(s)).toBe("notfound");
    expect(s.projectId).toBe("p_7Hk2mQ9x");
    expect(s.feed).toEqual([]);
    expect(s.site).toBeNull();
  });

  it("403: маршрут admin, admin.forbidden; мережа: conn lost на ЧП1", () => {
    expect(fixture("n15-403")).toMatchObject({ route: "admin", session: "403", admin: { forbidden: true } });
    expect(fixture("n15-403").account.me?.user.isAdmin).toBe(false);
    expect(fixture("n15-net")).toMatchObject({ route: "project", status: "awaiting_brand", conn: "lost" });
  });
});

describe("session · emptyChatText", () => {
  it("404 → текст порожнього чату, інакше null", () => {
    expect(emptyChatText({ session: "404" })).toBe(NOT_FOUND_CHAT);
    expect(NOT_FOUND_CHAT).toBe("Тут з'явиться діалог, коли ви відкриєте свій проєкт.");
    expect(emptyChatText({ session: "401" })).toBeNull();
    expect(emptyChatText({ session: "403" })).toBeNull();
    expect(emptyChatText({ session: null })).toBeNull();
    expect(emptyChatText(fixture("n15-404"))).toBe(NOT_FOUND_CHAT);
  });
});

describe("session · 401 (форма входу в сцені)", () => {
  it("монтує форму B1 у контейнер сцени: mountAuthForm(el, ctx, { layout: 'stage' })", () => {
    const { el, ctx, $ } = setup(fixture("n15-401"));
    const root = $(".ss-login");
    expect(root).not.toBeNull();
    expect(root?.dataset.view).toBe("session");
    expect(root?.parentElement).toBe(el);
    expect(mountAuthForm).toHaveBeenCalledTimes(1);
    expect(mountAuthForm).toHaveBeenCalledWith(root, ctx, { layout: "stage" });
    expect(root?.querySelector('[data-mock="auth-form"]')).not.toBeNull();
    // Без власних заголовків і кнопок: eyebrow «Сесія завершилась», заголовок і контекст малює B1.
    expect(root?.querySelectorAll("h1, h2, button").length).toBe(0);
  });

  it("401 · помилка — та сама форма (стан auth із помилкою читає B1)", () => {
    const { ctx, $ } = setup(fixture("n15-401-err"));
    expect(mountAuthForm).toHaveBeenCalledWith($(".ss-login"), ctx, { layout: "stage" });
  });

  it("update передає стан формі, destroy знімає форму й контейнер", () => {
    const { el, store, view } = setup(fixture("n15-401"));
    const prev = store.getState();
    store.setState((s) => ({ auth: s.auth && { ...s.auth, password: "kava2026!" } }));
    expect(form.update).toHaveBeenCalledWith(store.getState(), prev);
    cleanups.pop();
    view.destroy();
    expect(form.destroy).toHaveBeenCalledTimes(1);
    expect(el.childNodes.length).toBe(0);
  });
});

describe("session · 404 (Проєкт не знайдено)", () => {
  it("тексти кадру #n15-404, форми входу немає", () => {
    const { $ } = setup(fixture("n15-404"));
    const root = $(".ss-notfound");
    expect(root?.dataset.view).toBe("notfound");
    expect($(".eyebrow")?.textContent).toBe("Проєкт · p_7Hk2mQ9x");
    expect($("h1")?.textContent).toBe("Проєкт не знайдено");
    expect($("h1")?.className).toContain("display-l");
    expect($(".ss-lead")?.textContent).toBe(
      "Перевірте посилання або відкрийте проєкт зі списку. Нові проєкти з'являються там одразу після старту.",
    );
    expect([...(root?.querySelectorAll("button") ?? [])].map((b) => [b.textContent, b.className])).toEqual([
      ["Мої проєкти", "btn btn--primary"],
      ["Новий проєкт", "btn btn--ghost"],
    ]);
    expect(mountAuthForm).not.toHaveBeenCalled();
  });

  it("«Мої проєкти» → кабінет/проєкти, «Новий проєкт» → старт", () => {
    const { button, navigations } = setup(fixture("n15-404"));
    button("projects").click();
    button("new-project").click();
    expect(navigations()).toEqual([{ route: "cabinet", section: "projects" }, { route: "start" }]);
  });

  it("eyebrow без id — «Проєкт»; оновлюється зі станом", () => {
    expect(notFoundEyebrow(null)).toBe("Проєкт");
    const { store, $ } = setup(fixture("n15-404"));
    store.setState({ projectId: "p_other" });
    expect($(".eyebrow")?.textContent).toBe("Проєкт · p_other");
  });

  it("destroy прибирає екран", () => {
    const { el, view } = setup(fixture("n15-404"));
    cleanups.pop();
    view.destroy();
    expect(el.childNodes.length).toBe(0);
  });
});

describe("session · 403 (mountForbidden)", () => {
  it("тексти кадру #n15-403 і дві кнопки", () => {
    const { $ } = setup(fixture("n15-403"), mountForbidden);
    expect($(".ss-forbidden")?.dataset.view).toBe("forbidden");
    expect($(".eyebrow")?.textContent).toBe("403 · Адмінка");
    expect($("h2")?.textContent).toBe("Лише для адміністратора.");
    expect($(".ss-lead")?.textContent).toBe(
      "Цей розділ недоступний для вашого акаунта. Кабінет і проєкти — на місці.",
    );
    expect(
      [...document.querySelectorAll(".ss-forbidden button")].map((b) => [b.textContent, b.className]),
    ).toEqual([
      ["До кабінету", "btn btn--primary"],
      ["Новий проєкт", "btn btn--ghost"],
    ]);
  });

  it("«До кабінету» → кабінет/баланс, «Новий проєкт» → старт; destroy прибирає екран", () => {
    const { el, view, button, navigations } = setup(fixture("n15-403"), mountForbidden);
    button("cabinet").click();
    button("new-project").click();
    expect(navigations()).toEqual([{ route: "cabinet", section: "balance" }, { route: "start" }]);
    cleanups.pop();
    view.destroy();
    expect(el.childNodes.length).toBe(0);
  });
});

/** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
function mountIndexHtml() {
  const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (!body) throw new Error("index.html без <body>");
  document.body.innerHTML = body;
}

describe("session · у сторінці (app.js)", () => {
  it("401 → форма в сцені; після входу (session: null) сцена повертає екран проєкту", async () => {
    mountIndexHtml();
    const app = await boot({
      params: new URLSearchParams(),
      state: fixture("n15-401"),
      actions: createDevActions,
    });
    cleanups.push(() => app.destroy());
    const stage = document.getElementById("stage") as HTMLElement;
    expect(stage.querySelector(".ss-login [data-mock='auth-form']")).not.toBeNull();
    // Відновлення робить B1: session: null, auth: null, backend.start → той самий проєкт на ЧП3.
    app.store.setState({ session: null, auth: null });
    expect(stage.querySelector(".ss-login")).toBeNull();
    expect(form.destroy).toHaveBeenCalledTimes(1);
    expect(app.store.getState()).toMatchObject({
      route: "project",
      projectId: "p1",
      status: "awaiting_storyboard",
    });
  });

  it("401 → 404 перемонтовує екран; 404 показує «Проєкт не знайдено»", async () => {
    mountIndexHtml();
    const app = await boot({
      params: new URLSearchParams(),
      state: fixture("n15-401"),
      actions: createDevActions,
    });
    cleanups.push(() => app.destroy());
    const stage = document.getElementById("stage") as HTMLElement;
    app.store.setState({ session: "404" });
    expect(stage.querySelector(".ss-login")).toBeNull();
    expect(stage.querySelector(".ss-notfound h1")?.textContent).toBe("Проєкт не знайдено");
  });
});
