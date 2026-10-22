// @ts-check
/**
 * B4 · Вкладка «Використання» адмінки (`?admin=usage`). Зверху вниз: фільтр (пресети періоду,
 * свої дати, джерело, «Дати — UTC»), шість карток підсумків, користувачі з розгортанням у
 * проєкти й далі в розбивку по моделях і етапах (останній рядок — «Система»), усі проєкти з
 * пошуком, пагінацією й CSV, розбивки по моделях і по етапах.
 * Стан — лише `state.admin.usage`, дії — лише `ctx.actions.usage*`. Монтує views/admin.js при
 * першому показі вкладки. DOM будується один раз, `update` патчить змінене: рядки таблиць — за id
 * (розгортання вставляє рядок, не чіпаючи сусідів), поля пошуку й дат не перезаписуються під
 * фокусом. `formatDate` з views/admin.js — лише всередині функцій (циклічний імпорт).
 */
import { STATUS_LABELS } from "../contracts.js";
import { adminUsageCsvHref } from "../data/account-api.js";
import { clear, h, text } from "../dom.js";
import { formatNumber } from "../lib/credits.js";
import { USAGE_PRESETS, usageQuery } from "../lib/usage.js";
import { formatDate } from "./admin.js";
import { stageLabel } from "./done.js";
import { formatUsd, statusKind } from "./topbar.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {import("../contracts.js").UsageState} UsageState */
/** @typedef {import("../contracts.js").UsagePreset} UsagePreset */
/** @typedef {import("../contracts.js").UsageSource} UsageSource */
/** @typedef {import("../contracts.js").UsageSort} UsageSort */
/** @typedef {import("../contracts.js").UsageSummary} UsageSummary */
/** @typedef {import("../contracts.js").UsageUserRow} UsageUserRow */
/** @typedef {import("../contracts.js").UsageProjectRow} UsageProjectRow */
/** @typedef {import("../contracts.js").UsageProjectsTable} UsageProjectsTable */
/** @typedef {import("../contracts.js").UsageModelRow} UsageModelRow */
/** @typedef {import("../contracts.js").UsageStageRow} UsageStageRow */
/** Колонка таблиці: `key` — ключ сортування бекенду (без нього колонка не сортується). @typedef {{ label: string, key?: string, num?: boolean }} Col */

const MINUS = "−";
const NBSP = " ";
export const DASH = "—";

/** @type {Record<UsagePreset, string>} */
export const PRESET_LABELS = {
  "7d": "7 днів",
  "30d": "30 днів",
  month: "Цей місяць",
  all: "Увесь час",
  custom: "Свій",
};

/** @type {readonly { source: UsageSource, label: string }[]} */
export const SOURCES = [
  { source: "chat", label: "Клієнти" },
  { source: "eval", label: "Eval" },
  { source: "test", label: "Тести" },
  { source: "all", label: "Усе" },
];

/** Невідомий провайдер показується як є. @type {Record<string, string>} */
export const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  elevenlabs: "ElevenLabs",
  remotion: "Remotion",
  epidemic: "Epidemic",
};

export const RANGE_ERROR = "Дата «До» раніша за «Від».";
export const SYSTEM_LABEL = "Система (без власника й спільні)";
export const NO_SITE = "Без сайту";
export const CREDITS_HINT = "оцінка за списаннями, бонусні кредити теж враховано";

/** «$2.41», «−$3.20»; `null` → «—». @param {number | null | undefined} usd */
export function money(usd) {
  if (usd === null || usd === undefined) return DASH;
  return usd < 0 ? `${MINUS}${formatUsd(-usd)}` : formatUsd(usd);
}

/** Ціле з пробілами тисяч; `null` → «—». @param {number | null | undefined} n */
export function count(n) {
  return n === null || n === undefined ? DASH : formatNumber(n);
}

/** Токени коротко: «8 400», «12,3 тис.», «245 тис.», «1,2 млн». @param {number} n */
export function compact(n) {
  if (Math.abs(n) < 10_000) return formatNumber(n);
  const [v, unit] = Math.abs(n) < 1e6 ? [n / 1e3, "тис."] : [n / 1e6, "млн"];
  const s = Math.abs(v) >= 100 ? formatNumber(v) : v.toFixed(1).replace(/\.0$/, "").replace(".", ",");
  return `${s}${NBSP}${unit}`;
}

/** Частка від загальних витрат: «42 %», «<1 %»; без загальних — «—». @param {number} usd @param {number} total */
export function share(usd, total) {
  if (!(total > 0)) return DASH;
  const pct = Math.round((usd / total) * 100);
  return pct < 1 && usd > 0 ? `<1${NBSP}%` : `${pct}${NBSP}%`;
}

/** Пагінація: «26–50 з 60». @param {number} page @param {number} pageSize @param {number} total */
export function pageText(page, pageSize, total) {
  const from = Math.min((page - 1) * pageSize + 1, total);
  const to = Math.min(page * pageSize, total);
  return `${formatNumber(from)}–${formatNumber(to)} з ${formatNumber(total)}`;
}

/**
 * Тримає дітей `parent` у порядку `els` мінімумом рухів: спершу прибирає зайвих, потім вставляє
 * відсутніх на місце. Розгортання / згортання рядка не переставляє сусідів (фокус не губиться).
 * @param {HTMLElement} parent
 * @param {HTMLElement[]} els
 */
export function syncChildren(parent, els) {
  const keep = new Set(els);
  for (const c of [...parent.children]) if (!keep.has(/** @type {HTMLElement} */ (c))) c.remove();
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
}

/** @param {Element} el @param {string} name @param {boolean} on */
const toggle = (el, name, on) => el.classList.toggle(name, on);

/** Комірка `<td>`; `num` — праворуч, табличні цифри. @param {string} cls @param {boolean} [num] */
const cell = (cls, num = false) => h("td", { class: num ? `${cls} adu-num` : cls });

/**
 * Рядок заголовків; сортовані колонки — кнопки, активна — `aria-sort` на `th` і стрілка.
 * @param {readonly Col[]} cols
 * @param {(key: string) => void} [onSort]
 */
function headRow(cols, onSort) {
  /** @type {{ th: HTMLElement, btn: HTMLElement, arrow: HTMLElement, key: string }[]} */
  const sortable = [];
  const ths = cols.map((c) => {
    const cls = c.num ? "adu-th adu-num" : "adu-th";
    const key = c.key;
    if (!key || !onSort) return h("th", { class: cls, scope: "col", text: c.label });
    const arrow = h("span", { class: "adu-sort__arrow", "aria-hidden": "true" });
    const btn = h(
      "button",
      { class: "adu-sort", type: "button", onclick: () => onSort(key) },
      c.label,
      arrow,
    );
    const th = h("th", { class: cls, scope: "col" }, btn);
    th.dataset.sort = key;
    sortable.push({ th, btn, arrow, key });
    return th;
  });
  return {
    el: h("thead", null, h("tr", null, ths)),
    /** @param {UsageSort} sort */
    set(sort) {
      for (const s of sortable) {
        const on = s.key === sort.key;
        s.th.setAttribute("aria-sort", on ? (sort.order === "asc" ? "ascending" : "descending") : "none");
        text(s.arrow, on ? (sort.order === "asc" ? "↑" : "↓") : "");
        toggle(s.btn, "is-on", on);
      }
    },
  };
}

/**
 * Статична таблиця (розбивки): заголовки й рядки тексту; порожньо — один рядок «—».
 * @param {HTMLElement} body
 * @param {readonly Col[]} cols
 * @param {string[][]} rows
 */
function fillRows(body, cols, rows) {
  clear(body);
  if (!rows.length) {
    body.append(h("tr", null, h("td", { class: "adu-td adu-td--none", colspan: cols.length, text: DASH })));
    return;
  }
  for (const r of rows) {
    body.append(
      h(
        "tr",
        null,
        r.map((v, i) => h("td", { class: cols[i]?.num ? "adu-td adu-num" : "adu-td", text: v })),
      ),
    );
  }
}

/** «Anthropic» · «claude-opus-5-5». @param {UsageModelRow} m */
const providerLabel = (m) => PROVIDER_LABELS[m.provider] ?? m.provider;

/** @type {readonly Col[]} */
const MINI_MODEL_COLS = [
  { label: "Модель" },
  { label: "Виклики", num: true },
  { label: "Токени", num: true },
  { label: "$", num: true },
];
/** @type {readonly Col[]} */
const MINI_STAGE_COLS = [{ label: "Етап" }, { label: "Виклики", num: true }, { label: "$", num: true }];

/** @type {readonly Col[]} */
const MODEL_COLS = [
  { label: "Провайдер" },
  { label: "Модель" },
  { label: "Виклики", num: true },
  { label: "Токени · вхід", num: true },
  { label: "Токени · вихід", num: true },
  { label: "Токени · кеш", num: true },
  { label: "Аудіо, с", num: true },
  { label: "Рендери", num: true },
  { label: "$", num: true },
  { label: "Частка", num: true },
];
/** @type {readonly Col[]} */
const STAGE_COLS = [
  { label: "Етап" },
  { label: "Виклики", num: true },
  { label: "$", num: true },
  { label: "Частка", num: true },
];

/** @type {readonly Col[]} */
const USER_COLS = [
  { label: "E-mail", key: "email" },
  { label: "Ім’я" },
  { label: "Проєкти / здано", key: "projects", num: true },
  { label: "Виклики", num: true },
  { label: "Токени", num: true },
  { label: "$ разом", key: "usd", num: true },
  { label: "Кредити", num: true },
  { label: "Маржа", key: "marginUsd", num: true },
];

/** Колонки таблиці проєктів; «Власник» — лише в «Усіх проєктах». @param {boolean} withOwner @returns {Col[]} */
const projectCols = (withOwner) => [
  { label: "Хост", key: "host" },
  ...(withOwner ? [{ label: "Власник", key: "ownerEmail" }] : []),
  { label: "Статус", key: "status" },
  { label: "Створено", key: "createdAt" },
  { label: "Виклики", key: "calls", num: true },
  { label: "Токени", key: "tokens", num: true },
  { label: "Правки", num: true },
  { label: "$ першої видачі", num: true },
  { label: "$ правок", num: true },
  { label: "$ разом", key: "usd", num: true },
];

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  // ───────────── Фільтр ─────────────

  const presetBtns = USAGE_PRESETS.map((preset) => {
    const btn = h("button", {
      class: "seg__opt adu-seg__opt",
      type: "button",
      text: PRESET_LABELS[preset],
      onclick: () => void actions.usagePreset(preset),
    });
    btn.dataset.preset = preset;
    return { preset, btn };
  });
  const presets = h(
    "div",
    { class: "seg adu-seg adu-presets", role: "group", "aria-label": "Період" },
    presetBtns.map((p) => p.btn),
  );

  const onDates = () => void actions.usageRange({ from: fromInput.value || null, to: toInput.value || null });
  const fromInput = h("input", { class: "adu-date__input", type: "date", onchange: onDates });
  const toInput = h("input", { class: "adu-date__input", type: "date", onchange: onDates });
  const dates = h(
    "div",
    { class: "adu-dates" },
    h("label", { class: "adu-date" }, h("span", { class: "label-s", text: "Від" }), fromInput),
    h("label", { class: "adu-date" }, h("span", { class: "label-s", text: "До" }), toInput),
  );
  const rangeError = h("p", { class: "adu-range-error", role: "alert", text: RANGE_ERROR });

  const sourceBtns = SOURCES.map(({ source, label }) => {
    const btn = h("button", {
      class: "seg__opt adu-seg__opt",
      type: "button",
      text: label,
      onclick: () => void actions.usageSource(source),
    });
    btn.dataset.source = source;
    return { source, btn };
  });
  const sources = h(
    "div",
    { class: "seg adu-seg adu-sources", role: "group", "aria-label": "Джерело" },
    sourceBtns.map((s) => s.btn),
  );
  const busySpin = h("span", { class: "spinner adu-filter__spin", "aria-hidden": "true" });
  const filter = h(
    "div",
    { class: "adu-filter" },
    presets,
    dates,
    sources,
    h("span", { class: "adu-filter__end" }, busySpin, h("span", { class: "adu-utc", text: "Дати — UTC" })),
    rangeError,
  );

  // ───────────── Стани ─────────────

  const loadingEl = h(
    "div",
    { class: "adu-state adu-state--loading", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    "Завантажую…",
  );
  const retry = h("button", {
    class: "btn btn--ghost btn--sm adu-retry",
    type: "button",
    text: "Повторити",
    onclick: () => void actions.usageReload(),
  });
  const errorEl = h(
    "div",
    { class: "adu-state adu-state--error", role: "alert" },
    h("span", { class: "adu-state__text", text: "Не вдалося завантажити" }),
    retry,
  );
  const emptyEl = h("p", { class: "adu-state adu-state--empty", text: "За цей період витрат немає" });

  // ───────────── Картки ─────────────

  /** @param {string} label @param {string} [hint] */
  function card(label, hint) {
    const num = h("span", { class: "adu-card__num" });
    const sub = h("span", { class: "adu-card__sub" });
    const node = h(
      "div",
      { class: "card adu-card" },
      h("span", { class: "label-s adu-card__label", text: label }),
      num,
      sub,
      hint ? h("span", { class: "adu-card__hint", text: hint }) : null,
    );
    return { el: node, num, sub };
  }
  const cSpend = card("Витрати");
  const cProjects = card("Проєкти");
  const cDelivered = card("Зданий ролик, у середньому");
  const cRevision = card("Правка, у середньому");
  const cCalls = card("Виклики й токени");
  const cCredits = card("Списано кредитів", CREDITS_HINT);
  const cards = h(
    "div",
    { class: "adu-cards" },
    [cSpend, cProjects, cDelivered, cRevision, cCalls, cCredits].map((c) => c.el),
  );

  // ───────────── Таблиця проєктів (користувача й усі) ─────────────

  /** @param {number} colspan */
  function projectDetail(colspan) {
    const meta = h("p", { class: "adu-detail__meta" });
    const modelsBody = h("tbody");
    const stagesBody = h("tbody");
    const node = h(
      "tr",
      { class: "adu-detail" },
      h(
        "td",
        { class: "adu-detail__cell", colspan },
        h(
          "div",
          { class: "adu-detail__inner" },
          meta,
          h(
            "div",
            { class: "adu-detail__grid" },
            h(
              "div",
              { class: "adu-mini" },
              h("span", { class: "label-s adu-mini__title", text: "По моделях" }),
              h("table", { class: "adu-table adu-table--mini" }, headRow(MINI_MODEL_COLS).el, modelsBody),
            ),
            h(
              "div",
              { class: "adu-mini" },
              h("span", { class: "label-s adu-mini__title", text: "По етапах" }),
              h("table", { class: "adu-table adu-table--mini" }, headRow(MINI_STAGE_COLS).el, stagesBody),
            ),
          ),
        ),
      ),
    );
    /** @type {UsageProjectRow | null} */
    let last = null;
    return {
      el: node,
      /** @param {UsageProjectRow} p */
      set(p) {
        if (p === last) return;
        last = p;
        const parts = [p.projectId];
        if (p.url) parts.push(p.url);
        parts.push(p.firstDeliveredAt ? `здано ${formatDate(p.firstDeliveredAt)}` : "не здано");
        if (p.audioSeconds > 0) parts.push(`аудіо ${formatNumber(p.audioSeconds)} с`);
        if (p.renders > 0) parts.push(`рендерів ${formatNumber(p.renders)}`);
        text(meta, parts.join(" · "));
        fillRows(
          modelsBody,
          MINI_MODEL_COLS,
          p.byModel.map((m) => [
            `${providerLabel(m)} · ${m.model}`,
            formatNumber(m.calls),
            m.tokens.total ? compact(m.tokens.total) : DASH,
            money(m.usd),
          ]),
        );
        fillRows(
          stagesBody,
          MINI_STAGE_COLS,
          p.byStage.map((s) => [stageLabel(s.stage), formatNumber(s.calls), money(s.usd)]),
        );
      },
    };
  }

  /** @param {string} id @param {boolean} withOwner */
  function projectRow(id, withOwner) {
    const host = h("span", { class: "adu-host" });
    const expand = h(
      "button",
      { class: "adu-expand", type: "button" },
      h("span", { class: "adu-chev", "aria-hidden": "true" }),
      host,
    );
    const ownerText = h("span", { class: "adu-owner__text" });
    const owner = withOwner ? h("td", { class: "adu-owner" }, ownerText) : null;
    const dot = h("span", { class: "dot adu-status__dot", "aria-hidden": "true" });
    const statusText = h("span");
    const status = h("td", { class: "adu-status" }, dot, statusText);
    const created = cell("adu-date");
    const calls = cell("adu-calls", true);
    const tokens = cell("adu-tokens", true);
    const revisions = cell("adu-revisions", true);
    const first = cell("adu-first", true);
    const revUsd = cell("adu-revusd", true);
    const usd = cell("adu-usd", true);
    const row = h(
      "tr",
      { class: "adu-row adu-row--project", onclick: () => actions.usageToggleProject(id) },
      h("td", { class: "adu-lead" }, expand),
      owner,
      status,
      created,
      calls,
      tokens,
      revisions,
      first,
      revUsd,
      usd,
    );
    row.dataset.id = id;
    return {
      el: row,
      /** @param {UsageProjectRow} p @param {boolean} open */
      set(p, open) {
        text(host, p.host ?? NO_SITE);
        host.title = p.url ?? "";
        toggle(host, "adu-host--none", !p.host);
        expand.setAttribute("aria-expanded", String(open));
        toggle(row, "is-open", open);
        if (owner) {
          text(ownerText, p.ownerEmail ?? "без власника");
          ownerText.title = p.ownerEmail ?? "";
          toggle(owner, "adu-owner--none", !p.ownerEmail);
        }
        status.className = `adu-status adu-status--${p.status ? statusKind(p.status) : "none"}`;
        dot.hidden = !p.status;
        text(statusText, p.status ? (STATUS_LABELS[p.status] ?? p.status) : DASH);
        text(created, p.createdAt ? formatDate(p.createdAt) || DASH : DASH);
        text(calls, formatNumber(p.calls));
        text(tokens, compact(p.tokens.total));
        tokens.title = `${formatNumber(p.tokens.total)} токенів`;
        text(revisions, formatNumber(p.revisions));
        text(first, money(p.firstDeliveryUsd));
        text(revUsd, money(p.revisionUsd));
        text(usd, money(p.usd));
      },
    };
  }

  /** @param {"user" | "all"} table */
  function projectsTable(table) {
    const withOwner = table === "all";
    const cols = projectCols(withOwner);
    const head = headRow(cols, (key) => void actions.usageProjects(table, { sort: key }));
    const body = h("tbody");
    const note = h("p", { class: "adu-note" });
    let page = 1;
    const prevBtn = h("button", {
      class: "btn btn--ghost btn--sm adu-pager__btn adu-pager__prev",
      type: "button",
      text: "← Назад",
      onclick: () => void actions.usageProjects(table, { page: page - 1 }),
    });
    const nextBtn = h("button", {
      class: "btn btn--ghost btn--sm adu-pager__btn adu-pager__next",
      type: "button",
      text: "Далі →",
      onclick: () => void actions.usageProjects(table, { page: page + 1 }),
    });
    const range = h("span", { class: "adu-pager__range" });
    const pager = h("div", { class: "adu-pager" }, prevBtn, range, nextBtn);
    const node = h(
      "div",
      { class: `adu-ptable adu-ptable--${table}` },
      h(
        "div",
        { class: "adu-scroll" },
        h(
          "table",
          { class: "adu-table", "aria-label": withOwner ? "Усі проєкти" : "Проєкти користувача" },
          head.el,
          body,
        ),
      ),
      note,
      pager,
    );

    /** @type {Map<string, ReturnType<typeof projectRow>>} */
    const rows = new Map();
    /** @type {Map<string, ReturnType<typeof projectDetail>>} */
    const details = new Map();

    return {
      el: node,
      /** @param {UsageProjectsTable} t @param {string | null} expandedId */
      update(t, expandedId) {
        head.set(t.sort);
        const data = t.data;
        const items = data?.items ?? [];
        toggle(node, "is-busy", t.loading && !!data);
        node.setAttribute("aria-busy", String(t.loading));

        const q = t.q.trim();
        let msg = "";
        if (!data) msg = t.loading ? "Завантажую…" : "";
        else if (!items.length) msg = q ? `Нічого не знайдено за «${q}».` : "Проєктів немає.";
        text(note, msg);
        note.hidden = !msg;

        const ids = new Set(items.map((p) => p.projectId));
        for (const id of [...rows.keys()]) {
          if (ids.has(id)) continue;
          rows.delete(id);
          details.delete(id);
        }
        /** @type {HTMLElement[]} */
        const els = [];
        for (const p of items) {
          let r = rows.get(p.projectId);
          if (!r) {
            r = projectRow(p.projectId, withOwner);
            rows.set(p.projectId, r);
          }
          const open = expandedId === p.projectId;
          r.set(p, open);
          els.push(r.el);
          if (!open) continue;
          let d = details.get(p.projectId);
          if (!d) {
            d = projectDetail(cols.length);
            details.set(p.projectId, d);
          }
          d.set(p);
          els.push(d.el);
        }
        syncChildren(body, els);

        pager.hidden = !data || data.total === 0;
        if (data) {
          page = data.page;
          text(range, pageText(data.page, data.pageSize, data.total));
          prevBtn.disabled = data.page <= 1;
          nextBtn.disabled = data.page * data.pageSize >= data.total;
        }
      },
    };
  }

  // ───────────── Користувачі ─────────────

  const usersHead = headRow(USER_COLS, (key) => void actions.usageSortUsers(key));
  const usersBody = h("tbody");
  const userProjects = projectsTable("user");
  const subTitle = h("span", { class: "label-s adu-sub__title" });
  const userSub = h(
    "tr",
    { class: "adu-sub" },
    h(
      "td",
      { class: "adu-sub__cell", colspan: USER_COLS.length },
      h("div", { class: "adu-sub__inner" }, subTitle, userProjects.el),
    ),
  );

  const sysCalls = cell("adu-calls", true);
  const sysTokens = cell("adu-tokens", true);
  const sysUsd = cell("adu-usd", true);
  const sysRow = h(
    "tr",
    { class: "adu-row adu-row--system" },
    h("td", { class: "adu-system", colspan: 2, text: SYSTEM_LABEL }),
    h("td", { class: "adu-num", text: DASH }),
    sysCalls,
    sysTokens,
    sysUsd,
    h("td", { class: "adu-num", text: DASH }),
    h("td", { class: "adu-num", text: DASH }),
  );

  /** @param {string} id */
  function userRow(id) {
    const email = h("span", { class: "adu-email" });
    const expand = h(
      "button",
      { class: "adu-expand", type: "button" },
      h("span", { class: "adu-chev", "aria-hidden": "true" }),
      email,
    );
    const name = cell("adu-name");
    const projects = cell("adu-projects", true);
    const calls = cell("adu-calls", true);
    const tokens = cell("adu-tokens", true);
    const usd = cell("adu-usd", true);
    const credits = cell("adu-credits", true);
    const margin = cell("adu-margin", true);
    const row = h(
      "tr",
      { class: "adu-row adu-row--user", onclick: () => void actions.usageToggleUser(id) },
      h("td", { class: "adu-lead" }, expand),
      name,
      projects,
      calls,
      tokens,
      usd,
      credits,
      margin,
    );
    row.dataset.id = id;
    return {
      el: row,
      /** @param {UsageUserRow} u @param {boolean} open */
      set(u, open) {
        text(email, u.email);
        email.title = u.email;
        expand.setAttribute("aria-expanded", String(open));
        toggle(row, "is-open", open);
        toggle(row, "is-idle", u.calls === 0);
        text(name, u.name);
        text(projects, `${formatNumber(u.projects)} / ${formatNumber(u.delivered)}`);
        text(calls, formatNumber(u.calls));
        text(tokens, compact(u.tokens.total));
        tokens.title = `${formatNumber(u.tokens.total)} токенів`;
        text(usd, money(u.usd));
        text(credits, count(u.creditsCharged));
        text(margin, money(u.marginUsd));
        toggle(margin, "adu-neg", (u.marginUsd ?? 0) < 0);
      },
    };
  }
  /** @type {Map<string, ReturnType<typeof userRow>>} */
  const userRows = new Map();

  const usersSection = h(
    "section",
    { class: "adu-section adu-users", "aria-label": "Користувачі" },
    h("h2", { class: "adu-h2", text: "Користувачі" }),
    h(
      "div",
      { class: "adu-scroll" },
      h(
        "table",
        { class: "adu-table adu-table--users", "aria-label": "Користувачі" },
        usersHead.el,
        usersBody,
      ),
    ),
  );

  // ───────────── Усі проєкти ─────────────

  const search = h("input", {
    class: "adu-search__input",
    type: "search",
    placeholder: "Пошук за хостом або e-mail",
    autocomplete: "off",
    oninput: (/** @type {Event} */ e) =>
      void actions.usageProjects("all", { q: /** @type {HTMLInputElement} */ (e.target).value }),
  });
  const csv = h("a", { class: "btn btn--ghost btn--sm adu-csv", download: true, text: "CSV ↓" });
  const allTable = projectsTable("all");
  const allSection = h(
    "section",
    { class: "adu-section adu-all", "aria-label": "Усі проєкти" },
    h(
      "div",
      { class: "adu-section__head" },
      h("h2", { class: "adu-h2", text: "Усі проєкти" }),
      h(
        "label",
        { class: "adu-search" },
        h("span", { class: "sr-only", text: "Пошук за хостом або e-mail" }),
        search,
      ),
      csv,
    ),
    allTable.el,
  );

  // ───────────── Розбивки ─────────────

  const modelsBody = h("tbody");
  const modelsSection = h(
    "section",
    { class: "adu-section adu-models", "aria-label": "По моделях і API" },
    h("h2", { class: "adu-h2", text: "По моделях і API" }),
    h(
      "div",
      { class: "adu-scroll" },
      h("table", { class: "adu-table adu-table--models" }, headRow(MODEL_COLS).el, modelsBody),
    ),
  );
  const stagesBody = h("tbody");
  const stagesSection = h(
    "section",
    { class: "adu-section adu-stages", "aria-label": "По етапах" },
    h("h2", { class: "adu-h2", text: "По етапах" }),
    h(
      "div",
      { class: "adu-scroll" },
      h("table", { class: "adu-table adu-table--stages" }, headRow(STAGE_COLS).el, stagesBody),
    ),
  );

  const content = h(
    "div",
    { class: "adu-content" },
    cards,
    usersSection,
    allSection,
    h("div", { class: "adu-breakdowns" }, modelsSection, stagesSection),
  );
  const root = h("div", { class: "adu" }, filter, loadingEl, errorEl, emptyEl, content);
  el.append(root);

  // ───────────── Рендер ─────────────

  /** @param {UsageState} u @param {UsageState | null} p */
  function renderFilter(u, p) {
    if (!p || u.preset !== p.preset) {
      for (const { preset, btn } of presetBtns) {
        btn.setAttribute("aria-pressed", String(preset === u.preset));
        toggle(btn, "is-on", preset === u.preset);
      }
    }
    dates.hidden = u.preset !== "custom";
    // Поля дат — з `range` лише коли той змінився; під фокусом не перезаписуються.
    if (!p || u.range !== p.range || u.preset !== p.preset) {
      const active = document.activeElement;
      const from = u.range.from ?? "";
      const to = u.range.to ?? "";
      if (active !== fromInput && fromInput.value !== from) fromInput.value = from;
      if (active !== toInput && toInput.value !== to) toInput.value = to;
    }
    rangeError.hidden = !u.rangeError;
    fromInput.setAttribute("aria-invalid", String(u.rangeError));
    toInput.setAttribute("aria-invalid", String(u.rangeError));
    if (!p || u.source !== p.source) {
      for (const { source, btn } of sourceBtns) {
        btn.setAttribute("aria-pressed", String(source === u.source));
        toggle(btn, "is-on", source === u.source);
      }
    }
    if (document.activeElement !== search && search.value !== u.all.q) search.value = u.all.q;
    const href = adminUsageCsvHref({ ...usageQuery(u), ...(u.all.q ? { search: u.all.q } : {}) });
    if (csv.getAttribute("href") !== href) csv.setAttribute("href", href);
  }

  /** @param {UsageSummary} s */
  function renderCards(s) {
    const t = s.totals;
    text(cSpend.num, money(t.usd));
    text(cSpend.sub, `система ${money(s.system.usd)}`);
    text(cProjects.num, formatNumber(t.projects));
    text(cProjects.sub, `здано ${formatNumber(t.delivered)}`);
    text(cDelivered.num, money(t.avgUsdPerDelivered));
    text(cDelivered.sub, "перша видача, з усіма етапами");
    text(cRevision.num, money(t.avgUsdPerRevision));
    text(cRevision.sub, "одна ревізія");
    text(cCalls.num, formatNumber(t.calls));
    text(cCalls.sub, `${compact(t.tokens.total)} токенів`);
    text(cCredits.num, count(t.creditsCharged));
    text(cCredits.sub, `маржа ${money(t.marginUsd)}`);
    toggle(cCredits.sub, "adu-neg", (t.marginUsd ?? 0) < 0);
  }

  /** @param {UsageSummary} s */
  function renderBreakdowns(s) {
    const total = s.totals.usd;
    fillRows(
      modelsBody,
      MODEL_COLS,
      s.byModel.map((m) => [
        providerLabel(m),
        m.model,
        formatNumber(m.calls),
        formatNumber(m.tokens.input),
        formatNumber(m.tokens.output),
        formatNumber(m.tokens.cacheWrite + m.tokens.cacheRead),
        formatNumber(m.audioSeconds),
        formatNumber(m.renders),
        money(m.usd),
        share(m.usd, total),
      ]),
    );
    fillRows(
      stagesBody,
      STAGE_COLS,
      s.byStage.map((r) => [stageLabel(r.stage), formatNumber(r.calls), money(r.usd), share(r.usd, total)]),
    );
  }

  /** @param {UsageState} u */
  function renderUsers(u) {
    usersHead.set(u.usersSort);
    const ids = new Set(u.users.map((x) => x.id));
    for (const id of [...userRows.keys()]) if (!ids.has(id)) userRows.delete(id);
    /** @type {HTMLElement[]} */
    const els = [];
    for (const usr of u.users) {
      let r = userRows.get(usr.id);
      if (!r) {
        r = userRow(usr.id);
        userRows.set(usr.id, r);
      }
      const open = usr.id === u.expandedUserId;
      r.set(usr, open);
      els.push(r.el);
      if (open) {
        text(subTitle, `Проєкти · ${usr.email}`);
        els.push(userSub);
      }
    }
    if (u.summary) {
      const sys = u.summary.system;
      text(sysCalls, formatNumber(sys.calls));
      text(sysTokens, compact(sys.tokens.total));
      text(sysUsd, money(sys.usd));
      els.push(sysRow);
    }
    syncChildren(usersBody, els);
    if (u.expandedUserId) userProjects.update(u.userProjects, u.expandedProjectId);
  }

  /** @param {UsageState} u */
  function renderState(u) {
    const s = u.summary;
    const empty = !!s && s.totals.calls === 0;
    loadingEl.hidden = !!s || u.error;
    errorEl.hidden = !u.error;
    retry.disabled = u.loading;
    emptyEl.hidden = !empty;
    content.hidden = !s || empty;
    toggle(root, "adu--busy", u.loading && !!s);
    content.setAttribute("aria-busy", String(u.loading));
    busySpin.hidden = !(u.loading && s);
  }

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    const u = state.admin.usage;
    const p = prev ? prev.admin.usage : null;
    if (u === p) return;
    renderFilter(u, p);
    renderState(u);
    if (u.summary && (!p || u.summary !== p.summary)) {
      renderCards(u.summary);
      renderBreakdowns(u.summary);
    }
    if (
      !p ||
      u.users !== p.users ||
      u.usersSort !== p.usersSort ||
      u.expandedUserId !== p.expandedUserId ||
      u.summary !== p.summary ||
      u.userProjects !== p.userProjects ||
      u.expandedProjectId !== p.expandedProjectId
    )
      renderUsers(u);
    if (!p || u.all !== p.all || u.expandedProjectId !== p.expandedProjectId)
      allTable.update(u.all, u.expandedProjectId);
  }

  render(ctx.store.getState(), null);

  return {
    update(state, prev) {
      render(state, prev);
    },
    destroy() {
      root.remove();
    },
  };
}
