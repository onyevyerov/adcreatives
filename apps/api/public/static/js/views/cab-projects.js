// @ts-check
/**
 * B9 · Кабінет · мої проєкти (N12-B): сітка карток без постера.
 *
 * Картка: статус (точка за C2 + `STATUS_LABELS`) і дата; хост (або «Без сайту» + «за описом») →
 * відкрити проєкт; знизу — гліфи й підписи форматів і «витрачено N кредитів» → розбивка
 * (`credits.parts` з B4: «Ролик −10 · Формат 1:1 −2 · Правка · рев. 2 −3», «Разом −15»; з
 * поверненням — «0»). Безхазяйний проєкт (`credits: null`) — без суми. Порожньо — «Проєктів ще
 * немає» + «Новий проєкт →». Поки рядки не прийшли (`rows: null`) — лише заголовок.
 * Картки перебудовуються, коли змінюються рядки; розгортання лише перемикає класи.
 */
import { AWAITING, BUSY, FORMAT_LABELS, STATUS_LABELS } from "../contracts.js";
import { hostOf } from "../data/api.js";
import { h } from "../dom.js";
import { formatCredits, signed } from "../lib/credits.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../contracts.js").CreditPart} CreditPart */
/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {import("../contracts.js").MountFn} MountFn */

/** Підпис проєкту без сайту (картка, рядок історії). */
export const NO_SITE = "Без сайту";

/**
 * Хост проєкту для підпису або null — проєкт за описом.
 * @param {Pick<ProjectRow, "site">} row
 */
export const projectHost = (row) => hostOf(row.site);

/**
 * Рядок розбивки витрат.
 * @param {CreditPart} part
 * @returns {string}
 */
export function partLabel(part) {
  switch (part.kind) {
    case "video":
      return "Ролик";
    case "format":
      return part.format ? `Формат ${FORMAT_LABELS[part.format]}` : "Формат";
    case "revision":
      return part.rev ? `Правка · рев. ${part.rev}` : "Правка";
    case "refund":
      return "Повернення за збій";
    default:
      return "";
  }
}

/**
 * Модифікатор точки статусу за C2: робота — --accent з пульсом, очікування — --accent,
 * помилка — --danger, прийнято — --muted, готово — --ink.
 * @param {ProjectStatus} status
 * @returns {"busy" | "awaiting" | "failed" | "intake" | "done"}
 */
export function statusTone(status) {
  if (BUSY.includes(status)) return "busy";
  if (AWAITING.includes(status)) return "awaiting";
  if (status === "failed") return "failed";
  if (status === "intake") return "intake";
  return "done";
}

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/**
 * Дата картки «19.10» за локальним часом; без дати — "".
 * @param {string | null} iso
 */
export function cardDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : "";
}

/**
 * Витрачено нетто: списано мінус повернуто.
 * @param {NonNullable<ProjectRow["credits"]>} credits
 */
export const netSpent = (credits) => credits.charged - credits.refunded;

/** Розміри гліфа формату (ш × в), як у Референсі. @type {Record<string, [number, number]>} */
const GLYPH = { vertical: [8, 14], square: [12, 12], landscape: [16, 9] };

/**
 * @param {ProjectRow} row
 * @param {import("../contracts.js").Actions} actions
 */
function card(row, actions) {
  const tone = statusTone(row.status);
  const host = projectHost(row);
  const credits = row.credits ?? null;
  const breakdownId = `cab-proj-parts-${row.id}`;

  const toggle = credits
    ? h(
        "button",
        {
          type: "button",
          class: "cab-proj__spent",
          "aria-expanded": "false",
          "aria-controls": breakdownId,
          onclick: () => actions.toggleProjectCredits(row.id),
        },
        "витрачено ",
        h("b", { text: formatCredits(netSpent(credits)) }),
      )
    : null;

  const net = credits ? netSpent(credits) : 0;
  const breakdown = credits
    ? h(
        "div",
        { class: "cab-proj__parts", id: breakdownId, hidden: true },
        credits.parts.map((p) =>
          h(
            "span",
            { class: "cab-proj__part" },
            h("span", { text: partLabel(p) }),
            h("b", { text: signed(p.credits) }),
          ),
        ),
        h(
          "span",
          { class: "cab-proj__part cab-proj__part--total" },
          h("span", { text: "Разом" }),
          h("span", { text: signed(-net) }),
        ),
      )
    : null;

  const node = h(
    "article",
    { class: "cab-proj__card", "data-id": row.id },
    h(
      "div",
      { class: "cab-proj__body" },
      h(
        "div",
        { class: "cab-proj__top" },
        h(
          "span",
          { class: `cab-proj__status cab-proj__status--${tone}` },
          h("span", { class: "cab-proj__dot", "aria-hidden": "true" }),
          STATUS_LABELS[row.status] ?? row.status,
        ),
        h("span", { class: "cab-proj__date", text: cardDate(row.createdAt) }),
      ),
      h(
        "button",
        { type: "button", class: "cab-proj__open", onclick: () => actions.openProject(row.id) },
        h("span", { class: "cab-proj__host", text: host ?? NO_SITE }),
        host ? null : h("span", { class: "cab-proj__desc", text: "за описом" }),
      ),
      h(
        "div",
        { class: "cab-proj__foot" },
        h(
          "span",
          { class: "cab-proj__formats" },
          row.formats.map((f) => {
            const [w, ht] = GLYPH[f] ?? [12, 12];
            return h("span", {
              class: "cab-proj__glyph",
              title: FORMAT_LABELS[f],
              style: { width: `${w}px`, height: `${ht}px` },
            });
          }),
          h("span", { class: "cab-proj__fmt", text: row.formats.map((f) => FORMAT_LABELS[f]).join(" · ") }),
        ),
        toggle,
      ),
      breakdown,
    ),
  );
  return { node, toggle, breakdown };
}

/** @type {MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  const empty = h(
    "div",
    { class: "cab-proj__empty", hidden: true },
    h("span", { class: "cab-proj__empty-title", text: "Проєктів ще немає" }),
    h("span", { class: "cab-proj__empty-text", text: "Вставте адресу сайту — перший ролик з’явиться тут." }),
    h(
      "button",
      { type: "button", class: "btn btn--primary", onclick: () => actions.navigate({ route: "start" }) },
      "Новий проєкт ",
      h("span", { "aria-hidden": "true", text: "→" }),
    ),
  );
  const grid = h("div", { class: "cab-proj__grid", hidden: true });
  const root = h(
    "section",
    { class: "cab-proj", "aria-labelledby": "cab-proj-title" },
    h("h1", { class: "display-m cab-proj__title", id: "cab-proj-title", text: "Мої проєкти" }),
    empty,
    grid,
  );
  el.append(root);

  /** @type {Map<string, ReturnType<typeof card>>} */
  let cards = new Map();
  /** @type {ProjectRow[] | null | undefined} */
  let shownRows;

  /** @param {string | null} open */
  function renderOpen(open) {
    for (const [id, c] of cards) {
      const on = id === open && !!c.breakdown;
      c.node.classList.toggle("is-open", on);
      c.toggle?.setAttribute("aria-expanded", on ? "true" : "false");
      if (c.breakdown) c.breakdown.hidden = !on;
    }
  }

  /** @param {UiState} s */
  function render(s) {
    const { rows, open } = s.cabinet.projects;
    if (rows !== shownRows) {
      shownRows = rows;
      cards = new Map((rows ?? []).map((r) => [r.id, card(r, actions)]));
      grid.replaceChildren(...[...cards.values()].map((c) => c.node));
      empty.hidden = !(rows && rows.length === 0);
      grid.hidden = !(rows && rows.length > 0);
    }
    renderOpen(open);
  }

  render(ctx.store.getState());

  return {
    update: (s) => render(s),
    destroy: () => root.remove(),
  };
}
