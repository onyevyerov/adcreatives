// @ts-check
/**
 * B1 · Модалка входу в `#overlay` (N1–N2).
 * Крок 0 — заглушка з фіксованими експортами; B1 замінює весь вміст файлу.
 */
import { stubView } from "../../dev/stub.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  return stubView("auth", "B1", el, ctx, (s) =>
    s.auth ? `${s.auth.view} · ${s.auth.context ?? "—"}` : "закрито",
  );
}

/**
 * Та сама форма входу без картки модалки — для сцени 401 (B12, `layout: "stage"`).
 * @param {HTMLElement} el
 * @param {import("../contracts.js").Ctx} ctx
 * @param {{ layout: "modal" | "stage" }} o
 * @returns {import("../contracts.js").ViewHandle}
 */
export function mountAuthForm(el, ctx, o) {
  return stubView("auth-form", "B1", el, ctx, (s) => `${o.layout} · ${s.auth?.view ?? "login"}`);
}
