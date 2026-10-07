// @ts-check
/**
 * B3 · Топбар (C2, S2–S5): вордмарк → новий проєкт, «/», хост; праворуч статус, витрати,
 * «Новий проєкт» і посилання на статистику. DOM будується один раз, `update` патчить змінене.
 */
import { AWAITING, BUSY, STATUS_LABELS } from "../contracts.js";
import { h, text } from "../dom.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/** Вигляд індикатора статусу (C2). @typedef {"busy" | "awaiting" | "delivered" | "failed" | "idle"} StatusKind */

/**
 * @param {ProjectStatus} status
 * @returns {StatusKind}
 */
export function statusKind(status) {
  if (BUSY.includes(status)) return "busy";
  if (AWAITING.includes(status)) return "awaiting";
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  return "idle";
}

/** Крапка статусу за видом (примітиви `.dot*`). @type {Record<StatusKind, string>} */
const DOT_CLASS = {
  busy: "dot dot--accent dot--pulse",
  awaiting: "dot dot--accent",
  delivered: "dot",
  failed: "dot dot--danger",
  idle: "dot tb-dot--idle",
};

/**
 * «$X.XX».
 * @param {number} usd
 */
export function formatUsd(usd) {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}

/** Клік без модифікаторів (інакше даємо браузеру відкрити посилання як завжди). @param {MouseEvent} e */
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  /** @param {MouseEvent} e */
  const onNew = (e) => {
    if (e.currentTarget instanceof HTMLAnchorElement) {
      if (!plainClick(e)) return;
      e.preventDefault();
    }
    ctx.actions.newProject();
  };

  const host = h("span", { class: "tb-host mono" });
  const sep = h("span", { class: "tb-sep", "aria-hidden": "true", text: "/" });
  const dot = h("span", { class: DOT_CLASS.idle, "aria-hidden": "true" });
  const label = h("span", { class: "tb-status__label" });
  const status = h("span", { class: "tb-status", role: "status" }, dot, label);
  const sum = h("b", { class: "tb-cost__sum" });

  const root = h(
    "div",
    { class: "tb" },
    h(
      "div",
      { class: "tb-left" },
      h("a", { class: "wordmark wordmark--sm tb-wordmark", href: "/", onclick: onNew, text: "AdCreative" }),
      sep,
      host,
    ),
    h(
      "div",
      { class: "tb-right" },
      status,
      h("span", { class: "tb-cost mono" }, "Витрачено ", sum),
      h("button", { class: "btn btn--ghost tb-new", type: "button", onclick: onNew, text: "Новий проєкт" }),
      h("a", { class: "tb-stats", href: "/stats", text: "Статистика" }),
    ),
  );
  el.append(root);

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    if (!prev || state.site !== prev.site) {
      const site = state.site ?? "";
      text(host, site);
      if (site) host.setAttribute("title", site);
      else host.removeAttribute("title");
      host.hidden = !site;
      sep.hidden = !site;
    }
    if (!prev || state.status !== prev.status) {
      const kind = statusKind(state.status);
      status.className = `tb-status tb-status--${kind}`;
      status.dataset.status = state.status;
      dot.className = DOT_CLASS[kind];
      text(label, STATUS_LABELS[state.status] ?? state.status);
    }
    if (!prev || state.totalUsd !== prev.totalUsd) text(sum, formatUsd(state.totalUsd));
  }

  render(ctx.store.getState(), null);

  return {
    update: (state, prev) => render(state, prev),
    destroy() {
      root.remove();
    },
  };
}
