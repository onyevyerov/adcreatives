// @ts-check
/**
 * B7 · Каркас кабінету (N8-B): дві колонки під топбаром (топбар монтує app.js у `#cab-topbar`).
 * Ліворуч — «← до host» (прийшли з проєкту), «Кабінет», розділи з метою праворуч (баланс,
 * кількість операцій і проєктів), «Адмінка →» адміну, e-mail і «Вийти». Праворуч — розділ:
 * `cab-balance` / `cab-history` / `cab-projects` / `cab-profile` (кожен — свій `mount`); поки `me`
 * вантажиться або `cabinet.loading` — рядок «Завантажую кабінет…». Колонки скролляться окремо.
 * DOM будується один раз, `update` патчить змінене; розділ перемонтовується лише при зміні.
 */
import { h, text } from "../dom.js";
import { formatNumber } from "../lib/credits.js";
import * as cabBalance from "./cab-balance.js";
import * as cabHistory from "./cab-history.js";
import * as cabProfile from "./cab-profile.js";
import * as cabProjects from "./cab-projects.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").CabinetState} CabinetState */
/** @typedef {import("../contracts.js").MountFn} MountFn */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {CabinetState["section"]} Section */

/** Розділи лівої колонки в порядку Референсу. @type {readonly { id: Section, label: string, mount: MountFn }[]} */
export const SECTIONS = [
  { id: "balance", label: "Баланс і поповнення", mount: cabBalance.mount },
  { id: "history", label: "Історія", mount: cabHistory.mount },
  { id: "projects", label: "Мої проєкти", mount: cabProjects.mount },
  { id: "profile", label: "Профіль", mount: cabProfile.mount },
];

/**
 * Мета пункту навігації: баланс; кількість операцій (коли історію вже завантажено); кількість
 * проєктів (`account.projectCount`, інакше рядки кабінету); профіль — без мети.
 * @param {UiState} s
 * @param {Section} id
 * @returns {string}
 */
export function navMeta(s, id) {
  const me = s.account.me;
  switch (id) {
    case "balance":
      return me ? formatNumber(me.balance) : "";
    case "history": {
      const n = s.cabinet.history.entries.length;
      return n > 0 ? formatNumber(n) : "";
    }
    case "projects": {
      const n = s.account.projectCount ?? s.cabinet.projects.rows?.length ?? null;
      return n === null ? "" : formatNumber(n);
    }
    default:
      return "";
  }
}

/**
 * Що показує права колонка: розділ, рядок завантаження або нічого (гість — модалка входу).
 * @param {UiState} s
 * @returns {"section" | "loading" | "none"}
 */
export function mainKind(s) {
  if (s.account.meStatus === "anon") return "none";
  if (s.account.meStatus === "loading" || !s.account.me || s.cabinet.loading) return "loading";
  return "section";
}

/** @type {MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  const backHost = h("span", { class: "cab-link__mono" });
  const back = h(
    "button",
    {
      type: "button",
      class: "cab-link cab-nav__back",
      onclick: () => {
        const to = ctx.store.getState().cabinet.backTo;
        if (to?.kind === "project") actions.navigate({ route: "project", projectId: to.projectId });
      },
    },
    "← до ",
    backHost,
  );

  /** @type {Map<Section, { button: HTMLButtonElement, meta: HTMLSpanElement }>} */
  const items = new Map();
  const list = h("nav", { class: "cab-nav__list", "aria-label": "Розділи кабінету" });
  for (const sec of SECTIONS) {
    const meta = h("span", { class: "cab-nav__meta" });
    const button = h(
      "button",
      {
        type: "button",
        class: "cab-nav__item",
        onclick: () => {
          if (ctx.store.getState().cabinet.section !== sec.id)
            actions.navigate({ route: "cabinet", section: sec.id });
        },
      },
      h("span", { text: sec.label }),
      meta,
    );
    items.set(sec.id, { button, meta });
    list.append(button);
  }
  const adminItem = h(
    "button",
    {
      type: "button",
      class: "cab-nav__item",
      onclick: () => actions.navigate({ route: "admin", tab: "users" }),
    },
    h("span", { text: "Адмінка" }),
    h("span", { class: "cab-nav__meta", text: "→" }),
  );
  list.append(adminItem);

  const email = h("span", { class: "cab-nav__email" });
  const foot = h(
    "div",
    { class: "cab-nav__foot" },
    email,
    h("button", { type: "button", class: "cab-link", text: "Вийти", onclick: () => void actions.logout() }),
  );

  const aside = h(
    "aside",
    { class: "cab-nav" },
    h("div", { class: "cab-nav__head" }, back, h("h2", { class: "cab-nav__title", text: "Кабінет" })),
    list,
    foot,
  );

  const loading = h(
    "div",
    { class: "cab-loading", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    "Завантажую кабінет…",
  );
  const body = h("div", { class: "cab-main__inner" });
  const main = h("main", { class: "cab-main" }, body);
  const root = h("div", { class: "cab" }, aside, main);
  el.append(root);

  /** @type {{ id: Section, view: ViewHandle | null } | null} */
  let section = null;

  function leaveSection() {
    if (!section) return;
    const view = section.view;
    section = null;
    if (view)
      try {
        view.destroy();
      } catch (err) {
        console.error("[cabinet] destroy", err);
      }
  }

  /** @param {UiState} s @param {UiState} prev */
  function renderMain(s, prev) {
    const kind = mainKind(s);
    const id = s.cabinet.section;
    if (kind !== "section") {
      leaveSection();
      body.replaceChildren(...(kind === "loading" ? [loading] : []));
      return;
    }
    if (section?.id === id) {
      const view = section.view;
      if (view)
        try {
          view.update(s, prev);
        } catch (err) {
          console.error(`[cabinet] update ${id}`, err);
        }
      return;
    }
    leaveSection();
    body.replaceChildren();
    main.scrollTop = 0;
    const def = SECTIONS.find((x) => x.id === id) ?? SECTIONS[0];
    /** @type {ViewHandle | null} */
    let view = null;
    try {
      view = def ? def.mount(body, ctx) : null;
    } catch (err) {
      console.error(`[cabinet] mount ${id}`, err);
    }
    section = { id, view };
  }

  /** @param {UiState} s @param {UiState} prev */
  function render(s, prev) {
    const to = s.cabinet.backTo;
    back.hidden = to?.kind !== "project";
    text(backHost, to?.kind === "project" ? (to.host ?? "проєкту") : "");

    for (const [id, { button, meta }] of items) {
      const on = s.cabinet.section === id;
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      text(meta, navMeta(s, id));
    }
    adminItem.hidden = !(s.account.meStatus === "ready" && s.account.me?.user.isAdmin);
    text(email, s.account.me?.user.email ?? "");
    foot.hidden = !s.account.me;

    renderMain(s, prev);
  }

  const first = ctx.store.getState();
  render(first, first);

  return {
    update: render,
    destroy() {
      leaveSection();
      root.remove();
    },
  };
}
