// @ts-check
/**
 * B8 · Тестова оплата (N10-A).
 * Крок 0 — заглушка з фіксованими експортами; B8 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView(
    "checkout",
    "B8",
    el,
    ctx,
    (s) => `${s.checkout?.id ?? "—"} · ${s.checkout?.status ?? "—"}`,
  );
}
