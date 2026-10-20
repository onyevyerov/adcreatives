// @ts-check
/**
 * B9 · Кабінет · мої проєкти (N12-B).
 * Крок 0 — заглушка з фіксованими експортами; B9 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cab-projects", "B9", el, ctx, (s) => `${s.cabinet.projects.rows?.length ?? "—"} проєктів`);
}
