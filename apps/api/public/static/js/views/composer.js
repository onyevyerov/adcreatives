// @ts-check
/** B4 · Композер (C5). Заглушка Кроку 0: B4 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("composer", "B4", el, ctx, (s) => (s.ui.editing ? "editing" : s.status));
}
