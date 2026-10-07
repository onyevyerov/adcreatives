// @ts-check
/** B8 · Чекпоінт 3 — розкадровка (S4). Заглушка Кроку 0: B8 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cp-board", "B8", el, ctx, (s) => `ревізія ${s.checkpoints.storyboard?.rev ?? "—"}`);
}
