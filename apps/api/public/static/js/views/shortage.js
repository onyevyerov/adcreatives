// @ts-check
/**
 * Крок 0 · K3 — картка нестачі кредитів (Референс `#K`, кадри `#n3-402`, `#n7-fmt-short`).
 * Одна картка для старту (`size: "start"`, кнопки 40) і чату (`size: "chat"`, кнопки 34).
 * Числа — потрібно / у вас / не вистачає; тексти й дії передає викликач.
 */
import { h } from "../dom.js";
import { formatNumber } from "../lib/credits.js";

/**
 * @typedef {{ label: string, onClick(): void }} ShortageAction
 * @typedef {{
 *   title: string,
 *   need: number, have: number, size: "start" | "chat",
 *   advice: string,
 *   primary: ShortageAction,
 *   secondary?: ShortageAction
 * }} ShortageOptions
 */

/**
 * @param {string} label
 * @param {number} value
 */
const num = (label, value) =>
  h("span", { class: "sh-num" }, label, h("b", { class: "sh-num__value", text: formatNumber(value) }));

/**
 * @param {ShortageOptions} o
 * @returns {HTMLElement}
 */
export function shortageCard(o) {
  const chat = o.size === "chat";
  const btn = chat ? " btn--sm" : "";
  const primary = h(
    "button",
    { type: "button", class: `btn btn--primary${btn} sh-primary`, onclick: () => o.primary.onClick() },
    o.primary.label,
    chat ? null : h("span", { class: "btn__arrow", "aria-hidden": "true", text: "→" }),
  );
  const secondary = o.secondary
    ? h(
        "button",
        {
          type: "button",
          class: `btn btn--ghost${btn} sh-secondary`,
          onclick: () => o.secondary?.onClick(),
        },
        o.secondary.label,
      )
    : null;
  return h(
    "div",
    { class: `sh sh--${o.size}`, role: "alert" },
    h("div", { class: "sh-title" }, h("span", { class: "sh-diamond", "aria-hidden": "true" }), o.title),
    h(
      "div",
      { class: "sh-nums" },
      num("потрібно", o.need),
      num("у вас", o.have),
      num("не вистачає", Math.max(0, o.need - o.have)),
    ),
    h("p", { class: "sh-advice", text: o.advice }),
    h("div", { class: "sh-actions" }, primary, secondary),
  );
}
