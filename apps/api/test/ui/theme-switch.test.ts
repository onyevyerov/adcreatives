// @vitest-environment happy-dom
/**
 * B5 · перемикач теми: підпис кола, група «Тема» (menuitemradio, ✓, meta «зараз …»), коло гостя з
 * власним меню і клавіатура за Додатком B.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { THEME_MENU_OPEN } from "../../public/static/dev/fixtures/start.js";
import { THEME_KEY } from "../../public/static/js/lib/theme.js";
import {
  mountThemeButton,
  THEME_LABELS,
  themeMenuGroup,
  themeTriggerLabel,
} from "../../public/static/js/views/theme-switch.js";

const html = () => document.documentElement;
let systemDark = false;

beforeEach(() => {
  systemDark = false;
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("prefers-color-scheme: dark") && systemDark,
    addEventListener() {},
    removeEventListener() {},
  }));
  html().setAttribute("data-theme", "light");
  html().setAttribute("data-theme-pref", "system");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = "";
  localStorage.clear();
  for (const a of ["data-theme", "data-theme-pref", "data-theme-locked", "data-theme-switching"])
    html().removeAttribute(a);
});

const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};
const radios = (root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
];

describe("themeTriggerLabel", () => {
  it("світла / темна / як у системі з поточною", () => {
    const base = { theme: "light", locked: false, systemDark: false } as const;
    expect(themeTriggerLabel({ ...base, pref: "light" })).toBe("Тема: світла");
    expect(themeTriggerLabel({ ...base, pref: "dark", theme: "dark" })).toBe("Тема: темна");
    expect(themeTriggerLabel({ ...base, pref: "system", theme: "dark", systemDark: true })).toBe(
      "Тема: як у системі, зараз темна",
    );
    expect(themeTriggerLabel({ ...base, pref: "system" })).toBe("Тема: як у системі, зараз світла");
    expect(THEME_LABELS).toEqual({ light: "Світла", dark: "Темна", system: "Як у системі" });
  });
});

describe("themeMenuGroup", () => {
  it("розмітка: group «Тема», три menuitemradio з tabindex −1, гліфи й ✓ обраного", () => {
    systemDark = true;
    const g = themeMenuGroup();
    document.body.append(g.el);
    expect(g.el.classList.contains("tm-group")).toBe(true);
    expect(g.el.getAttribute("role")).toBe("group");
    expect(g.el.getAttribute("aria-label")).toBe("Тема");
    expect(g.el.querySelector(".tm-label")?.getAttribute("aria-hidden")).toBe("true");
    expect(g.items).toEqual(radios(g.el));
    expect(g.items.map((i) => i.querySelector(".tm-item__label")?.textContent)).toEqual([
      "Світла",
      "Темна",
      "Як у системі",
    ]);
    expect(g.items.map((i) => i.querySelector(".tm-glyph")?.getAttribute("data-mode"))).toEqual([
      "light",
      "dark",
      "system",
    ]);
    expect(g.items.every((i) => i.getAttribute("tabindex") === "-1")).toBe(true);
    expect(g.items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(g.items.map((i) => i.querySelector(".tm-item__check")?.textContent)).toEqual(["", "", "✓"]);
    expect(g.items[2]?.querySelector(".tm-item__meta")?.textContent).toBe("зараз темна");
    expect(g.items[0]?.querySelector(".tm-item__meta")).toBeNull();
    g.destroy();
  });

  it("клік — setThemePref: тема, сховище, ✓ оновлюються; після destroy — без підписки", () => {
    const g = themeMenuGroup();
    document.body.append(g.el);
    g.items[1]?.click();
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(g.items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    g.destroy();
    g.items[0]?.click();
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(g.items[1]?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("mountThemeButton (коло гостя)", () => {
  function setup() {
    const host = document.createElement("span");
    document.body.append(host);
    const view = mountThemeButton(host);
    const trigger = host.querySelector(".tm-trigger") as HTMLButtonElement;
    const menu = () => host.querySelector<HTMLElement>(".tm-menu");
    return { host, view, trigger, menu };
  }

  it("коло: aria-haspopup, підпис і гліф режиму стежать за темою", () => {
    const { trigger, view } = setup();
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Тема: як у системі, зараз світла");
    const glyph = trigger.querySelector(".tm-glyph");
    expect(glyph?.getAttribute("data-mode")).toBe("system");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    trigger.click();
    radios()[1]?.click();
    expect(glyph?.getAttribute("data-mode")).toBe("dark");
    expect(trigger.getAttribute("aria-label")).toBe("Тема: темна");
    view.destroy();
  });

  it("click (Enter/Space) відкриває з фокусом на обраному; пункт не закриває меню", () => {
    html().setAttribute("data-theme-pref", "dark");
    const { trigger, menu, view } = setup();
    trigger.click();
    expect(menu()?.getAttribute("role")).toBe("menu");
    expect(menu()?.getAttribute("aria-label")).toBe("Тема");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(radios()[1]);
    radios()[0]?.click();
    expect(menu()).not.toBeNull();
    expect(radios()[0]?.getAttribute("aria-checked")).toBe("true");
    trigger.click();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    view.destroy();
  });

  it("↓ відкриває на обраному, ↑ — на останньому; ↑/↓/Home/End по колу; Esc повертає фокус", () => {
    const { trigger, menu, view } = setup();
    trigger.focus();
    expect(key(trigger, "ArrowDown").defaultPrevented).toBe(true);
    const list = radios();
    expect(document.activeElement).toBe(list[2]);
    key(document.activeElement as Element, "ArrowDown");
    expect(document.activeElement).toBe(list[0]);
    key(document.activeElement as Element, "ArrowUp");
    expect(document.activeElement).toBe(list[2]);
    key(document.activeElement as Element, "Home");
    expect(document.activeElement).toBe(list[0]);
    key(document.activeElement as Element, "End");
    expect(document.activeElement).toBe(list[2]);
    expect(key(document.activeElement as Element, "Escape").defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    html().setAttribute("data-theme-pref", "light");
    key(trigger, "ArrowUp");
    expect(document.activeElement).toBe(radios()[2]);
    key(trigger, "Escape");
    expect(menu()).toBeNull();
    view.destroy();
  });

  it("Tab закриває меню й віддає фокус колу; клік поза меню — закриває", () => {
    const { trigger, menu, view } = setup();
    trigger.click();
    const e = key(document.activeElement as Element, "Tab");
    expect(e.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    menu()?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu()).not.toBeNull();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    view.destroy();
  });

  it("destroy з відкритим меню прибирає розмітку і слухачів", () => {
    const { host, trigger, view } = setup();
    trigger.click();
    view.destroy();
    expect(host.children.length).toBe(0);
    expect(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))).not.toThrow();
  });
});

describe("фікстура n3-guest-theme", () => {
  it("гість на старті, меню відкривається з модуля фікстур", () => {
    expect(THEME_MENU_OPEN).toEqual(["n3-guest-theme"]);
    const s = fixtureStates["n3-guest-theme"];
    expect(s?.route).toBe("start");
    expect(s?.account.meStatus).toBe("anon");
  });
});
