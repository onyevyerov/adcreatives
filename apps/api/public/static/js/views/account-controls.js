// @ts-check
/**
 * B3 · Контроли акаунта (N4-B): пілюля балансу «12 кредитів | +», коло з ініціалами і меню.
 *
 * - `place: "page"` — у топбарі (C2): корінь `display: contents`, частини стають у ряд
 *   `.tb-right`; між пілюлею і колом — порожній `.ac-slot`, куди сторінка кладе свої кнопки
 *   («Новий проєкт»), щоб порядок Tab збігався з видимим; меню — від правого краю
 *   топбару. Корінь не ховається (слот має лишатись видимим) — ховаються частини;
 * - `place: "start"` — у шапці старту (B2): компактний ряд 32px, меню під колом.
 *
 * `meStatus: "loading"` — спінер «баланс…» замість пілюлі; `"anon"` — нічого. Стан меню — локальний
 * (не в store). Мітка `account.delta` («−3 / +10») — анімація `ac-delta` один раз на новий `key`.
 */

import { h, text } from "../dom.js";
import { creditWord, formatNumber, isLow, signed } from "../lib/credits.js";
import { themeMenuGroup } from "./theme-switch.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").Route} Route */
/** @typedef {import("../contracts.js").PublicUser} PublicUser */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */

/**
 * `key` останньої показаної мітки — спільний для всіх монтувань: після переходу між маршрутами
 * (топбар монтується заново) стара мітка не програється вдруге.
 * @type {number | null}
 */
let shownDeltaKey = null;

/**
 * Ініціали для кола: перші літери слів імені, до двох, великими; без імені — «·».
 * @param {string | null | undefined} name
 */
export function initials(name) {
  const s = String(name ?? "")
    .trim()
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return s || "·";
}

/**
 * Пункти меню: Кабінет · Мої проєкти {N} · Історія · Профіль · [Адмінка]; кожен — перехід через `navigate`.
 * @param {boolean} isAdmin
 * @param {number | null} projectCount
 * @returns {{ label: string, meta: string, route: Route }[]}
 */
export function menuItems(isAdmin, projectCount) {
  /** @type {{ label: string, meta: string, route: Route }[]} */
  const items = [
    { label: "Кабінет", meta: "", route: { route: "cabinet", section: "balance" } },
    {
      label: "Мої проєкти",
      meta: projectCount === null ? "" : formatNumber(projectCount),
      route: { route: "cabinet", section: "projects" },
    },
    { label: "Історія", meta: "", route: { route: "cabinet", section: "history" } },
    { label: "Профіль", meta: "", route: { route: "cabinet", section: "profile" } },
  ];
  if (isAdmin) items.push({ label: "Адмінка", meta: "", route: { route: "admin", tab: "users" } });
  return items;
}

/**
 * @param {HTMLElement} el
 * @param {Ctx} ctx
 * @param {{ place: "start" | "page" }} o
 * @returns {ViewHandle}
 */
export function mount(el, ctx, o) {
  const place = o?.place === "start" ? "start" : "page";

  // ───── Завантаження /me ─────
  const loading = h(
    "span",
    { class: "ac-loading", role: "status", "aria-label": "Баланс завантажується" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("span", { "aria-hidden": "true", text: "баланс…" }),
  );

  // ───── Пілюля балансу ─────
  const balNum = h("b", { class: "ac-pill__num" });
  const balWord = h("span", { class: "ac-pill__word" });
  const balBtn = h(
    "button",
    {
      type: "button",
      class: "ac-pill__bal",
      onclick: () => ctx.actions.navigate({ route: "cabinet", section: "balance" }),
    },
    balNum,
    balWord,
  );
  const plusLabel = h("span", { class: "ac-pill__label", text: "Поповнити" });
  const plusBtn = h(
    "button",
    {
      type: "button",
      class: "ac-pill__plus",
      "aria-label": "Поповнити баланс",
      onclick: () => ctx.actions.openTopup({ from: "topbar" }),
    },
    h("span", { class: "ac-pill__sign", "aria-hidden": "true", text: "+" }),
    plusLabel,
  );
  const pill = h(
    "span",
    { class: "ac-pill" },
    balBtn,
    h("span", { class: "ac-pill__sep", "aria-hidden": "true" }),
    plusBtn,
  );
  /** @type {HTMLElement | null} */
  let deltaEl = null;

  // ───── Коло й меню ─────
  const role = h("span", { class: "ac-role", text: "адмін" });
  const trigger = h("button", {
    type: "button",
    class: "ac-trigger",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    "aria-label": "Меню акаунта",
    onclick: () => (menu ? close(true) : open(0)),
    onkeydown: onTriggerKey,
  });

  const slot = place === "page" && h("div", { class: "ac-slot" });
  const root = h("div", { class: `ac ac--${place}` }, loading, pill, slot, role, trigger);
  el.append(root);

  /** @type {{ el: HTMLElement, items: HTMLElement[], destroy(): void } | null} */
  let menu = null;
  /** @type {PublicUser | null} */
  let user = null;
  /** @type {number | null} */
  let projectCount = null;

  // ───── Меню ─────

  /** @param {number} index індекс пункту для фокуса; −1 — останній */
  function open(index) {
    if (!user || menu) return;
    menu = buildMenu(user, projectCount);
    root.append(menu.el);
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("ac-trigger--open");
    document.addEventListener("pointerdown", onOutside, true);
    focusItem(index < 0 ? menu.items.length - 1 : index);
  }

  /** @param {boolean} returnFocus */
  function close(returnFocus) {
    if (!menu) return;
    document.removeEventListener("pointerdown", onOutside, true);
    menu.destroy();
    menu.el.remove();
    menu = null;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("ac-trigger--open");
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
      if (!menu) open(e.key === "ArrowDown" ? 0 : -1);
      else focusItem(e.key === "ArrowDown" ? 0 : -1);
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

  /** @param {() => void} act */
  const choose = (act) => () => {
    close(false);
    act();
    if (trigger.isConnected && root.isConnected) trigger.focus();
  };

  /**
   * @param {PublicUser} u
   * @param {number | null} count
   */
  function buildMenu(u, count) {
    /** @type {HTMLElement[]} */
    const items = [];
    const rows = menuItems(u.isAdmin, count).map((it) => {
      const children = [h("span", { text: it.label }), h("span", { class: "ac-menu__meta", text: it.meta })];
      const node = h(
        "button",
        {
          type: "button",
          class: "ac-menu__item",
          role: "menuitem",
          tabindex: "-1",
          onclick: choose(() => ctx.actions.navigate(it.route)),
        },
        children,
      );
      items.push(node);
      return node;
    });
    // Група «Тема» (B5): між списком і «Вийти»; її пункти — у фокус-циклі меню.
    const theme = themeMenuGroup();
    items.push(...theme.items);
    const logout = h("button", {
      type: "button",
      class: "ac-menu__item ac-menu__item--logout",
      role: "menuitem",
      tabindex: "-1",
      text: "Вийти",
      onclick: choose(() => void ctx.actions.logout()),
    });
    items.push(logout);
    const menuEl = h(
      "div",
      { class: "ac-menu", role: "menu", "aria-label": "Меню акаунта", onkeydown: onMenuKey },
      h(
        "div",
        { class: "ac-menu__head" },
        h("span", { class: "ac-menu__name", text: u.name }),
        h("span", { class: "ac-menu__email", text: u.email }),
        u.isAdmin && h("span", { class: "ac-menu__role", text: "роль · адміністратор" }),
      ),
      h("div", { class: "ac-menu__list" }, rows),
      theme.el,
      h("div", { class: "ac-menu__foot" }, logout),
    );
    return { el: menuEl, items, destroy: theme.destroy };
  }

  // ───── Рендер ─────

  /** @param {UiState} state */
  function showDelta(state) {
    const d = state.account.delta;
    if (!d || d.key === shownDeltaKey) return;
    shownDeltaKey = d.key;
    deltaEl?.remove();
    const node = h("span", { class: "ac-delta", "aria-hidden": "true", text: signed(d.credits) });
    node.addEventListener("animationend", () => {
      node.remove();
      if (deltaEl === node) deltaEl = null;
    });
    deltaEl = node;
    pill.append(node);
  }

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    const acc = state.account;
    if (prev && acc === prev.account) return;
    const isLoading = acc.meStatus === "loading";
    const me = acc.meStatus === "ready" ? acc.me : null;
    const nextUser = isLoading ? null : (me?.user ?? null);

    if (place === "start") root.hidden = !isLoading && !me;
    trigger.hidden = !isLoading && !me;
    loading.hidden = !isLoading;
    pill.hidden = !me;
    role.hidden = !nextUser?.isAdmin;
    // Під час завантаження коло показує ініціали відомого `me` (кадр ws-meload), меню — неактивне.
    text(trigger, initials((nextUser ?? acc.me?.user)?.name));
    if (nextUser) trigger.removeAttribute("aria-disabled");
    else trigger.setAttribute("aria-disabled", "true");

    if (me) {
      text(balNum, formatNumber(me.balance));
      text(balWord, creditWord(me.balance));
      balBtn.setAttribute(
        "aria-label",
        `Баланс: ${formatNumber(me.balance)} ${creditWord(me.balance)}. Відкрити кабінет`,
      );
      const low = isLow(me.balance, me.prices);
      plusBtn.classList.toggle("ac-pill__plus--low", low);
      plusLabel.hidden = !low;
      showDelta(state);
    }

    const changed = nextUser !== user || acc.projectCount !== projectCount;
    user = nextUser;
    projectCount = acc.projectCount;
    if (menu && changed) {
      if (!user) close(false);
      else {
        // Ім'я, роль чи «Мої проєкти · N» змінились при відкритому меню — перебудувати на місці.
        const i = menu.items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const next = buildMenu(user, projectCount);
        menu.destroy();
        menu.el.replaceWith(next.el);
        menu = next;
        if (i >= 0) focusItem(Math.min(i, next.items.length - 1));
      }
    }
  }

  render(ctx.store.getState(), null);

  return {
    update: (state, prev) => render(state, prev),
    destroy() {
      close(false);
      root.remove();
    },
  };
}
