// @ts-check
/** B3 · Таймлайн (C3). Заглушка Кроку 0: B3 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("timeline", "B3", el, ctx);
}
