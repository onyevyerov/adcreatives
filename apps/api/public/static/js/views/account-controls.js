// @ts-check
/**
 * B3 · Пілюля балансу, коло й меню акаунта (N4-B).
 * Крок 0 — заглушка з фіксованими експортами; B3 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/**
 * Контроли акаунта: B2 і B8 монтують на старті / чеку (`place: "start"`), B3 — у топбарі (`"page"`).
 * @param {HTMLElement} el
 * @param {import("../contracts.js").Ctx} ctx
 * @param {{ place: "start" | "page" }} o
 * @returns {import("../contracts.js").ViewHandle}
 */
export function mount(el, ctx, o) {
  return stubView("account-controls", "B3", el, ctx, (s) => `${s.account.meStatus} · ${o.place}`);
}
