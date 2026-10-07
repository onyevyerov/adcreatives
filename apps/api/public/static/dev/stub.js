// @ts-check
/**
 * Заглушка view для Кроку 0: показує назву блоку і поточний статус. Блок, який реалізує view,
 * замінює весь вміст свого файлу і більше цей модуль не імпортує.
 */
import { h, text } from "../js/dom.js";

/** @typedef {import("../js/contracts.js").UiState} UiState */
/** @typedef {import("../js/contracts.js").Ctx} Ctx */
/** @typedef {import("../js/contracts.js").ViewHandle} ViewHandle */

/**
 * @param {string} name назва view (= ім'я файлу)
 * @param {string} block блок, що його реалізує
 * @param {HTMLElement} el
 * @param {Ctx} ctx
 * @param {(state: UiState) => string} [describe]
 * @returns {ViewHandle}
 */
export function stubView(name, block, el, ctx, describe = (s) => s.status) {
  const node = h("div", {
    "data-stub": name,
    style: { padding: "12px 16px", font: "400 12px/1.5 var(--f-mono)", color: "var(--muted)" },
  });
  el.append(node);
  /** @param {UiState} state */
  const render = (state) => text(node, `${name} · ${block} · ${describe(state)}`);
  render(ctx.store.getState());
  return {
    update: (state) => render(state),
    destroy: () => node.remove(),
  };
}
