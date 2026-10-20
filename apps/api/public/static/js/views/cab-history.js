// @ts-check
/**
 * B9 · Кабінет · історія (N11-B).
 * Крок 0 — заглушка з фіксованими експортами; B9 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cab-history", "B9", el, ctx, (s) => `${s.cabinet.history.entries.length} записів`);
}
