// @ts-check
/**
 * B11 · Адмінка (N14-A).
 * Крок 0 — заглушка з фіксованими експортами; B11 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("admin", "B11", el, ctx, (s) => `${s.admin.tab}${s.admin.forbidden ? " · 403" : ""}`);
}
