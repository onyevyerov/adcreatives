// @ts-check
/** B5 · Сцена: робочі стани (X5). Заглушка Кроку 0: B5 замінює вміст файлу, сигнатуру `mount` зберігає. */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("stage-progress", "B5", el, ctx, (s) => `${s.status} · ${s.progress?.label ?? "—"}`);
}
