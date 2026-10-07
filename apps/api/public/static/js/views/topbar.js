// @ts-check
/** B3 · Топбар (C2, S2–S5). Заглушка Кроку 0: B3 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("topbar", "B3", el, ctx, (s) => `${s.status} · $${s.totalUsd.toFixed(2)}`);
}
