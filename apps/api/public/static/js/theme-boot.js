/*
 * Тема до першого кадру (без спалаху). Класичний синхронний скрипт у <head> до стилів.
 * Без inline-скриптів, eval і вставки HTML. Логіку резолву дублює lib/theme.js — паритет перевіряє test/ui/theme.test.ts.
 */
(() => {
  const root = document.documentElement;
  let pref = "system";
  let locked = false;
  try {
    const q = new URLSearchParams(location.search);
    const t = q.get("theme");
    if (q.has("fixture") && (t === "light" || t === "dark")) {
      pref = t;
      locked = true;
    } else {
      const s = localStorage.getItem("adc.theme");
      if (s === "light" || s === "dark" || s === "system") pref = s;
    }
  } catch {
    // Сховище недоступне (приватний режим) — тема за системою.
  }
  const dark =
    pref === "dark" ||
    (pref === "system" &&
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-pref", pref);
  if (locked) root.setAttribute("data-theme-locked", "");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1c1a18" : "#f5f3ee");
})();
