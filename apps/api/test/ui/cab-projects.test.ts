// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
/**
 * B9 · Мої проєкти (N12-B): картки без постера, статус за C2, формати, «витрачено» і розбивка з
 * `credits.parts` (B4, у тестах — стаб), порожній стан, дії `loadProjects` / `toggleProjectCredits`.
 */
process.env.TZ = "Europe/Kyiv";

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ALL_PROJECTS, accountFixture, PROJECTS } from "../../public/static/dev/fixtures/_base.js";
import projectsFixtures, { MANY } from "../../public/static/dev/fixtures/projects.js";
import type { Actions, PartDeps, ProjectRow, Route, UiState } from "../../public/static/js/contracts.js";
import { cabinetActions } from "../../public/static/js/data/cabinet-actions.js";
import { createStore } from "../../public/static/js/store.js";
import { cardDate, mount, partLabel, statusTone } from "../../public/static/js/views/cab-projects.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const MINUS = "−";
const NBSP = " ";

/** Кабінет Олени на «Моїх проєктах». */
function state(projects: Partial<UiState["cabinet"]["projects"]> = {}): UiState {
  const s = accountFixture({ route: "cabinet" });
  return {
    ...s,
    cabinet: { ...s.cabinet, section: "projects", projects: { ...s.cabinet.projects, ...projects } },
  };
}

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

describe("views/cab-projects.js · чисті функції", () => {
  it("підписи розбивки, тон статусу, дата картки", () => {
    expect(partLabel({ kind: "video", credits: -10 })).toBe("Ролик");
    expect(partLabel({ kind: "format", credits: -2, format: "square" })).toBe("Формат 1:1");
    expect(partLabel({ kind: "revision", credits: -3, rev: 2 })).toBe("Правка · рев. 2");
    expect(partLabel({ kind: "refund", credits: 10 })).toBe("Повернення за збій");
    expect(
      ["rendering", "awaiting_script", "failed", "intake", "delivered"].map((s) => statusTone(s as never)),
    ).toEqual(["busy", "awaiting", "failed", "intake", "done"]);
    expect(cardDate(PROJECTS[0]?.createdAt ?? null)).toBe("19.10");
    expect(cardDate(null)).toBe("");
  });
});

describe("views/cab-projects.js · mount", () => {
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

  /** Дії: dev-заглушки (запис викликів) + справжній toggle з B9. */
  function mountWith(s: UiState) {
    const store = createStore(s);
    const dev = createDevActions(store);
    const own = cabinetActions(store, fakeDeps({}).deps);
    const actions = Object.assign(dev, { toggleProjectCredits: own.toggleProjectCredits });
    const view = mount(host, { store, actions });
    store.subscribe((next, prev) => view.update(next, prev));
    const calls = (name: string) => dev.calls.filter((c) => c.name === name);
    return { store, view, calls };
  }

  const q = (sel: string, root: ParentNode = host) => root.querySelector<HTMLElement>(sel);
  const all = (sel: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLElement>(sel)];
  const card = (id: string) => q(`.cab-proj__card[data-id="${id}"]`) as HTMLElement;

  it("cab-projects: 4 картки — статус, дата, хост, формати, «витрачено»; без постера", () => {
    const { calls, view } = mountWith(projectsFixtures["cab-projects"] as UiState);
    expect(q("h1")?.textContent).toBe("Мої проєкти");
    expect(all(".cab-proj__card")).toHaveLength(4);
    expect(q("img, video")).toBeNull();

    const flor = card("p_flor");
    expect(q(".cab-proj__status", flor)?.textContent).toBe("рендерю");
    expect(q(".cab-proj__status", flor)?.classList.contains("cab-proj__status--busy")).toBe(true);
    expect(q(".cab-proj__date", flor)?.textContent).toBe("19.10");
    expect(q(".cab-proj__host", flor)?.textContent).toBe("florist-kyiv.example.com");
    expect(q(".cab-proj__desc", flor)).toBeNull();
    expect(all(".cab-proj__glyph", flor).map((g) => g.title)).toEqual(["9:16", "16:9"]);
    expect(q(".cab-proj__fmt", flor)?.textContent).toBe("9:16 · 16:9");
    expect(q(".cab-proj__spent", flor)?.textContent).toBe(`витрачено 12${NBSP}кредитів`);

    const kav = card("p_kav");
    expect(q(".cab-proj__host", kav)?.textContent).toBe("Без сайту");
    expect(q(".cab-proj__desc", kav)?.textContent).toBe("за описом");
    expect(q(".cab-proj__status", kav)?.classList.contains("cab-proj__status--awaiting")).toBe(true);

    const shyna = card("p_shyna");
    expect(q(".cab-proj__status", shyna)?.textContent).toBe("помилка");
    expect(q(".cab-proj__status", shyna)?.classList.contains("cab-proj__status--failed")).toBe(true);
    expect(q(".cab-proj__spent", shyna)?.textContent).toBe(`витрачено 0${NBSP}кредитів`);

    expect(q(".cab-proj__spent", card("p_zerno"))?.textContent).toBe(`витрачено 15${NBSP}кредитів`);

    (q(".cab-proj__open", kav) as HTMLButtonElement).click();
    expect(calls("openProject")[0]?.args).toEqual(["p_kav"]);

    view.destroy();
    expect(host.children).toHaveLength(0);
  });

  it("розбивка zerno: Ролик −10 · Формат 1:1 −2 · Правка · рев. 2 −3 · Разом −15; повторний клік — згортає", () => {
    const { store } = mountWith(state());
    const zerno = card("p_zerno");
    const toggle = q(".cab-proj__spent", zerno) as HTMLButtonElement;
    const parts = q(".cab-proj__parts", zerno) as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(parts.id);
    expect(parts.hidden).toBe(true);

    toggle.click();
    expect(store.getState().cabinet.projects.open).toBe("p_zerno");
    expect(card("p_zerno")).toBe(zerno); // картки не перебудовуються — фокус лишається
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(zerno.classList.contains("is-open")).toBe(true);
    expect(parts.hidden).toBe(false);
    expect(all(".cab-proj__part", parts).map((p) => p.textContent)).toEqual([
      `Ролик${MINUS}10`,
      `Формат 1:1${MINUS}2`,
      `Правка · рев. 2${MINUS}3`,
      `Разом${MINUS}15`,
    ]);

    // Інша картка — перша згортається.
    (q(".cab-proj__spent", card("p_flor")) as HTMLButtonElement).click();
    expect(parts.hidden).toBe(true);
    expect(card("p_flor").classList.contains("is-open")).toBe(true);
    (q(".cab-proj__spent", card("p_flor")) as HTMLButtonElement).click();
    expect(store.getState().cabinet.projects.open).toBeNull();
  });

  it("розбивка з поверненням: 10 − 10 = 0", () => {
    mountWith(projectsFixtures["sheet-n12-refund"] as UiState);
    const parts = q(".cab-proj__parts", card("p_shyna")) as HTMLElement;
    expect(parts.hidden).toBe(false);
    expect(all(".cab-proj__part", parts).map((p) => p.textContent)).toEqual([
      `Ролик${MINUS}10`,
      "Повернення за збій+10",
      "Разом0",
    ]);
  });

  it("порожньо — «Проєктів ще немає» + «Новий проєкт →» на старт", () => {
    const { calls } = mountWith(projectsFixtures["sheet-n12-empty"] as UiState);
    const empty = q(".cab-proj__empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(q(".cab-proj__grid")?.hidden).toBe(true);
    expect(q(".cab-proj__empty-title")?.textContent).toBe("Проєктів ще немає");
    expect(q(".cab-proj__empty-text")?.textContent).toBe(
      "Вставте адресу сайту — перший ролик з’явиться тут.",
    );
    const btn = q(".btn--primary", empty) as HTMLButtonElement;
    expect(btn.textContent).toBe("Новий проєкт →");
    btn.click();
    expect(calls("navigate")[0]?.args).toEqual([{ route: "start" }]);
  });

  it("рядки ще не прийшли — ні сітки, ні «порожньо»; прийшли — картки", () => {
    const { store } = mountWith(state({ rows: null }));
    expect(q(".cab-proj__grid")?.hidden).toBe(true);
    expect(q(".cab-proj__empty")?.hidden).toBe(true);
    store.setState((s) => ({
      cabinet: { ...s.cabinet, projects: { ...s.cabinet.projects, rows: PROJECTS } },
    }));
    expect(all(".cab-proj__card")).toHaveLength(4);
  });

  it("безхазяйний проєкт (credits: null) — без «витрачено»", () => {
    const orphan = ALL_PROJECTS.find((p) => p.credits === null) as ProjectRow;
    mountWith(state({ rows: [orphan] }));
    expect(q(".cab-proj__spent")).toBeNull();
    expect(q(".cab-proj__parts")).toBeNull();
    expect(q(".cab-proj__fmt")?.textContent).toBe("9:16 · 1:1 · 16:9");
  });

  it("один проєкт і стрес-тест 12 проєктів", () => {
    mountWith(projectsFixtures["sheet-n12-one"] as UiState);
    expect(all(".cab-proj__card").map((c) => c.dataset.id)).toEqual(["p_zerno"]);
    document.body.textContent = "";
    host = document.createElement("div");
    document.body.append(host);
    mountWith(projectsFixtures["sheet-n12-stress"] as UiState);
    expect(all(".cab-proj__card")).toHaveLength(12);
    expect(MANY.filter((p) => p.site === null)).toHaveLength(2);
    expect(all(".cab-proj__desc")).toHaveLength(2);
  });

  it("підписи форматів, «витрачено» і «за день» — без переносів (CSS)", () => {
    const css = (f: string) => readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static", "css", f), "utf8");
    const rule = (sel: string) =>
      new RegExp(`${sel.replace(/\./g, "\\.")}\\s*\\{[^}]*white-space:\\s*nowrap`);
    expect(css("cab-projects.css")).toMatch(rule(".cab-proj__fmt"));
    expect(css("cab-projects.css")).toMatch(rule(".cab-proj__spent"));
    expect(css("cab-history.css")).toMatch(rule(".cab-hist__day-meta"));
    // Сітка: 250px, < 1200 — 220px.
    expect(css("cab-projects.css")).toMatch(/minmax\(250px, 1fr\)/);
    expect(css("cab-projects.css")).toMatch(/max-width: 1199px[\s\S]*minmax\(220px, 1fr\)/);
  });

  it("тексти сайтів — лише текстом", () => {
    const evil = { ...(PROJECTS[0] as ProjectRow), site: "<b>x</b>.example.com" };
    mountWith(state({ rows: [evil] }));
    expect(q("b.x, .cab-proj__host b")).toBeNull();
  });

  it("усі фікстури проєктів зареєстровані у fixtureStates і монтуються", () => {
    for (const [name, s] of Object.entries(projectsFixtures)) {
      expect(fixtureStates[name]).toBe(s);
      expect(s.route).toBe("cabinet");
      expect(s.cabinet.section).toBe("projects");
      expect(s.account.projectCount).toBe(s.cabinet.projects.rows?.length);
      mountWith(s).view.destroy();
    }
    expect(Object.keys(projectsFixtures)).toEqual([
      "cab-projects",
      "sheet-n12-list",
      "sheet-n12-zerno",
      "sheet-n12-refund",
      "sheet-n12-empty",
      "sheet-n12-one",
      "sheet-n12-no-poster",
      "sheet-n12-stress",
    ]);
  });
});

describe("data/cabinet-actions.js · проєкти", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  const empty = () => {
    const s = state({ rows: null });
    return createStore<UiState>({ ...s, account: { ...s.account, projectCount: null } });
  };

  it("вхід на «Мої проєкти» → GET /api/projects; рядки і account.projectCount", async () => {
    const store = empty();
    const listProjects = vi.fn(async () => ({ projects: PROJECTS.slice(0, 3) }));
    const transactions = vi.fn();
    const { deps, enter } = fakeDeps({ listProjects, transactions });
    cabinetActions(store, deps);
    enter({ route: "cabinet", section: "profile" });
    expect(listProjects).not.toHaveBeenCalled();
    enter({ route: "cabinet", section: "projects" });
    expect(listProjects).toHaveBeenCalledWith();
    expect(store.getState().cabinet.projects.loading).toBe(true);
    await vi.waitFor(() => expect(store.getState().cabinet.projects.loading).toBe(false));
    expect(store.getState().cabinet.projects.rows).toHaveLength(3);
    expect(store.getState().account.projectCount).toBe(3);
    expect(transactions).not.toHaveBeenCalled();
  });

  it("помилка — рядки лишаються, loading знімається", async () => {
    const store = createStore(state());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listProjects = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("x"), { status: 0, code: "network" }));
    await cabinetActions(store, fakeDeps({ listProjects }).deps).loadProjects();
    expect(store.getState().cabinet.projects.rows).toEqual(PROJECTS);
    expect(store.getState().cabinet.projects.loading).toBe(false);
  });

  it("offline — без мережі, проєкти з фікстур", async () => {
    const store = empty();
    const listProjects = vi.fn();
    await cabinetActions(store, fakeDeps({ listProjects }, { offline: true }).deps).loadProjects();
    expect(listProjects).not.toHaveBeenCalled();
    expect(store.getState().cabinet.projects.rows).toEqual(PROJECTS);
    expect(store.getState().account.projectCount).toBe(PROJECTS.length);
  });

  it("toggleProjectCredits: відкрити → закрити; інша картка замінює відкриту", () => {
    const store = createStore(state());
    const a = cabinetActions(store, fakeDeps({}).deps);
    a.toggleProjectCredits("p_zerno");
    expect(store.getState().cabinet.projects.open).toBe("p_zerno");
    a.toggleProjectCredits("p_shyna");
    expect(store.getState().cabinet.projects.open).toBe("p_shyna");
    a.toggleProjectCredits("p_shyna");
    expect(store.getState().cabinet.projects.open).toBeNull();
  });
});
