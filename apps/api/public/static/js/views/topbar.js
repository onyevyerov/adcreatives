// @ts-check
/**
 * B3 · Топбар (C2, N4-B): вордмарк → новий проєкт, «/», хост-слот (project — хост, cabinet —
 * «Кабінет», admin — «Адмінка»); праворуч статус (лише project), пілюля балансу, «Новий проєкт»,
 * коло акаунта (account-controls.js). «Витрачено $» — лише адміну.
 * DOM будується один раз, `update` патчить змінене.
 */
import { AWAITING, BUSY, STATUS_LABELS } from "../contracts.js";
import { h, text } from "../dom.js";
import * as accountControls from "./account-controls.js";

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

/** Підпис хост-слота поза проєктом. @type {Partial<Record<UiState["route"], string>>} */
const HOST_SLOT = { cabinet: "Кабінет", admin: "Адмінка" };

/**
 * Текст хост-слота: на project — хост сайту, у кабінеті й адмінці — назва розділу.
 * @param {UiState} state
 */
export function hostSlot(state) {
  return state.route === "project" ? (state.site ?? "") : (HOST_SLOT[state.route] ?? "");
}

/** @param {UiState} state */
const isAdmin = (state) => state.account.meStatus === "ready" && !!state.account.me?.user.isAdmin;

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
  const cost = h("span", { class: "tb-cost mono" }, "Витрачено ", sum);
  const acct = h("div", { class: "tb-acct" });

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
    h("div", { class: "tb-right" }, status, cost, acct),
  );
  el.append(root);
  // «Новий проєкт» — у слот контролів, між пілюлею і колом (порядок Tab = видимий).
  const account = accountControls.mount(acct, ctx, { place: "page" });
  const newBtn = h("button", {
    class: "btn btn--ghost tb-new",
    type: "button",
    onclick: onNew,
    text: "Новий проєкт",
  });
  (acct.querySelector(".ac-slot") ?? acct).append(newBtn);

  /** @param {UiState} state @param {UiState | null} prev */
  function render(state, prev) {
    if (!prev || state.site !== prev.site || state.route !== prev.route) {
      const slot = hostSlot(state);
      text(host, slot);
      if (slot && state.route === "project") host.setAttribute("title", slot);
      else host.removeAttribute("title");
      host.hidden = !slot;
      sep.hidden = !slot;
      status.hidden = state.route !== "project";
    }
    if (!prev || state.account !== prev.account) {
      cost.hidden = !isAdmin(state);
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
    update(state, prev) {
      render(state, prev);
      account.update(state, prev);
    },
    destroy() {
      account.destroy();
      root.remove();
    },
  };
}
