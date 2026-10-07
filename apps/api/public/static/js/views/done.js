// @ts-check
/** B9 · Готово (S5). Заглушка Кроку 0: B9 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("done", "B9", el, ctx, (s) => `відео: ${s.artifacts.videos.length}`);
}
