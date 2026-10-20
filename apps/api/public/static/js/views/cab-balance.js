// @ts-check
/**
 * B7 · Кабінет · баланс і поповнення (N8-B, N9-A).
 * Крок 0 — заглушка з фіксованими експортами; B7 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cab-balance", "B7", el, ctx, (s) => String(s.account.me?.balance ?? "—"));
}
