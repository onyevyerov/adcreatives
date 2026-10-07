// @ts-check
/** B5 · Сцена: помилка (X4). Заглушка Кроку 0: B5 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("failed", "B5", el, ctx, (s) => s.error?.message ?? s.status);
}
