// @ts-check
/**
 * B10 · Кабінет · профіль і пароль (N13-A).
 * Крок 0 — заглушка з фіксованими експортами; B10 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("cab-profile", "B10", el, ctx, (s) => s.account.me?.user.email ?? "—");
}
