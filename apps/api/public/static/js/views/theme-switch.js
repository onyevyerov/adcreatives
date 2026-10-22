// @ts-check
/**
 * B5 · Перемикач теми (SW): «Світла · Темна · Як у системі».
 *
 * - `mountThemeButton` — коло 32px (44 на 390) у шапці старту гостя з власним меню;
 * - `themeMenuGroup` — група «Тема» для меню акаунта (account-controls.js), пункти — у його
 *   фокус-циклі.
 *
 * Пункт — `menuitemradio`: клік / Enter / Space викликає `setThemePref`, меню лишається відкритим,
 * `aria-checked` і «✓» оновлюються з `subscribeTheme`. Гліф режиму — мова ромбів: контур — світла,
 * заповнене коло — темна, половина — як у системі (CSS, без SVG).
 */

import { h, text } from "../dom.js";
import { getTheme, setThemePref, subscribeTheme } from "../lib/theme.js";

/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {import("../lib/theme.js").ThemePref} ThemePref */
/** @typedef {import("../lib/theme.js").ThemeState} ThemeState */

export const THEME_LABELS = { light: "Світла", dark: "Темна", system: "Як у системі" };

/** @type {ThemePref[]} */
const MODES = ["light", "dark", "system"];

/** @param {ThemeState} s */
const nowWord = (s) => (s.systemDark ? "темна" : "світла");

/**
 * «Тема: світла» | «Тема: темна» | «Тема: як у системі, зараз темна»
 * @param {ThemeState} s
 */
export function themeTriggerLabel(s) {
  if (s.pref === "system") return `Тема: як у системі, зараз ${nowWord(s)}`;
  return `Тема: ${THEME_LABELS[s.pref].toLowerCase()}`;
}

/** @param {ThemePref} mode */
const glyph = (mode) => h("span", { class: "tm-glyph", "data-mode": mode, "aria-hidden": "true" });

/**
 * Група для меню акаунта. items — у порядку DOM, для фокус-циклу меню.
 * @returns {{ el: HTMLElement, items: HTMLElement[], destroy(): void }}
 */
export function themeMenuGroup() {
  const rows = MODES.map((mode) => {
    const meta = mode === "system" ? h("span", { class: "tm-item__meta" }) : null;
    const check = h("span", { class: "tm-item__check", "aria-hidden": "true" });
    const el = h(
      "button",
      {
        type: "button",
        class: "tm-item",
        role: "menuitemradio",
        "aria-checked": "false",
        tabindex: "-1",
        onclick: () => setThemePref(mode),
      },
      glyph(mode),
      h("span", { class: "tm-item__label", text: THEME_LABELS[mode] }),
      meta,
      check,
    );
    return { mode, el, meta, check };
  });
  const el = h(
    "div",
    { class: "tm-group", role: "group", "aria-label": "Тема" },
    h("span", { class: "tm-label", "aria-hidden": "true", text: "Тема" }),
    rows.map((r) => r.el),
  );

  /** @param {ThemeState} s */
  function sync(s) {
    for (const r of rows) {
      const on = r.mode === s.pref;
      r.el.setAttribute("aria-checked", String(on));
      text(r.check, on ? "✓" : "");
      if (r.meta) text(r.meta, `зараз ${nowWord(s)}`);
    }
  }

  sync(getTheme());
  const unsubscribe = subscribeTheme(sync);
  return { el, items: rows.map((r) => r.el), destroy: unsubscribe };
}

/**
 * Коло гостя + власне меню.
 * @param {HTMLElement} el
 * @param {Ctx} [_ctx]
 * @returns {ViewHandle}
 */
export function mountThemeButton(el, _ctx) {
  const icon = glyph("system");
  const trigger = h(
    "button",
    {
      type: "button",
      class: "tm-trigger",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      onclick: () => (menu ? close(true) : open(null)),
      onkeydown: onTriggerKey,
    },
    icon,
  );
  const root = h("div", { class: "tm" }, trigger);
  el.append(root);

  /** @type {{ el: HTMLElement, items: HTMLElement[], destroy(): void } | null} */
  let menu = null;

  /** @param {ThemeState} s */
  function sync(s) {
    icon.setAttribute("data-mode", s.pref);
    trigger.setAttribute("aria-label", themeTriggerLabel(s));
  }
  sync(getTheme());
  const unsubscribe = subscribeTheme(sync);

  /** Фокус: `null` — обраний пункт, −1 — останній. @param {number | null} index */
  function open(index) {
    if (menu) return;
    const group = themeMenuGroup();
    const menuEl = h(
      "div",
      { class: "tm-menu", role: "menu", "aria-label": "Тема", onkeydown: onMenuKey },
      group.el,
    );
    menu = { el: menuEl, items: group.items, destroy: group.destroy };
    root.append(menuEl);
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    const selected = MODES.indexOf(getTheme().pref);
    focusItem(index ?? selected);
  }

  /** @param {boolean} returnFocus */
  function close(returnFocus) {
    if (!menu) return;
    document.removeEventListener("pointerdown", onOutside, true);
    menu.destroy();
    menu.el.remove();
    menu = null;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus && trigger.isConnected) trigger.focus();
  }

  /** @param {number} index */
  function focusItem(index) {
    if (!menu) return;
    const n = menu.items.length;
    menu.items[((index % n) + n) % n]?.focus();
  }

  /** @param {Event} e */
  function onOutside(e) {
    const t = /** @type {Node | null} */ (e.target);
    if (menu && t && !menu.el.contains(t) && !trigger.contains(t)) close(false);
  }

  /** @param {KeyboardEvent} e */
  function onTriggerKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!menu) open(e.key === "ArrowDown" ? null : -1);
      else focusItem(e.key === "ArrowDown" ? MODES.indexOf(getTheme().pref) : -1);
    } else if (e.key === "Escape" && menu) {
      e.preventDefault();
      close(true);
    }
  }

  /** @param {KeyboardEvent} e */
  function onMenuKey(e) {
    if (!menu) return;
    const i = menu.items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === "ArrowDown") focusItem(i + 1);
    else if (e.key === "ArrowUp") focusItem(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(-1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") {
      // Tab іде далі від кола: фокус на тригер, а перехід робить браузер.
      close(true);
      return;
    } else return;
    e.preventDefault();
  }

  return {
    update() {},
    destroy() {
      close(false);
      unsubscribe();
      root.remove();
    },
  };
}
