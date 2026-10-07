// @ts-check
/** B6 · Чекпоінт 1 — бренд-кіт (S2, S6). Заглушка Кроку 0: B6 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cp-brand", "B6", el, ctx, (s) => `ревізія ${s.checkpoints.brand?.rev ?? "—"}`);
}
