// @ts-check
/** B7 · Чекпоінт 2 — тексти (S3). Заглушка Кроку 0: B7 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cp-script", "B7", el, ctx, (s) => `ревізія ${s.checkpoints.script?.rev ?? "—"}`);
}
