// @ts-check
/**
 * B9 · Кабінет · історія (N11-B): стрічка операцій по днях.
 *
 * - День — за локальною датою: заголовок «19 жовтня» і праворуч «за день −12 · на кінець 12»
 *   (сума `credits` дня; `balanceAfter` найновішого запису дня).
 * - Рядок: час · назва операції з `kind` + `ref` (`operationLabel`) · примітка коригування «…» ·
 *   хост проєкту з `cabinet.projects.rows` (→ відкрити проєкт) · сума і «→ залишок».
 * - Перше завантаження — «Завантажую операції…»; порожньо — «Операцій ще немає»; є ще сторінки —
 *   «Показати ще» (`loadHistory(true)`, під час довантаження — спінер і disabled); кінець —
 *   «Це всі операції · з <дата реєстрації>».
 * Стрічка перебудовується, лише коли змінилися записи або проєкти; кнопка «Показати ще» — та сама.
 */
import { FORMAT_LABELS } from "../contracts.js";
import { h, text } from "../dom.js";
import { formatNumber, signed } from "../lib/credits.js";
import { NO_SITE, projectHost } from "./cab-projects.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").MountFn} MountFn */
/** @typedef {Readonly<Record<string, string>>} TopupMap topupId → packageId */

/** Карта поповнень історії (`history.topups`); старий стан без поля — порожня. */
const EMPTY_TOPUPS = Object.freeze({});
/**
 * @param {UiState} s
 * @returns {TopupMap}
 */
const topupsOf = (s) => s.cabinet.history.topups ?? EMPTY_TOPUPS;

/** Місяці в родовому відмінку: «19 жовтня». */
const MONTHS = [
  "січня",
  "лютого",
  "березня",
  "квітня",
  "травня",
  "червня",
  "липня",
  "серпня",
  "вересня",
  "жовтня",
  "листопада",
  "грудня",
];

/** @param {number} n */
const pad = (n) => String(n).padStart(2, "0");

/**
 * Назва операції з `kind` + `ref` (таблиця Референсу N11). Поповнення: пакет — з
 * `topups[topupId]` (`history.topups`, з `GET topups`) і його назва з `packages`; `"custom"` —
 * «своя сума»; поповнення немає в карті (або пакета немає в `packages`) — просто «Поповнення».
 * @param {LedgerEntry} e
 * @param {readonly CreditPackage[]} [packages]
 * @param {Readonly<Record<string, string>>} [topups]
 * @returns {string}
 */
export function operationLabel(e, packages = [], topups = {}) {
  const ref = e.ref ?? {};
  switch (e.kind) {
    case "charge":
      if (ref.format) return `Додатковий формат ${FORMAT_LABELS[ref.format]}`;
      if (ref.rev !== undefined) return `Правка · рев. ${ref.rev}`;
      return "Ролик";
    case "refund":
      return "Повернення за збій";
    case "topup": {
      const packageId = ref.topupId ? topups[ref.topupId] : undefined;
      if (packageId === "custom") return "Поповнення · своя сума";
      const pkg = packageId ? packages.find((p) => p.id === packageId) : undefined;
      return pkg ? `Поповнення · ${pkg.label}` : "Поповнення";
    }
    case "adjust":
      return "Коригування";
    case "bonus":
      return "Вітальний бонус";
    default:
      return e.note || e.kind;
  }
}

/**
 * Дата за локальним часом: ключ дня, заголовок «19 жовтня» (рік — лише не поточний), час «10:40».
 * @param {string} iso
 * @param {number} [thisYear]
 */
export function localParts(iso, thisYear = new Date().getFullYear()) {
  const d = new Date(iso);
  const y = d.getFullYear();
  return {
    key: `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    title: `${d.getDate()} ${MONTHS[d.getMonth()]}${y === thisYear ? "" : ` ${y}`}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Записи (новіші першими) → дні в тому ж порядку з підсумком і балансом на кінець дня.
 * @param {readonly LedgerEntry[]} entries
 * @returns {{ key: string, title: string, total: number, end: number, entries: LedgerEntry[] }[]}
 */
export function groupByDay(entries) {
  /** @type {ReturnType<typeof groupByDay>} */
  const days = [];
  for (const e of entries) {
    const { key, title } = localParts(e.at);
    let day = days.at(-1);
    if (day?.key !== key) {
      day = days.find((x) => x.key === key);
      if (!day) {
        // Найновіший запис дня — перший, що трапився: його залишок — «на кінець».
        day = { key, title, total: 0, end: e.balanceAfter, entries: [] };
        days.push(day);
      }
    }
    day.total += e.credits;
    day.entries.push(e);
  }
  return days;
}

/**
 * «з 14.10.2026» — дата реєстрації за локальним часом.
 * @param {string | null | undefined} iso
 */
export function sinceDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
    : "";
}

/** @type {MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  const loading = h(
    "div",
    { class: "cab-hist__loading", role: "status", hidden: true },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    "Завантажую операції…",
  );
  const empty = h(
    "div",
    { class: "cab-hist__empty", hidden: true },
    h("span", { class: "cab-hist__empty-title", text: "Операцій ще немає" }),
    h("span", {
      class: "cab-hist__empty-text",
      text: "Тут з’являться поповнення, списання за ролики й правки та повернення.",
    }),
  );
  const feed = h("div", { class: "cab-hist__days", hidden: true });
  const moreSpin = h("span", { class: "spinner", "aria-hidden": "true", hidden: true });
  const more = h(
    "button",
    {
      type: "button",
      class: "btn btn--ghost btn--sm cab-hist__more",
      hidden: true,
      onclick: () => void actions.loadHistory(true),
    },
    moreSpin,
    "Показати ще",
  );
  const end = h("span", { class: "cab-hist__end", hidden: true });

  const root = h(
    "section",
    { class: "cab-hist", "aria-labelledby": "cab-hist-title" },
    h("h1", { class: "display-m cab-hist__title", id: "cab-hist-title", text: "Історія" }),
    loading,
    empty,
    feed,
    more,
    end,
  );
  el.append(root);

  /**
   * @param {LedgerEntry} e
   * @param {Map<string, ProjectRow>} byId
   * @param {readonly CreditPackage[]} packages
   * @param {TopupMap} topups
   */
  function row(e, byId, packages, topups) {
    const note = e.kind === "adjust" && e.note ? e.note : null;
    const pid = e.ref?.projectId;
    const project = pid ? byId.get(pid) : undefined;
    return h(
      "div",
      { class: "cab-hist__row" },
      h("span", { class: "cab-hist__time", text: localParts(e.at).time }),
      h(
        "span",
        { class: "cab-hist__what" },
        h("span", { class: "cab-hist__label", text: operationLabel(e, packages, topups) }),
        note ? h("span", { class: "cab-hist__note", text: `«${note}»` }) : null,
        project && pid
          ? h("button", {
              type: "button",
              class: "cab-hist__proj",
              text: projectHost(project) ?? NO_SITE,
              onclick: () => actions.openProject(pid),
            })
          : null,
      ),
      h(
        "span",
        { class: "cab-hist__sum" },
        h("span", { class: "cab-hist__credits", text: signed(e.credits) }),
        h("span", { class: "cab-hist__after", text: `→ ${formatNumber(e.balanceAfter)}` }),
      ),
    );
  }

  /** @type {{ entries: LedgerEntry[], rows: ProjectRow[] | null, packages: CreditPackage[] | undefined, topups: TopupMap } | null} */
  let shown = null;

  /** @param {UiState} s */
  function render(s) {
    const h0 = s.cabinet.history;
    const rows = s.cabinet.projects.rows;
    const packages = s.account.me?.packages;
    const has = h0.entries.length > 0;

    loading.hidden = !(h0.loading && !has);
    empty.hidden = h0.loading || has;
    feed.hidden = !has;
    more.hidden = !(has && h0.more);
    const busy = h0.loading && has;
    more.disabled = busy;
    moreSpin.hidden = !busy;
    if (busy) more.setAttribute("aria-busy", "true");
    else more.removeAttribute("aria-busy");
    end.hidden = !(has && !h0.more && !h0.loading);
    text(end, `Це всі операції · з ${sinceDate(s.account.me?.user.createdAt)}`);

    const topups = topupsOf(s);
    if (
      shown &&
      shown.entries === h0.entries &&
      shown.rows === rows &&
      shown.packages === packages &&
      shown.topups === topups
    )
      return;
    shown = { entries: h0.entries, rows, packages, topups };
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    feed.replaceChildren(
      ...groupByDay(h0.entries).map((day) =>
        h(
          "div",
          { class: "cab-hist__day" },
          h(
            "div",
            { class: "cab-hist__head" },
            h("h2", { class: "cab-hist__day-title", text: day.title }),
            h(
              "span",
              { class: "cab-hist__day-meta" },
              h("span", null, "за день ", h("b", { text: signed(day.total) })),
              h("span", { text: `на кінець ${formatNumber(day.end)}` }),
            ),
          ),
          day.entries.map((e) => row(e, byId, packages ?? [], topups)),
        ),
      ),
    );
  }

  render(ctx.store.getState());

  return {
    update: (s) => render(s),
    destroy: () => root.remove(),
  };
}
