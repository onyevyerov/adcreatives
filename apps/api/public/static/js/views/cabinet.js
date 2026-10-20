// @ts-check
/**
 * B7 · Каркас кабінету (N8-B): навігація розділів, сам монтує `cab-*.js`.
 * Крок 0 — заглушка з фіксованими експортами; B7 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cabinet", "B7", el, ctx, (s) => s.cabinet.section);
}
