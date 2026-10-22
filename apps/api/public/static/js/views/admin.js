// @ts-check
/**
 * B11 · Адмінка (N14-A): підшапка з вкладками «Користувачі · Outbox · Усі проєкти» і
 * «Статистика ↗»; на «Користувачах» — таблиця з пошуком (фільтр на клієнті) і бічна панель
 * 420px: профіль, баланс, ручне коригування (з підтвердженням великого списання), останні
 * операції. Не-адмін (`admin.forbidden`) — екран 403 з views/session.js (B12).
 * Топбар (`#admin-topbar`) монтує app.js. DOM будується один раз, `update` патчить змінене:
 * поля форми не перестворюються, рядки таблиць і outbox — за id (фокус лишається на місці).
 */
import { FORMAT_LABELS, STATUS_LABELS } from "../contracts.js";
import { NOTE_MAX, needsConfirm, PANEL_ENTRIES, parseCredits } from "../data/admin-actions.js";
import { clear, h, text } from "../dom.js";
import { creditWord, formatCredits, formatNumber, signed } from "../lib/credits.js";
import { mount as mountUsage } from "./admin-usage.js";
import { mountForbidden } from "./session.js";
import { formatUsd, statusKind } from "./topbar.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").AdminState} AdminState */
/** @typedef {import("../contracts.js").PublicUser} PublicUser */
/** @typedef {import("../contracts.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../contracts.js").ProjectRow} ProjectRow */
/** @typedef {import("../contracts.js").OutboxMail} OutboxMail */
/** @typedef {import("../contracts.js").CreditPackage} CreditPackage */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {PublicUser & { balance: number }} UserRow */

/** @type {readonly { tab: AdminState["tab"], label: string }[]} */
export const TABS = [
  { tab: "users", label: "Користувачі" },
  { tab: "outbox", label: "Outbox" },
  { tab: "all", label: "Усі проєкти" },
  { tab: "usage", label: "Використання" },
];

/** @type {Record<OutboxMail["kind"], string>} */
const MAIL_KIND = { activate: "активація", reset: "скидання" };

/** Помилки коригування (копірайт UI з Референсу). */
export const ADJUST_ERRORS = {
  zero: "Ціле число, не нуль: +5 або −3.",
  note: "Примітка — до 200 символів.",
};

const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");

/** «14.10.2026» (локальний час). @param {string | null} iso */
export function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
    : "";
}

/** «19.10» (локальний час). @param {string | null} iso */
export function formatDay(iso) {
  return formatDate(iso).slice(0, 5);
}

/** «19.10 10:40» (локальний час). @param {string | null} iso */
export function formatDayTime(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? `${formatDay(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : "";
}

/**
 * Хост з адреси, як її ввів клієнт («https://zerno.example.com/» → «zerno.example.com»).
 * @param {string} site
 */
export function hostOf(site) {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(site) ? site : `https://${site}`).host || site;
  } catch {
    return site;
  }
}

/**
 * Назва операції з `kind` + `ref` (таблиця «Назви операцій» Референсу). Пакет поповнення —
 * за кількістю кредитів (адмінка не бачить чужих поповнень); не збіглося — «своя сума».
 * @param {LedgerEntry} e
 * @param {readonly CreditPackage[]} packages
 */
export function entryLabel(e, packages) {
  switch (e.kind) {
    case "charge":
      if (e.ref.format) return `Додатковий формат ${FORMAT_LABELS[e.ref.format]}`;
      if (typeof e.ref.rev === "number") return `Правка · рев. ${e.ref.rev}`;
      return "Ролик";
    case "refund":
      return "Повернення за збій";
    case "topup": {
      if (!packages.length) return "Поповнення";
      const pkg = packages.find((p) => p.credits === e.credits);
      return `Поповнення · ${pkg ? pkg.label : "своя сума"}`;
    }
    case "bonus":
      return "Вітальний бонус";
    default:
      return "Коригування";
  }
}

/**
 * Підрядок операції: хост проєкту (або «Без сайту») і примітка коригування в «…».
 * @param {LedgerEntry} e
 * @param {readonly ProjectRow[]} projects
 */
export function entrySub(e, projects) {
  const parts = [];
  if (e.ref.projectId) {
    const p = projects.find((x) => x.id === e.ref.projectId);
    if (p) parts.push(p.site ? hostOf(p.site) : "Без сайту");
  }
  if (e.kind === "adjust" && e.note) parts.push(`«${e.note}»`);
  return parts.join(" · ");
}

/**
 * Користувачі за пошуком (e-mail, без урахування регістру).
 * @param {readonly UserRow[]} users
 * @param {string} q
 */
export function filterUsers(users, q) {
  const needle = q.trim().toLowerCase();
  return needle ? users.filter((u) => u.email.toLowerCase().includes(needle)) : [...users];
}

/** «баланс 12 → 17». @param {number} balance @param {number} credits */
export function previewText(balance, credits) {
  const after = balance + credits;
  return `баланс ${formatNumber(balance)} → ${after < 0 ? `−${formatNumber(-after)}` : formatNumber(after)}`;
}

/** @param {NonNullable<AdminState["adjust"]["done"]>} done */
export function doneText(done) {
  const verb = done.credits > 0 ? "Нараховано" : "Списано";
  const note = done.note ? ` · «${done.note}»` : "";
  return `✓ ${verb} ${signed(done.credits)}${note}. Баланс ${formatNumber(done.balance)}.`;
}

/** @param {AdminState["adjust"]["error"]} error */
export function errorText(error) {
  if (!error) return "";
  if (typeof error === "object") return `Не вистачає кредитів: потрібно ${error.need}, у вас ${error.have}.`;
  return ADJUST_ERRORS[error];
}

/** Обраний користувач: з `selected`, поки вантажиться — з рядка таблиці. @param {AdminState} a */
function selection(a) {
  if (!a.selectedId) return null;
  if (a.selected && a.selected.user.id === a.selectedId) return a.selected;
  const row = a.users.find((u) => u.id === a.selectedId);
  return row ? { user: row, balance: row.balance, entries: /** @type {LedgerEntry[]} */ ([]) } : null;
}

/** @param {HTMLElement} el @param {string} name @param {boolean} on */
const toggle = (el, name, on) => el.classList.toggle(name, on);

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  // ───────────── Підшапка ─────────────

  const tabs = TABS.map(({ tab, label }) => {
    const count = h("span", { class: "adm-tab__count" });
    // У «Використання» лічильника немає.
    const btn = h(
      "button",
      { class: "seg__opt adm-tab", type: "button", role: "tab", onclick: () => actions.adminTab(tab) },
      label,
      tab === "usage" ? [] : [" ", count],
    );
    btn.dataset.tab = tab;
    return { tab, btn, count };
  });
  /** Стрілки ←/→ між вкладками (патерн tablist). @param {KeyboardEvent} e */
  const onTabKey = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = tabs.findIndex((t) => t.btn === e.target);
    if (i < 0) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (!next) return;
    next.btn.focus();
    actions.adminTab(next.tab);
  };
  const tablist = h(
    "div",
    { class: "seg adm-tabs", role: "tablist", "aria-label": "Розділи адмінки", onkeydown: onTabKey },
    tabs.map((t) => t.btn),
  );
  const head = h(
    "div",
    { class: "adm-head" },
    h("div", { class: "adm-head__left" }, h("h1", { class: "adm-title", text: "Адмінка" }), tablist),
    h("a", { class: "adm-stats", href: "/stats", text: "Статистика ↗" }),
  );

  // ───────────── Головна область ─────────────

  const loading = h(
    "div",
    { class: "adm-loading", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    "Завантажую…",
  );
  const forbiddenEl = h("div", { class: "adm-forbidden" });

  // Користувачі
  const search = h("input", {
    class: "adm-search__input",
    type: "search",
    placeholder: "Пошук за e-mail",
    autocomplete: "off",
    oninput: (/** @type {Event} */ e) =>
      actions.adminSearch(/** @type {HTMLInputElement} */ (e.target).value),
  });
  const usersCount = h("span", { class: "adm-count" });
  const usersEmpty = h("div", { class: "adm-empty adm-empty--table" });
  const usersBody = h("div", { class: "adm-rows", role: "rowgroup" });
  const usersSection = h(
    "section",
    { class: "adm-users", "aria-label": "Користувачі" },
    h(
      "div",
      { class: "adm-users__bar" },
      h("label", { class: "adm-search" }, h("span", { class: "sr-only", text: "Пошук за e-mail" }), search),
      usersCount,
    ),
    h(
      "div",
      { class: "adm-table", role: "table", "aria-label": "Користувачі" },
      h(
        "div",
        { class: "adm-urow adm-thead label-s", role: "row" },
        ["E-mail", "Ім’я", "Активація", "Створено"].map((t) => h("span", { role: "columnheader", text: t })),
        h("span", { class: "adm-num", role: "columnheader", text: "Баланс" }),
      ),
      usersEmpty,
      usersBody,
    ),
  );

  // Outbox
  const outboxEmpty = h("div", { class: "adm-empty adm-empty--outbox", text: "Листів ще немає." });
  const outboxBody = h("div", { class: "adm-mails" });
  const outboxSection = h(
    "section",
    { class: "adm-outbox", "aria-label": "Outbox" },
    h("span", {
      class: "adm-note",
      text: "Листи не відправляються — це dev-outbox. Новіші зверху, до 50.",
    }),
    outboxEmpty,
    outboxBody,
  );

  // Усі проєкти
  const allBody = h("div", { role: "rowgroup" });
  const allSection = h(
    "section",
    { class: "adm-all", role: "table", "aria-label": "Усі проєкти" },
    h(
      "div",
      { class: "adm-prow adm-thead label-s", role: "row" },
      ["Проєкт", "Власник", "Статус", "Формати", "Дата"].map((t) =>
        h("span", { role: "columnheader", text: t }),
      ),
      h("span", { class: "adm-num", role: "columnheader", text: "Собівартість" }),
    ),
    allBody,
  );

  // Використання (views/admin-usage.js монтується при першому показі)
  const usageSection = h("section", { class: "adm-usage", "aria-label": "Використання" });

  const main = h(
    "main",
    { class: "adm-main" },
    loading,
    forbiddenEl,
    usersSection,
    outboxSection,
    allSection,
    usageSection,
  );

  // ───────────── Бічна панель ─────────────

  const noSel = h("p", {
    class: "adm-panel__hint",
    text: "Оберіть користувача в списку — деталі, баланс і коригування з’являться тут.",
  });
  const selRole = h("span", { class: "label-s" });
  const selName = h("h2", { class: "adm-panel__name" });
  const selEmail = h("span", { class: "adm-panel__email" });
  const selMeta = h("span", { class: "adm-panel__meta" });
  const selBal = h("span", { class: "adm-balance__num" });
  const selWord = h("span", { class: "adm-balance__word" });

  // Коригування
  const creditsInput = h("input", {
    class: "adm-field__input adm-field__input--credits",
    type: "text",
    inputmode: "numeric",
    placeholder: "+5 або −3",
    autocomplete: "off",
    oninput: (/** @type {Event} */ e) =>
      actions.adminField("credits", /** @type {HTMLInputElement} */ (e.target).value),
  });
  const noteInput = h("input", {
    class: "adm-field__input adm-field__input--note",
    type: "text",
    placeholder: "компенсація",
    autocomplete: "off",
    oninput: (/** @type {Event} */ e) =>
      actions.adminField("note", /** @type {HTMLInputElement} */ (e.target).value),
  });
  const noteCount = h("span", { class: "adm-field__count" });
  const preview = h("span", { class: "adm-adjust__preview" });
  const errorEl = h("p", { class: "adm-adjust__error", role: "alert" });
  const confirmText = h("span", { class: "adm-confirm__text" });
  const confirmYes = h("button", {
    class: "btn btn--primary btn--sm",
    type: "button",
    text: "Так, списати",
    onclick: () => actions.adminAdjust(true),
  });
  const confirmNo = h("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
    text: "Скасувати",
    onclick: () => actions.adminCancelConfirm(),
  });
  const confirmBox = h(
    "div",
    { class: "adm-confirm", role: "alertdialog", "aria-labelledby": "adm-confirm-title" },
    h(
      "span",
      { class: "adm-confirm__title", id: "adm-confirm-title" },
      h("span", { class: "diamond diamond--sm", "aria-hidden": "true" }),
      "Велике списання",
    ),
    confirmText,
    h("span", { class: "adm-confirm__actions" }, confirmYes, confirmNo),
  );
  const doneEl = h("p", { class: "adm-adjust__done", role: "status" });
  const submitSpinner = h("span", { class: "spinner adm-submit__spinner", "aria-hidden": "true" });
  const submitLabel = h("span");
  const submit = h(
    "button",
    { class: "btn btn--primary adm-submit", type: "submit" },
    submitSpinner,
    submitLabel,
  );
  const adjustForm = h(
    "form",
    {
      class: "adm-adjust",
      novalidate: true,
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void actions.adminAdjust();
      },
    },
    h("span", { class: "adm-adjust__title", text: "Ручне коригування" }),
    h(
      "div",
      { class: "adm-adjust__fields" },
      h("label", { class: "adm-field" }, h("span", { class: "label-s", text: "Кредити" }), creditsInput),
      h(
        "label",
        { class: "adm-field" },
        h("span", { class: "label-s adm-field__label" }, "Примітка", noteCount),
        noteInput,
      ),
    ),
    preview,
    errorEl,
    confirmBox,
    doneEl,
    submit,
    h("span", {
      class: "adm-adjust__rule",
      text: "Підтвердження — для списання від 20 кредитів або більше половини балансу.",
    }),
  );

  const opsList = h("div", { class: "adm-ops__list" });
  const details = h(
    "div",
    { class: "adm-panel__details" },
    h("div", { class: "adm-panel__who" }, selRole, selName, selEmail, selMeta),
    h("span", { class: "adm-balance" }, selBal, selWord),
    adjustForm,
    h(
      "div",
      { class: "adm-ops" },
      h("span", { class: "label-s adm-ops__title", text: "Останні операції" }),
      opsList,
    ),
  );
  const panel = h("aside", { class: "adm-panel", "aria-label": "Користувач" }, noSel, details);

  const body = h("div", { class: "adm-body" }, main, panel);
  const root = h("div", { class: "adm" }, head, body);
  el.append(root);

  // ───────────── Рядки за id ─────────────

  /** @type {Map<string, { el: HTMLButtonElement, set(u: UserRow, on: boolean): void }>} */
  const userRows = new Map();

  /** @param {string} id */
  function userRow(id) {
    const email = h("span", { class: "adm-urow__email-text" });
    const adminTag = h("span", { class: "adm-urow__admin", text: "адмін" });
    const name = h("span", { class: "adm-urow__name", role: "cell" });
    const actDot = h("span", { class: "dot dot--sm adm-urow__dot", "aria-hidden": "true" });
    const actText = h("span");
    const act = h("span", { class: "adm-urow__act", role: "cell" }, actDot, actText);
    const created = h("span", { class: "adm-urow__created", role: "cell" });
    const bal = h("span", { class: "adm-urow__bal adm-num", role: "cell" });
    const row = h(
      "button",
      {
        class: "adm-urow adm-urow--user",
        type: "button",
        role: "row",
        onclick: () => actions.adminSelect(id),
      },
      h("span", { class: "adm-urow__email", role: "cell" }, email, adminTag),
      name,
      act,
      created,
      bal,
    );
    row.dataset.id = id;
    return {
      el: row,
      /** @param {UserRow} u @param {boolean} on */
      set(u, on) {
        text(email, u.email);
        email.title = u.email;
        adminTag.hidden = !u.isAdmin;
        text(name, u.name);
        text(actText, u.activatedAt ? formatDate(u.activatedAt) : "не активовано");
        toggle(act, "adm-urow__act--none", !u.activatedAt);
        text(created, formatDate(u.createdAt));
        text(bal, formatNumber(u.balance));
        row.setAttribute("aria-selected", String(on));
        toggle(row, "is-on", on);
      },
    };
  }

  /** @type {Map<string, { el: HTMLElement, set(m: OutboxMail, copied: boolean): void }>} */
  const mailRows = new Map();

  /** @param {OutboxMail} mail */
  function mailRow(mail) {
    const at = h("span", { class: "adm-mail__at" });
    const subject = h("span", { class: "adm-mail__subject" });
    const kind = h("span", { class: "adm-mail__kind" });
    const to = h("span", { class: "adm-mail__to" });
    const link = h("span", { class: "adm-mail__link" });
    const copy = h("button", {
      class: "btn btn--tag adm-tag",
      type: "button",
      onclick: () => actions.adminCopy(mail.id),
    });
    let href = mail.link;
    const open = h("button", {
      class: "btn btn--tag adm-tag",
      type: "button",
      text: "Відкрити ↗",
      onclick: () => globalThis.open?.(href, "_blank", "noopener"),
    });
    const row = h(
      "div",
      { class: "adm-mail" },
      at,
      h("span", { class: "adm-mail__head" }, subject, h("span", { class: "adm-mail__line" }, kind, to)),
      link,
      h("span", { class: "adm-mail__actions" }, copy, open),
    );
    return {
      el: row,
      /** @param {OutboxMail} m @param {boolean} copied */
      set(m, copied) {
        href = m.link;
        text(at, formatDayTime(m.at));
        text(subject, m.subject);
        text(kind, MAIL_KIND[m.kind] ?? m.kind);
        text(to, m.to);
        text(link, m.link);
        link.title = m.link;
        text(copy, copied ? "✓ Скопійовано" : "Копіювати");
        toggle(copy, "adm-tag--on", copied);
      },
    };
  }

  /**
   * Тримає дітей `parent` у порядку `els`, не чіпаючи DOM, якщо порядок той самий.
   * @param {HTMLElement} parent
   * @param {HTMLElement[]} els
   */
  function syncChildren(parent, els) {
    const same = parent.children.length === els.length && els.every((e, i) => parent.children[i] === e);
    if (!same) parent.replaceChildren(...els);
  }

  // ───────────── Рендер ─────────────

  /** @type {ViewHandle | null} */
  let forbidden = null;
  /** @type {ViewHandle | null} */
  let usage = null;
  /** id записів, які вже показано в панелі — новий зверху з’являється з fade. */
  let shownOps = /** @type {{ userId: string | null, ids: Set<string> }} */ ({
    userId: null,
    ids: new Set(),
  });

  /** @param {UiState} state */
  function renderUsers(state) {
    const a = state.admin;
    const list = filterUsers(a.users, a.q);
    if (search.value !== a.q) search.value = a.q;
    text(usersCount, `${list.length} з ${a.users.length}`);
    usersEmpty.hidden = list.length > 0;
    text(
      usersEmpty,
      a.users.length === 0 ? "Користувачів ще немає." : `Нікого не знайдено за «${a.q.trim()}».`,
    );
    const ids = new Set(list.map((u) => u.id));
    for (const id of [...userRows.keys()]) if (!ids.has(id)) userRows.delete(id);
    const els = list.map((u) => {
      let r = userRows.get(u.id);
      if (!r) {
        r = userRow(u.id);
        userRows.set(u.id, r);
      }
      r.set(u, u.id === a.selectedId);
      return r.el;
    });
    syncChildren(usersBody, els);
  }

  /** @param {UiState} state */
  function renderOutbox(state) {
    const a = state.admin;
    outboxEmpty.hidden = a.outbox.length > 0;
    outboxBody.hidden = a.outbox.length === 0;
    const ids = new Set(a.outbox.map((m) => m.id));
    for (const id of [...mailRows.keys()]) if (!ids.has(id)) mailRows.delete(id);
    const els = a.outbox.map((m) => {
      let r = mailRows.get(m.id);
      if (!r) {
        r = mailRow(m);
        mailRows.set(m.id, r);
      }
      r.set(m, a.copied === m.id);
      return r.el;
    });
    syncChildren(outboxBody, els);
  }

  /** @param {UiState} state */
  function renderAll(state) {
    const { users, allProjects } = state.admin;
    const owners = new Map(users.map((u) => [u.id, u.email]));
    clear(allBody);
    for (const p of allProjects) {
      const owner = p.ownerId ? (owners.get(p.ownerId) ?? p.ownerId) : null;
      const kind = statusKind(p.status);
      const host = p.site ? hostOf(p.site) : "Без сайту";
      allBody.append(
        h(
          "div",
          { class: "adm-prow", role: "row" },
          h("span", { class: "adm-prow__title", role: "cell", title: host, text: host }),
          h("span", {
            class: `adm-prow__owner${owner ? "" : " adm-prow__owner--none"}`,
            role: "cell",
            text: owner ?? "без власника · eval/CLI",
          }),
          h(
            "span",
            { class: `adm-prow__status adm-prow__status--${kind}`, role: "cell" },
            h("span", { class: "dot adm-prow__dot", "aria-hidden": "true" }),
            STATUS_LABELS[p.status] ?? p.status,
          ),
          h("span", {
            class: "adm-prow__fmts",
            role: "cell",
            text: p.formats.map((f) => FORMAT_LABELS[f]).join(" · "),
          }),
          h("span", { class: "adm-prow__date", role: "cell", text: formatDay(p.createdAt) }),
          h("span", { class: "adm-prow__usd adm-num", role: "cell", text: formatUsd(p.totalUsd) }),
        ),
      );
    }
  }

  /** @param {UiState} state @param {ReturnType<typeof selection>} sel */
  function renderOps(state, sel) {
    const packages = state.account.me?.packages ?? [];
    const entries = sel ? sel.entries.slice(0, PANEL_ENTRIES) : [];
    const userId = sel?.user.id ?? null;
    const fresh = shownOps.userId === userId ? shownOps.ids : null;
    clear(opsList);
    for (const e of entries) {
      const sub = entrySub(e, state.admin.allProjects);
      opsList.append(
        h(
          "div",
          { class: `adm-op${fresh && !fresh.has(e.id) ? " adm-op--fresh" : ""}` },
          h(
            "span",
            { class: "adm-op__main" },
            h("span", { class: "adm-op__label", text: entryLabel(e, packages) }),
            h("span", {
              class: "adm-op__meta",
              text: sub ? `${formatDayTime(e.at)} · ${sub}` : formatDayTime(e.at),
            }),
          ),
          h(
            "span",
            { class: "adm-op__sums" },
            h("b", { class: "adm-op__sum", text: signed(e.credits) }),
            h("span", { class: "adm-op__after", text: `→ ${formatNumber(e.balanceAfter)}` }),
          ),
        ),
      );
    }
    shownOps = { userId, ids: new Set(entries.map((e) => e.id)) };
  }

  /** @param {UiState} state @param {ReturnType<typeof selection>} sel */
  function renderAdjust(state, sel) {
    const { adjust } = state.admin;
    if (creditsInput.value !== adjust.credits) creditsInput.value = adjust.credits;
    if (noteInput.value !== adjust.note) noteInput.value = adjust.note;
    const n = parseCredits(adjust.credits);
    const balance = sel?.balance ?? 0;
    const err = adjust.error;
    const creditsBad = err === "zero" || (!!err && typeof err === "object");
    creditsInput.setAttribute("aria-invalid", String(creditsBad));
    noteInput.setAttribute("aria-invalid", String(err === "note"));
    toggle(creditsInput, "is-invalid", creditsBad);
    toggle(noteInput, "is-invalid", err === "note");
    text(noteCount, `${adjust.note.length}/${NOTE_MAX}`);
    toggle(noteCount, "is-over", adjust.note.length > NOTE_MAX);

    preview.hidden = n === null || !!err || !!adjust.done;
    if (n !== null) text(preview, previewText(balance, n));
    errorEl.hidden = !err;
    text(errorEl, errorText(err));

    const hadFocus = confirmBox.contains(document.activeElement);
    const showConfirm = adjust.confirm && n !== null && needsConfirm(n, balance);
    confirmBox.hidden = !showConfirm;
    if (n !== null)
      text(
        confirmText,
        `Списати ${formatCredits(-n)} у ${sel?.user.email ?? ""}? Баланс стане ${formatNumber(Math.max(0, balance + n))}.`,
      );
    doneEl.hidden = !adjust.done;
    text(doneEl, adjust.done ? doneText(adjust.done) : "");

    submit.hidden = showConfirm;
    submit.disabled = adjust.busy;
    submit.setAttribute("aria-busy", String(adjust.busy));
    submitSpinner.hidden = !adjust.busy;
    text(submitLabel, n !== null && n < 0 ? "Списати" : "Нарахувати");
    return { showConfirm, hadFocus };
  }

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    const a = state.admin;
    const p = prev?.admin;

    // 403: екран B12 замість адмінки.
    if (a.forbidden && !forbidden) forbidden = mountForbidden(forbiddenEl, ctx);
    else if (!a.forbidden && forbidden) {
      forbidden.destroy();
      forbidden = null;
      clear(forbiddenEl);
    } else if (forbidden && prev) forbidden.update(state, prev);
    forbiddenEl.hidden = !a.forbidden;
    tablist.hidden = a.forbidden;

    const showMain = !a.forbidden && !a.loading;
    const usersTab = a.tab === "users" && !a.forbidden;
    root.dataset.tab = a.tab;
    toggle(body, "adm-body--split", usersTab);
    loading.hidden = !a.loading || a.forbidden;
    usersSection.hidden = !(showMain && a.tab === "users");
    outboxSection.hidden = !(showMain && a.tab === "outbox");
    allSection.hidden = !(showMain && a.tab === "all");
    usageSection.hidden = !(showMain && a.tab === "usage");
    panel.hidden = !(usersTab && !a.loading);

    if (!usage && !usageSection.hidden) usage = mountUsage(usageSection, ctx);
    else if (usage && prev) usage.update(state, prev);

    if (
      !p ||
      a.tab !== p.tab ||
      a.users !== p.users ||
      a.outbox !== p.outbox ||
      a.allProjects !== p.allProjects
    ) {
      /** @type {Record<AdminState["tab"], number>} */
      const counts = {
        users: a.users.length,
        outbox: a.outbox.length,
        all: a.allProjects.length,
        usage: 0,
      };
      for (const t of tabs) {
        const on = t.tab === a.tab;
        t.btn.setAttribute("aria-selected", String(on));
        t.btn.tabIndex = on ? 0 : -1;
        toggle(t.btn, "is-on", on);
        text(t.count, counts[t.tab]);
      }
    }

    if (!p || a.users !== p.users || a.q !== p.q || a.selectedId !== p.selectedId) renderUsers(state);
    if (!p || a.outbox !== p.outbox || a.copied !== p.copied) renderOutbox(state);
    if (!p || a.allProjects !== p.allProjects || a.users !== p.users) renderAll(state);

    const sel = selection(a);
    noSel.hidden = !!sel;
    details.hidden = !sel;
    if (sel) {
      text(selRole, sel.user.isAdmin ? "адміністратор" : "клієнт");
      text(selName, sel.user.name);
      text(selEmail, sel.user.email);
      const act = sel.user.activatedAt ? `активовано ${formatDate(sel.user.activatedAt)}` : "не активовано";
      text(selMeta, `створено ${formatDate(sel.user.createdAt)} · ${act}`);
      text(selBal, formatNumber(sel.balance));
      text(selWord, creditWord(sel.balance));
    }
    if (
      !p ||
      a.selected !== p.selected ||
      a.selectedId !== p.selectedId ||
      a.users !== p.users ||
      a.allProjects !== p.allProjects ||
      state.account.me !== prev?.account.me
    )
      renderOps(state, sel);

    // Підтвердження підміняє кнопку відправки: фокус — на «Так, списати», після — назад на кнопку.
    const { showConfirm, hadFocus } = renderAdjust(state, sel);
    if (showConfirm && p && !p.adjust.confirm) confirmYes.focus();
    else if (!showConfirm && hadFocus) submit.focus();
  }

  render(ctx.store.getState(), null);

  return {
    update(state, prev) {
      render(state, prev);
    },
    destroy() {
      if (forbidden) forbidden.destroy();
      forbidden = null;
      if (usage) usage.destroy();
      usage = null;
      root.remove();
    },
  };
}
