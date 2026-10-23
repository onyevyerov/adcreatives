// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ADMIN_ME, accountFixture, ME, meOf, OLENA } from "../../public/static/dev/fixtures/_base.js";
import topbarFixtures, { MENU_OPEN } from "../../public/static/dev/fixtures/topbar.js";
import type { Me, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { initials, menuItems, mount } from "../../public/static/js/views/account-controls.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const NBSP = " ";

/** Стан з акаунтом; `me: null` + `meStatus` — гість / завантаження. */
function state(me: Me | null, patch: Partial<UiState["account"]> = {}): UiState {
  const s = accountFixture({ route: "project" });
  return {
    ...s,
    account: { ...s.account, me, meStatus: me ? "ready" : "anon", projectCount: 4, ...patch },
  };
}

/** Унікальний `key` мітки на тест: показана мітка запам'ятовується на рівні модуля. */
let deltaKey = 1000;
const nextKey = () => ++deltaKey;

describe("views/account-controls.js", () => {
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

  function mountWith(s: UiState, place: "start" | "page" = "page") {
    const store = createStore(s);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions }, { place });
    store.subscribe((next, prev) => view.update(next, prev));
    const calls = (name: string) => actions.calls.filter((c) => c.name === name);
    return { store, actions, view, calls };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const trigger = () => q(".ac-trigger") as HTMLButtonElement;
  const menu = () => q(".ac-menu");
  const items = () => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };

  describe("пілюля", () => {
    it("«12 кредитів | +», aria, кліки → кабінет «Баланс» і openTopup from topbar", () => {
      const { calls, view } = mountWith(state(ME));
      expect(q(".ac")?.classList.contains("ac--page")).toBe(true);
      expect(q(".ac-pill__num")?.textContent).toBe("12");
      expect(q(".ac-pill__word")?.textContent).toBe("кредитів");
      expect(q(".ac-pill__bal")?.getAttribute("aria-label")).toBe("Баланс: 12 кредитів. Відкрити кабінет");
      const plus = q(".ac-pill__plus");
      expect(plus?.getAttribute("aria-label")).toBe("Поповнити баланс");
      expect(plus?.classList.contains("ac-pill__plus--low")).toBe(false);
      expect(q(".ac-pill__label")?.hidden).toBe(true);
      expect(q(".ac-loading")?.hidden).toBe(true);
      q(".ac-pill__bal")?.click();
      expect(calls("navigate")[0]?.args).toEqual([{ route: "cabinet", section: "balance" }]);
      plus?.click();
      expect(calls("openTopup")[0]?.args).toEqual([{ from: "topbar" }]);
      view.destroy();
      expect(host.children.length).toBe(0);
    });

    it.each([
      [5, false, "кредитів"],
      [4, true, "кредити"],
      [1, true, "кредит"],
      [0, true, "кредитів"],
    ])("баланс %i: низький — %s (поріг prices.video × 0.5)", (balance, low, word) => {
      const { view } = mountWith(state(meOf(OLENA, balance)));
      expect(q(".ac-pill__num")?.textContent).toBe(String(balance));
      expect(q(".ac-pill__word")?.textContent).toBe(word);
      expect(q(".ac-pill__plus")?.classList.contains("ac-pill__plus--low")).toBe(low);
      expect(q(".ac-pill__label")?.hidden).toBe(!low);
      expect(q(".ac-pill__label")?.textContent).toBe("Поповнити");
      view.destroy();
    });

    it("1 250 — тисячі через U+00A0", () => {
      const { view } = mountWith(state(meOf(OLENA, 1250)));
      expect(q(".ac-pill__num")?.textContent).toBe(`1${NBSP}250`);
      expect(q(".ac-pill__bal")?.getAttribute("aria-label")).toBe(
        `Баланс: 1${NBSP}250 кредитів. Відкрити кабінет`,
      );
      view.destroy();
    });

    it("баланс оновлюється на місці; поріг низького перемикається", () => {
      const { store, view } = mountWith(state(ME));
      const pill = q(".ac-pill");
      store.setState((s) => ({ account: { ...s.account, me: meOf(OLENA, 3) } }));
      expect(q(".ac-pill")).toBe(pill);
      expect(q(".ac-pill__num")?.textContent).toBe("3");
      expect(q(".ac-pill__plus")?.classList.contains("ac-pill__plus--low")).toBe(true);
      view.destroy();
    });
  });

  describe("завантаження /me і гість", () => {
    it("loading — спінер «баланс…», пілюлі немає, коло «·» без меню", () => {
      const { view } = mountWith(state(null, { meStatus: "loading", projectCount: null }));
      expect(q(".ac")?.hidden).toBe(false);
      expect(q(".ac-loading")?.hidden).toBe(false);
      expect(q(".ac-loading")?.getAttribute("aria-label")).toBe("Баланс завантажується");
      expect(q(".ac-loading .spinner")).not.toBeNull();
      expect(q(".ac-loading")?.textContent).toBe("баланс…");
      expect(q(".ac-pill")?.hidden).toBe(true);
      expect(trigger().textContent).toBe("·");
      expect(trigger().getAttribute("aria-disabled")).toBe("true");
      trigger().click();
      expect(menu()).toBeNull();
      view.destroy();
    });

    it("loading з відомим me — ініціали в колі, але пілюлі й меню немає", () => {
      const { view } = mountWith(state(ME, { meStatus: "loading" }));
      expect(q(".ac-loading")?.hidden).toBe(false);
      expect(q(".ac-pill")?.hidden).toBe(true);
      expect(trigger().textContent).toBe("ОК");
      expect(trigger().getAttribute("aria-disabled")).toBe("true");
      trigger().click();
      expect(menu()).toBeNull();
      view.destroy();
    });

    it("anon (page) — частини сховані, корінь і слот лишаються; me з'явився — пілюля й коло", () => {
      const { store, view } = mountWith(state(null));
      expect(q(".ac")?.hidden).toBe(false);
      expect(q(".ac-slot")).not.toBeNull();
      for (const sel of [".ac-loading", ".ac-pill", ".ac-role", ".ac-trigger"])
        expect(q(sel)?.hidden).toBe(true);
      store.setState((s) => ({ account: { ...s.account, me: ME, meStatus: "ready" } }));
      expect(trigger().hidden).toBe(false);
      expect(q(".ac-pill")?.hidden).toBe(false);
      expect(trigger().textContent).toBe("ОК");
      expect(trigger().hasAttribute("aria-disabled")).toBe(false);
      view.destroy();
    });
  });

  describe("мітка зміни балансу", () => {
    it("«−3» — один раз на новий key; той самий key не повторюється", () => {
      const k = nextKey();
      const { store, view } = mountWith(state(meOf(OLENA, 9), { delta: { credits: -3, key: k } }));
      const d = q(".ac-pill .ac-delta");
      expect(d?.textContent).toBe("−3");
      expect(d?.getAttribute("aria-hidden")).toBe("true");
      // інша зміна акаунта з тим самим key — та сама мітка, без нової
      store.setState((s) => ({ account: { ...s.account, projectCount: 5 } }));
      expect(host.querySelectorAll(".ac-delta").length).toBe(1);
      expect(q(".ac-delta")).toBe(d);
      // анімація скінчилась — мітку прибрано
      d?.dispatchEvent(new Event("animationend"));
      expect(q(".ac-delta")).toBeNull();
      store.setState((s) => ({ account: { ...s.account, projectCount: 6 } }));
      expect(q(".ac-delta")).toBeNull();
      // новий key — нова мітка
      store.setState((s) => ({
        account: { ...s.account, me: meOf(OLENA, 19), delta: { credits: 10, key: nextKey() } },
      }));
      expect(q(".ac-delta")?.textContent).toBe("+10");
      view.destroy();
    });

    it("повторне монтування з тим самим key не програє мітку вдруге", () => {
      const s = state(meOf(OLENA, 9), { delta: { credits: -3, key: nextKey() } });
      const first = mountWith(s);
      expect(q(".ac-delta")).not.toBeNull();
      first.view.destroy();
      const second = mountWith(s);
      expect(q(".ac-delta")).toBeNull();
      second.view.destroy();
    });
  });

  describe("меню", () => {
    it("клік по колу відкриває: шапка, пункти, «Вийти»; aria-expanded; без «Адмінка»/«Статистика»", () => {
      const { view } = mountWith(state(ME));
      expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      trigger().click();
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      expect(trigger().classList.contains("ac-trigger--open")).toBe(true);
      expect(menu()?.getAttribute("role")).toBe("menu");
      expect(q(".ac-menu__name")?.textContent).toBe("Олена Коваль");
      expect(q(".ac-menu__email")?.textContent).toBe("olena@zerno.example.com");
      expect(q(".ac-menu__role")).toBeNull();
      expect(items().map((i) => i.textContent)).toEqual([
        "Кабінет",
        "Мої проєкти4",
        "Історія",
        "Профіль",
        "Вийти",
      ]);
      expect(menu()?.textContent).not.toContain("Статистика");
      // перший пункт — у фокусі; пункти поза Tab-порядком
      expect(document.activeElement).toBe(items()[0]);
      expect(items().every((i) => i.getAttribute("tabindex") === "-1")).toBe(true);
      trigger().click();
      expect(menu()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      view.destroy();
    });

    it("адмін: «адмін» перед колом, «роль · адміністратор», «Адмінка», «Статистика» → вкладка usage", () => {
      const { calls, view } = mountWith(state(ADMIN_ME));
      expect(q(".ac-role")?.hidden).toBe(false);
      expect(q(".ac-role")?.textContent).toBe("адмін");
      expect(trigger().textContent).toBe("А");
      trigger().click();
      expect(q(".ac-menu__role")?.textContent).toBe("роль · адміністратор");
      expect(items().map((i) => i.textContent)).toEqual([
        "Кабінет",
        "Мої проєкти4",
        "Історія",
        "Профіль",
        "Адмінка",
        "Статистика",
        "Вийти",
      ]);
      expect(items()[5]?.tagName).toBe("BUTTON");
      items()[4]?.click();
      expect(calls("navigate")[0]?.args).toEqual([{ route: "admin", tab: "users" }]);
      expect(menu()).toBeNull();
      trigger().click();
      items()[5]?.click();
      expect(calls("navigate")[1]?.args).toEqual([{ route: "admin", tab: "usage" }]);
      view.destroy();
    });

    it("клієнт: «адмін» прихований", () => {
      const { view } = mountWith(state(ME));
      expect(q(".ac-role")?.hidden).toBe(true);
      view.destroy();
    });

    it.each([
      [0, { route: "cabinet", section: "balance" }],
      [1, { route: "cabinet", section: "projects" }],
      [2, { route: "cabinet", section: "history" }],
      [3, { route: "cabinet", section: "profile" }],
    ])("пункт %i → navigate %o, меню закривається, фокус на колі", (i, route) => {
      const { calls, view } = mountWith(state(ME));
      trigger().click();
      items()[i]?.click();
      expect(calls("navigate").map((c) => c.args[0])).toEqual([route]);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger());
      view.destroy();
    });

    it("«Вийти» → logout()", () => {
      const { calls, view } = mountWith(state(ME));
      trigger().click();
      items().at(-1)?.click();
      expect(calls("logout").length).toBe(1);
      expect(menu()).toBeNull();
      view.destroy();
    });

    it("«Мої проєкти» без числа, поки projectCount null; число оновлюється у відкритому меню", () => {
      const { store, view } = mountWith(state(ME, { projectCount: null }));
      trigger().click();
      expect(items()[1]?.textContent).toBe("Мої проєкти");
      items()[2]?.focus();
      store.setState((s) => ({ account: { ...s.account, projectCount: 12 } }));
      expect(items()[1]?.textContent).toBe("Мої проєкти12");
      expect(document.activeElement).toBe(items()[2]);
      view.destroy();
    });

    it("me зник (вихід) при відкритому меню — меню закривається", () => {
      const { store, view } = mountWith(state(ME));
      trigger().click();
      store.setState((s) => ({ account: { ...s.account, me: null, meStatus: "anon" } }));
      expect(menu()).toBeNull();
      expect(q(".ac-pill")?.hidden).toBe(true);
      expect(trigger().hidden).toBe(true);
      view.destroy();
    });

    it("клік поза меню закриває (фокус не забирає); клік усередині — ні", () => {
      const { view } = mountWith(state(ME));
      const outside = document.createElement("button");
      document.body.append(outside);
      trigger().click();
      q(".ac-menu__head")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(menu()).not.toBeNull();
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      expect(menu()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).not.toBe(trigger());
      view.destroy();
    });

    it("destroy з відкритим меню знімає слухача документа", () => {
      const { view } = mountWith(state(ME));
      trigger().click();
      view.destroy();
      expect(() =>
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
      ).not.toThrow();
      expect(host.children.length).toBe(0);
    });
  });

  describe("клавіатура меню", () => {
    it("↓/↑ по колу, Home/End, Esc закриває й повертає фокус на коло", () => {
      const { view } = mountWith(state(ME));
      trigger().focus();
      expect(key(trigger(), "ArrowDown").defaultPrevented).toBe(true);
      expect(menu()).not.toBeNull();
      const list = items();
      expect(document.activeElement).toBe(list[0]);
      key(document.activeElement as Element, "ArrowDown");
      expect(document.activeElement).toBe(list[1]);
      key(document.activeElement as Element, "ArrowUp");
      key(document.activeElement as Element, "ArrowUp");
      expect(document.activeElement).toBe(list.at(-1));
      key(document.activeElement as Element, "ArrowDown");
      expect(document.activeElement).toBe(list[0]);
      key(document.activeElement as Element, "End");
      expect(document.activeElement).toBe(list.at(-1));
      key(document.activeElement as Element, "Home");
      expect(document.activeElement).toBe(list[0]);
      expect(key(document.activeElement as Element, "Escape").defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger());
      view.destroy();
    });

    it("↑ на колі відкриває з фокусом на останньому пункті («Вийти»)", () => {
      const { view } = mountWith(state(ME));
      trigger().focus();
      key(trigger(), "ArrowUp");
      expect(document.activeElement?.textContent).toBe("Вийти");
      view.destroy();
    });

    it("Enter/Space на колі — нативний click кнопки: відкриває й закриває", () => {
      const { view } = mountWith(state(ME));
      expect(trigger().tagName).toBe("BUTTON");
      expect(trigger().getAttribute("type")).toBe("button");
      trigger().click();
      expect(menu()).not.toBeNull();
      // Esc на колі (фокус повернули на нього) теж закриває
      trigger().focus();
      key(trigger(), "Escape");
      expect(menu()).toBeNull();
      view.destroy();
    });

    it("Tab з пункту закриває меню і віддає фокус колу (далі — звичайний Tab)", () => {
      const { view } = mountWith(state(ME));
      trigger().click();
      const e = key(document.activeElement as Element, "Tab");
      expect(e.defaultPrevented).toBe(false);
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger());
      view.destroy();
    });

    it("група «Тема» між списком і «Вийти»: стрілки проходять через неї, вибір не закриває меню", () => {
      const { view } = mountWith(state(ME));
      document.documentElement.setAttribute("data-theme", "light");
      document.documentElement.setAttribute("data-theme-pref", "light");
      trigger().click();
      const m = menu() as HTMLElement;
      const group = m.querySelector(".tm-group");
      expect(group?.previousElementSibling?.classList.contains("ac-menu__list")).toBe(true);
      expect(group?.nextElementSibling?.classList.contains("ac-menu__foot")).toBe(true);
      const radios = [...m.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(radios.map((r) => r.querySelector(".tm-item__label")?.textContent)).toEqual([
        "Світла",
        "Темна",
        "Як у системі",
      ]);
      items().at(-2)?.focus(); // «Профіль» — останній пункт списку
      key(document.activeElement as Element, "ArrowDown");
      expect(document.activeElement).toBe(radios[0]);
      key(document.activeElement as Element, "End");
      key(document.activeElement as Element, "ArrowUp");
      expect(document.activeElement).toBe(radios[2]);
      radios[1]?.click();
      expect(menu()).not.toBeNull();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
      expect(radios[1]?.querySelector(".tm-item__check")?.textContent).toBe("✓");
      expect(trigger().classList.contains("ac-trigger--open")).toBe(true);
      key(document.activeElement as Element, "Escape");
      expect(menu()).toBeNull();
      for (const a of ["data-theme", "data-theme-pref", "data-theme-switching"])
        document.documentElement.removeAttribute(a);
      view.destroy();
    });
  });

  it("place start — компактний корінь .ac--start без слота; гість — корінь схований", () => {
    const { store, view } = mountWith(state(ME), "start");
    expect(q(".ac")?.classList.contains("ac--start")).toBe(true);
    expect(q(".ac-slot")).toBeNull();
    expect(q(".ac-pill")).not.toBeNull();
    expect(trigger()).not.toBeNull();
    store.setState((s) => ({ account: { ...s.account, me: null, meStatus: "anon" } }));
    expect(q(".ac")?.hidden).toBe(true);
    view.destroy();
  });

  it("place page — порядок у DOM: спінер, пілюля, слот, «адмін», коло", () => {
    const { view } = mountWith(state(ADMIN_ME));
    expect([...(q(".ac")?.children ?? [])].map((c) => c.className)).toEqual([
      "ac-loading",
      "ac-pill",
      "ac-slot",
      "ac-role",
      "ac-trigger",
    ]);
    view.destroy();
  });

  it("initials і menuItems", () => {
    expect(initials("Олена Коваль")).toBe("ОК");
    expect(initials("Адміністратор")).toBe("А");
    expect(initials("  іван  петренко-шевчук  ")).toBe("ІП");
    expect(initials("")).toBe("·");
    expect(initials(null)).toBe("·");
    expect(menuItems(false, 4).map((i) => i.label)).toEqual(["Кабінет", "Мої проєкти", "Історія", "Профіль"]);
    expect(menuItems(true, 1250)[1]?.meta).toBe(`1${NBSP}250`);
    expect(menuItems(true, null).at(-1)).toEqual({
      label: "Статистика",
      meta: "",
      route: { route: "admin", tab: "usage" },
    });
  });
});

describe("фікстури N4 (dev/fixtures/topbar.js)", () => {
  it("імена з карти #M і аркуша sheet-n4 — у загальному наборі, на маршруті project", () => {
    const names = Object.keys(topbarFixtures);
    for (const n of ["n4-menu", "n4-admin", "ws-meload", "ws-long"]) expect(names).toContain(n);
    expect(names.filter((n) => n.startsWith("sheet-n4-")).length).toBe(9);
    for (const n of names) {
      expect(fixtureStates[n]).toBe(topbarFixtures[n]);
      expect(topbarFixtures[n]?.route).toBe("project");
    }
    expect(MENU_OPEN).toEqual(["n4-menu", "n4-admin"]);
  });

  it("ws-meload — me ще вантажиться; n4-admin — адмін; ws-long — довгий хост і 1 250", () => {
    expect(topbarFixtures["ws-meload"]?.account.meStatus).toBe("loading");
    expect(topbarFixtures["n4-admin"]?.account.me?.user.isAdmin).toBe(true);
    expect(topbarFixtures["ws-long"]?.site).toBe("kavyarnya-na-podoli-zi-snidankamy-do-obidu.example.com.ua");
    expect(topbarFixtures["ws-long"]?.account.me?.balance).toBe(1250);
    expect(topbarFixtures["sheet-n4-minus3"]?.account.delta).toEqual({ credits: -3, key: 7 });
    expect(topbarFixtures["sheet-n4-plus10"]?.account.delta).toEqual({ credits: 10, key: 8 });
  });
});

describe("CSS N4", () => {
  const css = (name: string) => readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static/css", name), "utf8");

  it("account.css — лише класи .ac-, мітка через ac-delta і --ac-delta", () => {
    const src = css("account.css");
    const rules = src.replace(/\/\*[\s\S]*?\*\//g, "");
    const classes = [...rules.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(c === "ac" || c?.startsWith("ac-")).toBe(true);
    expect(src).toMatch(/animation:\s*ac-delta var\(--ac-delta\)/);
  });

  it("chrome.css — меню від правого краю топбару (top 50, right 16), корінь і слот контролів display: contents", () => {
    const src = css("chrome.css");
    expect(src).toMatch(/\.tb \.ac-menu \{\s*top: 50px;\s*right: 16px;/);
    expect(src).toMatch(/\.tb-acct,\s*\.tb-acct > \.ac,\s*\.tb-acct \.ac-slot \{\s*display: contents;/);
  });
});
