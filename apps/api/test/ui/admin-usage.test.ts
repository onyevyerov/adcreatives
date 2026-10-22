// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ANDRIY, OLENA } from "../../public/static/dev/fixtures/_base.js";
import usageFixtures from "../../public/static/dev/fixtures/admin-usage.js";
import type {
  UiState,
  UsageProjectRow,
  UsageProjectsPage,
  UsageState,
} from "../../public/static/js/contracts.js";
import type { Store } from "../../public/static/js/store.js";
import { createStore } from "../../public/static/js/store.js";
import { mount as mountAdmin } from "../../public/static/js/views/admin.js";
import {
  CREDITS_HINT,
  compact,
  count,
  money,
  mount,
  NO_SITE,
  pageText,
  RANGE_ERROR,
  SYSTEM_LABEL,
  share,
  syncChildren,
} from "../../public/static/js/views/admin-usage.js";

/** B4 · вкладка «Використання»: вигляд на фікстурах, дії з правильними аргументами, стани. */

const MINUS = "−";
const NBSP = " ";

const errors = vi.spyOn(console, "error");
const warns = vi.spyOn(console, "warn");
vi.spyOn(console, "info").mockImplementation(() => {});

const NAMES = [
  "adu-loaded",
  "adu-user-open",
  "adu-project-open",
  "adu-custom-range",
  "adu-range-error",
  "adu-eval",
  "adu-empty",
  "adu-loading",
  "adu-error",
];

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  errors.mockClear();
  warns.mockClear();
});
afterEach(() => {
  host.remove();
  expect(errors).not.toHaveBeenCalled();
  expect(warns).not.toHaveBeenCalled();
});

const fx = (name: string) => {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s as UiState;
};

function mountWith(state: UiState) {
  const store = createStore<UiState>(state);
  const actions = createDevActions(store);
  const view = mount(host, { store, actions });
  store.subscribe((next, prev) => view.update(next, prev));
  return { store, view, calls: actions.calls };
}

/** Поверхневий патч `admin.usage`. */
const patchUsage = (store: Store<UiState>, patch: Partial<UsageState>) =>
  store.setState((s) => ({ admin: { ...s.admin, usage: { ...s.admin.usage, ...patch } } }));

const q = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = host) =>
  root.querySelector<T>(sel);
const all = (sel: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLElement>(sel)];
const visible = (el: Element | null) => !!el && !el.closest("[hidden]");
const texts = (sel: string, root: ParentNode = host) => all(sel, root).map((e) => e.textContent);
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("немає елемента");
  (el as HTMLElement).click();
};
const lastCall = (calls: { name: string; args: unknown[] }[]) => calls.at(-1);

/** Рядки tbody таблиці за її класом-маркером. */
const usersTable = () => q<HTMLTableElement>(".adu-table--users") as HTMLTableElement;
const allTable = () => q<HTMLElement>(".adu-ptable--all") as HTMLElement;
const userTable = () => q<HTMLElement>(".adu-ptable--user") as HTMLElement;
const cardNum = (i: number) => all(".adu-card")[i]?.querySelector(".adu-card__num")?.textContent;
const cardSub = (i: number) => all(".adu-card")[i]?.querySelector(".adu-card__sub")?.textContent;

describe("хелпери форматування", () => {
  it("гроші, цілі, токени, частки, пагінація; null → «—»", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(2.414)).toBe("$2.41");
    expect(money(0)).toBe("$0.00");
    expect(money(-3.2)).toBe(`${MINUS}$3.20`);
    expect(count(null)).toBe("—");
    expect(count(1250)).toBe(`1${NBSP}250`);
    expect(compact(8400)).toBe(`8${NBSP}400`);
    expect(compact(12_340)).toBe(`12,3${NBSP}тис.`);
    expect(compact(245_000)).toBe(`245${NBSP}тис.`);
    expect(compact(1_240_000)).toBe(`1,2${NBSP}млн`);
    expect(compact(3_000_000)).toBe(`3${NBSP}млн`);
    expect(share(1, 4)).toBe(`25${NBSP}%`);
    expect(share(0.001, 10)).toBe(`<1${NBSP}%`);
    expect(share(1, 0)).toBe("—");
    expect(pageText(2, 25, 60)).toBe("26–50 з 60");
    expect(pageText(1, 25, 7)).toBe("1–7 з 7");
  });

  it("syncChildren: вставка й прибирання не переставляють сусідів", () => {
    const parent = document.createElement("div");
    const btn = (t: string) => {
      const el = document.createElement("button");
      el.textContent = t;
      return el;
    };
    const [a, b, c, x] = [btn("a"), btn("b"), btn("c"), btn("x")];
    parent.append(a, b, c);
    document.body.append(parent);
    b.focus();
    syncChildren(parent, [a, b, x, c]);
    expect([...parent.children]).toEqual([a, b, x, c]);
    expect(document.activeElement).toBe(b);
    syncChildren(parent, [a, b, c]);
    expect([...parent.children]).toEqual([a, b, c]);
    expect(document.activeElement).toBe(b);
    syncChildren(parent, [c, a]);
    expect([...parent.children]).toEqual([c, a]);
    parent.remove();
  });
});

describe("dev/fixtures/admin-usage.js", () => {
  it("рівно кадри B4, у fixtureStates, під адміном на admin/usage", () => {
    expect(Object.keys(usageFixtures).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      const s = fx(name);
      expect(s.route, name).toBe("admin");
      expect(s.admin.tab, name).toBe("usage");
      expect(s.account.me?.user.isAdmin, name).toBe(true);
    }
  });

  it("дані узгоджені: підсумок = користувачі + «Система»; Σ рядків = totals сторінки", () => {
    for (const name of ["adu-loaded", "adu-custom-range", "adu-eval", "adu-empty"]) {
      const u = fx(name).admin.usage;
      const s = u.summary;
      if (!s) throw new Error(name);
      const users = u.users.reduce((n, x) => n + x.usd, 0);
      expect(s.totals.usd, name).toBeCloseTo(users + s.system.usd, 5);
      const page = u.all.data as UsageProjectsPage;
      expect(
        page.items.reduce((n, p) => n + p.usd, 0),
        name,
      ).toBeCloseTo(page.totals.usd, 5);
      expect(
        s.byModel.reduce((n, m) => n + m.usd, 0),
        name,
      ).toBeCloseTo(s.totals.usd, 5);
      expect(
        s.byStage.reduce((n, m) => n + m.usd, 0),
        name,
      ).toBeCloseTo(s.totals.usd, 5);
    }
  });

  it("кожна фікстура монтується в адмінку (views/admin.js) без помилок і попереджень", () => {
    for (const name of NAMES) {
      const el = document.createElement("div");
      document.body.append(el);
      const store = createStore<UiState>(fx(name));
      const view = mountAdmin(el, { store, actions: createDevActions(store) });
      const section = el.querySelector<HTMLElement>(".adm-usage");
      expect(section?.hidden, name).toBe(false);
      expect(section?.querySelector(".adu"), name).not.toBeNull();
      view.destroy();
      expect(el.children.length, name).toBe(0);
      el.remove();
    }
  });
});

describe("views/admin-usage.js — кадри", () => {
  it("adu-loaded: фільтр, картки, користувачі з «Системою», усі проєкти, розбивки", () => {
    mountWith(fx("adu-loaded"));
    const u = fx("adu-loaded").admin.usage;
    const s = u.summary;
    if (!s) throw new Error("summary");

    expect(texts(".adu-presets button")).toEqual(["7 днів", "30 днів", "Цей місяць", "Увесь час", "Свій"]);
    expect(texts(".adu-sources button")).toEqual(["Клієнти", "Eval", "Тести", "Усе"]);
    expect(q(".adu-presets [data-preset='30d']")?.getAttribute("aria-pressed")).toBe("true");
    expect(q(".adu-sources [data-source='chat']")?.getAttribute("aria-pressed")).toBe("true");
    expect(q(".adu-utc")?.textContent).toBe("Дати — UTC");
    expect(visible(q(".adu-dates"))).toBe(false);
    expect(visible(q(".adu-range-error"))).toBe(false);
    expect(visible(q(".adu-state--loading"))).toBe(false);
    expect(visible(q(".adu-state--error"))).toBe(false);
    expect(visible(q(".adu-state--empty"))).toBe(false);

    expect(texts(".adu-card__label")).toEqual([
      "Витрати",
      "Проєкти",
      "Зданий ролик, у середньому",
      "Правка, у середньому",
      "Виклики й токени",
      "Списано кредитів",
    ]);
    expect(cardNum(0)).toBe(money(s.totals.usd));
    expect(cardNum(1)).toBe(String(s.totals.projects));
    expect(cardSub(1)).toBe(`здано ${s.totals.delivered}`);
    expect(cardNum(2)).toBe(money(s.totals.avgUsdPerDelivered));
    expect(cardNum(3)).toBe(money(s.totals.avgUsdPerRevision));
    expect(cardNum(5)).toBe("47");
    expect(cardSub(5)).toBe(`маржа ${money(s.totals.marginUsd)}`);
    expect(q(".adu-card__hint")?.textContent).toBe(CREDITS_HINT);

    const userRows = all(".adu-row--user", usersTable());
    expect(userRows.map((r) => r.dataset.id)).toEqual(u.users.map((x) => x.id));
    expect(userRows[0]?.querySelector(".adu-email")?.textContent).toBe(OLENA.email);
    expect(userRows[0]?.querySelector(".adu-projects")?.textContent).toBe("4 / 1");
    expect(userRows[0]?.querySelector(".adu-credits")?.textContent).toBe("37");
    const last = usersTable().tBodies[0]?.lastElementChild;
    expect(last?.classList.contains("adu-row--system")).toBe(true);
    expect(last?.querySelector(".adu-system")?.textContent).toBe(SYSTEM_LABEL);
    expect(last?.querySelector(".adu-usd")?.textContent).toBe(money(s.system.usd));
    expect(last?.querySelector(".adu-expand")).toBeNull();

    // Стрілка — лише в активному стовпці сортування.
    expect(texts("thead th", allTable()).map((t) => t?.replace(/[↑↓]$/, ""))).toEqual([
      "Хост",
      "Власник",
      "Статус",
      "Створено",
      "Виклики",
      "Токени",
      "Правки",
      "$ першої видачі",
      "$ правок",
      "$ разом",
    ]);
    expect(all(".adu-row--project", allTable()).map((r) => r.dataset.id)).toEqual(
      u.all.data?.items.map((p) => p.projectId),
    );
    expect(q(".adu-pager__range", allTable())?.textContent).toBe("1–7 з 7");
    expect(q<HTMLButtonElement>(".adu-pager__prev", allTable())?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(".adu-pager__next", allTable())?.disabled).toBe(true);
    expect(q<HTMLInputElement>(".adu-search__input")?.placeholder).toBe("Пошук за хостом або e-mail");

    const csv = q<HTMLAnchorElement>(".adu-csv");
    expect(csv?.textContent).toBe("CSV ↓");
    expect(csv?.hasAttribute("download")).toBe(true);
    expect(csv?.getAttribute("href")).toBe("/api/admin/usage/projects.csv?from=2026-09-23&to=2026-10-22");

    expect(all(".adu-table--models tbody tr")).toHaveLength(s.byModel.length);
    expect(q(".adu-table--models tbody td")?.textContent).toBe("Anthropic");
    expect(all(".adu-table--stages tbody tr")).toHaveLength(s.byStage.length);
    expect(texts(".adu-table--stages tbody td:first-child")).toContain("Генерація сцен");
    expect(texts(".adu-table--stages tbody td:first-child")).toContain("Звукові ефекти");
    expect(texts(".adu-h2")).toEqual(["Користувачі", "Усі проєкти", "По моделях і API", "По етапах"]);
  });

  it("null у даних → «—»; без сайту → «Без сайту»; без власника", () => {
    mountWith(fx("adu-loaded"));
    const broken = q(".adu-row--project[data-id='p_8f3k2q']", allTable());
    expect(broken?.querySelector(".adu-host")?.textContent).toBe(NO_SITE);
    expect(broken?.querySelector(".adu-status")?.textContent).toBe("—");
    expect(broken?.querySelector(".adu-date")?.textContent).toBe("—");
    expect(broken?.querySelector(".adu-owner")?.textContent).toBe("без власника");
    const kav = q(".adu-row--project[data-id='p_kav']", allTable());
    expect(kav?.querySelector(".adu-host")?.textContent).toBe(NO_SITE);
    expect(kav?.querySelector(".adu-status")?.textContent).toBe("чекаю на погодження текстів");
    expect(kav?.querySelector(".adu-owner")?.textContent).toBe(OLENA.email);
  });

  it("adu-eval: «Eval» обрано, кредити й маржа — «—», у CSV — source=eval", () => {
    mountWith(fx("adu-eval"));
    expect(q(".adu-sources [data-source='eval']")?.getAttribute("aria-pressed")).toBe("true");
    expect(cardNum(5)).toBe("—");
    expect(cardSub(5)).toBe("маржа —");
    for (const r of all(".adu-row--user", usersTable())) {
      expect(r.querySelector(".adu-credits")?.textContent).toBe("—");
      expect(r.querySelector(".adu-margin")?.textContent).toBe("—");
      expect(r.classList.contains("is-idle")).toBe(true);
    }
    expect(q(".adu-csv")?.getAttribute("href")).toBe(
      "/api/admin/usage/projects.csv?from=2026-09-23&to=2026-10-22&source=eval",
    );
  });

  it("adu-user-open: під рядком Олени — її проєкти з пагінацією, без колонки «Власник»", () => {
    mountWith(fx("adu-user-open"));
    const rows = [...(usersTable().tBodies[0]?.children ?? [])] as HTMLElement[];
    const i = rows.findIndex((r) => r.dataset.id === OLENA.id);
    expect(rows[i]?.classList.contains("is-open")).toBe(true);
    expect(rows[i]?.querySelector(".adu-expand")?.getAttribute("aria-expanded")).toBe("true");
    expect(rows[i + 1]?.classList.contains("adu-sub")).toBe(true);
    expect(q(".adu-sub__title")?.textContent).toBe(`Проєкти · ${OLENA.email}`);
    expect(texts("thead th", userTable()).join(" ")).not.toContain("Власник");
    expect(all(".adu-row--project", userTable()).map((r) => r.dataset.id)).toEqual([
      "p_zerno",
      "p_flor",
      "p_shyna",
      "p_kav",
    ]);
    expect(q(".adu-pager__range", userTable())?.textContent).toBe("1–4 з 4");
    const zerno = q(".adu-row--project[data-id='p_zerno']", userTable());
    expect(zerno?.querySelector(".adu-revisions")?.textContent).toBe("1");
    expect(zerno?.querySelector(".adu-revusd")?.textContent).toBe("$0.58");
    expect(zerno?.querySelector(".adu-status")?.textContent).toBe("готово");
    expect(all(".adu-detail")).toHaveLength(0);
  });

  it("adu-project-open: розбивки «По моделях» і «По етапах» під проєктом (в обох таблицях)", () => {
    mountWith(fx("adu-project-open"));
    const details = all(".adu-detail");
    expect(details).toHaveLength(2);
    const d = details[0] as HTMLElement;
    expect(d.previousElementSibling?.getAttribute("data-id")).toBe("p_zerno");
    expect(texts(".adu-mini__title", d)).toEqual(["По моделях", "По етапах"]);
    expect(q(".adu-detail__meta", d)?.textContent).toMatch(
      /^p_zerno · https:\/\/zerno\.example\.com\/ · здано \d\d\.\d\d\.2026 · аудіо 80 с · рендерів 3$/,
    );
    const models = texts(".adu-mini:first-child tbody td:first-child", d);
    expect(models[0]).toBe("Anthropic · claude-opus-5-5");
    expect(models).toContain("Remotion · remotion");
    expect(texts(".adu-mini:last-child tbody td:first-child", d)).toContain("Рендер");
  });

  it("adu-custom-range: поля дат зі значеннями; adu-range-error: помилка й aria-invalid", () => {
    mountWith(fx("adu-custom-range"));
    expect(q(".adu-presets [data-preset='custom']")?.getAttribute("aria-pressed")).toBe("true");
    expect(visible(q(".adu-dates"))).toBe(true);
    const [from, to] = all(".adu-date__input") as HTMLInputElement[];
    expect(from?.value).toBe("2026-10-14");
    expect(to?.value).toBe("2026-10-19");
    expect(visible(q(".adu-range-error"))).toBe(false);
    host.replaceChildren();

    mountWith(fx("adu-range-error"));
    const err = q(".adu-range-error");
    expect(visible(err)).toBe(true);
    expect(err?.textContent).toBe(RANGE_ERROR);
    expect(err?.getAttribute("role")).toBe("alert");
    expect(q(".adu-date__input")?.getAttribute("aria-invalid")).toBe("true");
    expect(visible(q(".adu-content"))).toBe(true);
  });

  it("adu-empty, adu-loading, adu-error: тексти станів", () => {
    mountWith(fx("adu-empty"));
    expect(visible(q(".adu-state--empty"))).toBe(true);
    expect(q(".adu-state--empty")?.textContent).toBe("За цей період витрат немає");
    expect(visible(q(".adu-content"))).toBe(false);
    expect(visible(q(".adu-filter"))).toBe(true);
    host.replaceChildren();

    mountWith(fx("adu-loading"));
    expect(visible(q(".adu-state--loading"))).toBe(true);
    expect(q(".adu-state--loading")?.textContent).toBe("Завантажую…");
    expect(visible(q(".adu-content"))).toBe(false);
    host.replaceChildren();

    const { calls } = mountWith(fx("adu-error"));
    const err = q(".adu-state--error");
    expect(visible(err)).toBe(true);
    expect(q(".adu-state__text", err as HTMLElement)?.textContent).toBe("Не вдалося завантажити");
    expect(visible(q(".adu-state--loading"))).toBe(false);
    const retry = q<HTMLButtonElement>(".adu-retry");
    expect(retry?.textContent).toBe("Повторити");
    click(retry);
    expect(lastCall(calls)).toEqual({ name: "usageReload", args: [] });
  });
});

describe("views/admin-usage.js — дії", () => {
  it("пресети й джерело → usagePreset / usageSource; стан → aria-pressed", () => {
    const { store, calls } = mountWith(fx("adu-loaded"));
    for (const p of ["7d", "30d", "month", "all", "custom"]) {
      click(q(`.adu-presets [data-preset='${p}']`));
      expect(lastCall(calls)).toEqual({ name: "usagePreset", args: [p] });
    }
    for (const s of ["chat", "eval", "test", "all"]) {
      click(q(`.adu-sources [data-source='${s}']`));
      expect(lastCall(calls)).toEqual({ name: "usageSource", args: [s] });
    }
    patchUsage(store, { preset: "7d", source: "test" });
    expect(q(".adu-presets [data-preset='7d']")?.getAttribute("aria-pressed")).toBe("true");
    expect(q(".adu-presets [data-preset='30d']")?.getAttribute("aria-pressed")).toBe("false");
    expect(q(".adu-sources [data-source='test']")?.getAttribute("aria-pressed")).toBe("true");
    expect(visible(q(".adu-dates"))).toBe(false);
  });

  it("«Свій» показує дати; зміна поля → usageRange, порожнє → null", () => {
    const { store, calls } = mountWith(fx("adu-loaded"));
    patchUsage(store, { preset: "custom" });
    expect(visible(q(".adu-dates"))).toBe(true);
    const [from, to] = all(".adu-date__input") as [HTMLInputElement, HTMLInputElement];
    // `range` попереднього пресета — стартові значення полів
    expect(from.value).toBe("2026-09-23");
    to.value = "";
    to.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastCall(calls)).toEqual({ name: "usageRange", args: [{ from: "2026-09-23", to: null }] });
    from.value = "2026-10-01";
    to.value = "2026-10-15";
    from.dispatchEvent(new Event("change", { bubbles: true }));
    expect(lastCall(calls)).toEqual({
      name: "usageRange",
      args: [{ from: "2026-10-01", to: "2026-10-15" }],
    });
    // Помилка періоду без зміни `range` не перезаписує введене.
    patchUsage(store, { rangeError: true });
    expect(from.value).toBe("2026-10-01");
    expect(visible(q(".adu-range-error"))).toBe(true);
  });

  it("сортування користувачів: лише валідні ключі, aria-sort, usageSortUsers(key)", () => {
    const { store, calls } = mountWith(fx("adu-loaded"));
    const ths = all("thead th[data-sort]", usersTable());
    expect(ths.map((t) => t.dataset.sort)).toEqual(["email", "projects", "usd", "marginUsd"]);
    const sortOf = (key: string) =>
      q(`thead th[data-sort='${key}']`, usersTable())?.getAttribute("aria-sort");
    expect(sortOf("usd")).toBe("descending");
    expect(sortOf("email")).toBe("none");
    click(q("thead th[data-sort='email'] button", usersTable()));
    expect(lastCall(calls)).toEqual({ name: "usageSortUsers", args: ["email"] });
    patchUsage(store, { usersSort: { key: "email", order: "asc" } });
    expect(sortOf("email")).toBe("ascending");
    expect(sortOf("usd")).toBe("none");
    click(q("thead th[data-sort='marginUsd'] button", usersTable()));
    expect(lastCall(calls)).toEqual({ name: "usageSortUsers", args: ["marginUsd"] });
  });

  it("клік по рядку користувача → usageToggleUser(id) один раз; «Система» не клікається", () => {
    const { calls } = mountWith(fx("adu-loaded"));
    const row = q(`.adu-row--user[data-id='${ANDRIY.id}']`);
    click(row?.querySelector(".adu-name"));
    expect(lastCall(calls)).toEqual({ name: "usageToggleUser", args: [ANDRIY.id] });
    const before = calls.length;
    click(row?.querySelector(".adu-expand"));
    expect(calls.length).toBe(before + 1);
    click(q(".adu-row--system"));
    expect(calls.length).toBe(before + 1);
  });

  it("розгортання: рядки не перестворюються, фокус лишається на кнопці рядка", () => {
    const { store } = mountWith(fx("adu-loaded"));
    const rowsBefore = all(".adu-row--user", usersTable());
    const btn = q<HTMLButtonElement>(`.adu-row--user[data-id='${OLENA.id}'] .adu-expand`);
    btn?.focus();
    const user = fx("adu-user-open").admin.usage;
    patchUsage(store, { expandedUserId: OLENA.id, userProjects: user.userProjects });
    expect(document.activeElement).toBe(btn);
    expect(all(".adu-row--user", usersTable())).toEqual(rowsBefore);
    expect(visible(q(".adu-sub"))).toBe(true);
    // Нові об'єкти з тими самими id — ті самі вузли.
    patchUsage(store, { users: store.getState().admin.usage.users.map((x) => ({ ...x })) });
    expect(all(".adu-row--user", usersTable())).toEqual(rowsBefore);
    patchUsage(store, { expandedUserId: null });
    expect(q(".adu-sub")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("таблиця проєктів користувача: сортування, рядок, сторінки → usageProjects('user', …)", () => {
    const { store, calls } = mountWith(fx("adu-user-open"));
    const keys = all("thead th[data-sort]", userTable()).map((t) => t.dataset.sort);
    expect(keys).toEqual(["host", "status", "createdAt", "calls", "tokens", "usd"]);
    expect(q("thead th[data-sort='usd']", userTable())?.getAttribute("aria-sort")).toBe("descending");
    click(q("thead th[data-sort='createdAt'] button", userTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["user", { sort: "createdAt" }] });
    click(q(".adu-row--project[data-id='p_flor'] .adu-usd", userTable()));
    expect(lastCall(calls)).toEqual({ name: "usageToggleProject", args: ["p_flor"] });
    // Клік по проєкту всередині розгорнутого користувача не згортає користувача.
    expect(calls.filter((c) => c.name === "usageToggleUser")).toHaveLength(0);

    const u = store.getState().admin.usage;
    const data = u.userProjects.data as UsageProjectsPage;
    patchUsage(store, { userProjects: { ...u.userProjects, data: { ...data, page: 2, pageSize: 2 } } });
    expect(q(".adu-pager__range", userTable())?.textContent).toBe("3–4 з 4");
    expect(q<HTMLButtonElement>(".adu-pager__next", userTable())?.disabled).toBe(true);
    click(q(".adu-pager__prev", userTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["user", { page: 1 }] });
  });

  it("усі проєкти: ключі сортування з «Власником», рядок, пошук із фокусом, пагінація", () => {
    const { store, calls } = mountWith(fx("adu-loaded"));
    const keys = all("thead th[data-sort]", allTable()).map((t) => t.dataset.sort);
    expect(keys).toEqual(["host", "ownerEmail", "status", "createdAt", "calls", "tokens", "usd"]);
    click(q("thead th[data-sort='host'] button", allTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["all", { sort: "host" }] });
    click(q("thead th[data-sort='ownerEmail'] button", allTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["all", { sort: "ownerEmail" }] });
    patchUsage(store, {
      all: { ...store.getState().admin.usage.all, sort: { key: "host", order: "asc" } },
    });
    expect(q("thead th[data-sort='host']", allTable())?.getAttribute("aria-sort")).toBe("ascending");
    expect(q("thead th[data-sort='usd']", allTable())?.getAttribute("aria-sort")).toBe("none");

    click(q(".adu-row--project[data-id='p_zerno']", allTable()));
    expect(lastCall(calls)).toEqual({ name: "usageToggleProject", args: ["p_zerno"] });

    const search = q<HTMLInputElement>(".adu-search__input") as HTMLInputElement;
    search.focus();
    search.value = "zerno";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["all", { q: "zerno" }] });
    // Поки дія чекає debounce, у стані ще старе q — поле під фокусом не перезаписується.
    patchUsage(store, { all: { ...store.getState().admin.usage.all, loading: true } });
    expect(search.value).toBe("zerno");
    expect(document.activeElement).toBe(search);
    expect(allTable().classList.contains("is-busy")).toBe(true);
    patchUsage(store, { all: { ...store.getState().admin.usage.all, q: "zerno", loading: false } });
    expect(q(".adu-csv")?.getAttribute("href")).toBe(
      "/api/admin/usage/projects.csv?from=2026-09-23&to=2026-10-22&search=zerno",
    );

    const page = store.getState().admin.usage.all.data as UsageProjectsPage;
    const items: UsageProjectRow[] = Array.from({ length: 25 }, (_, i) => ({
      ...(page.items[0] as UsageProjectRow),
      projectId: `p_gen${i}`,
    }));
    patchUsage(store, {
      all: { ...store.getState().admin.usage.all, data: { ...page, items, page: 2, total: 60 } },
    });
    expect(all(".adu-row--project", allTable())).toHaveLength(25);
    expect(q(".adu-pager__range", allTable())?.textContent).toBe("26–50 з 60");
    expect(q<HTMLButtonElement>(".adu-pager__prev", allTable())?.disabled).toBe(false);
    expect(q<HTMLButtonElement>(".adu-pager__next", allTable())?.disabled).toBe(false);
    click(q(".adu-pager__prev", allTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["all", { page: 1 }] });
    click(q(".adu-pager__next", allTable()));
    expect(lastCall(calls)).toEqual({ name: "usageProjects", args: ["all", { page: 3 }] });
  });

  it("пошук без результатів, завантаження таблиці користувача, оновлення з даними", () => {
    const { store } = mountWith(fx("adu-loaded"));
    const u = store.getState().admin.usage;
    const page = u.all.data as UsageProjectsPage;
    patchUsage(store, { all: { ...u.all, q: "xyz", data: { ...page, items: [], total: 0 } } });
    expect(q(".adu-note", allTable())?.textContent).toBe("Нічого не знайдено за «xyz».");
    expect(visible(q(".adu-pager", allTable()))).toBe(false);

    patchUsage(store, {
      expandedUserId: OLENA.id,
      userProjects: { ...u.userProjects, loading: true, data: null },
    });
    expect(q(".adu-note", userTable())?.textContent).toBe("Завантажую…");

    // Оновлення з наявними даними: вміст лишається, позначка busy; помилка — рядок над даними.
    patchUsage(store, { loading: true });
    expect(q(".adu")?.classList.contains("adu--busy")).toBe(true);
    expect(visible(q(".adu-content"))).toBe(true);
    expect(visible(q(".adu-state--loading"))).toBe(false);
    expect(q<HTMLButtonElement>(".adu-retry")?.disabled).toBe(true);
    patchUsage(store, { loading: false, error: true });
    expect(visible(q(".adu-state--error"))).toBe(true);
    expect(visible(q(".adu-content"))).toBe(true);
    expect(q<HTMLButtonElement>(".adu-retry")?.disabled).toBe(false);
  });

  it("DOM без HTML-рядків: e-mail з «<b>» лишається текстом; destroy прибирає корінь", () => {
    const s = fx("adu-loaded");
    const users = s.admin.usage.users.map((x, i) => (i === 0 ? { ...x, email: "<b>x</b>@e.com" } : x));
    const { view } = mountWith({ ...s, admin: { ...s.admin, usage: { ...s.admin.usage, users } } });
    expect(q(".adu-email")?.textContent).toBe("<b>x</b>@e.com");
    expect(q(".adu-email b")).toBeNull();
    view.destroy();
    expect(host.children.length).toBe(0);
  });
});
