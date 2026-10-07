// @ts-check
/** B1 · Стартовий екран (S1). Заглушка Кроку 0: B1 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("start", "B1", el, ctx, (s) => s.route);
}
