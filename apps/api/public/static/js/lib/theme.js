// @ts-check
/**
 * Крок 0 · Тема: «Світла · Темна · Як у системі» (ТЗ темної теми, 0.6).
 *
 * - вибір — `localStorage["adc.theme"]` (`light | dark | system`, за замовчуванням `system`);
 *   недоступне сховище — не помилка: стан живе в атрибутах <html>;
 * - застосування — лише атрибути `data-theme` / `data-theme-pref` на <html> і
 *   `meta[name=theme-color]`: без перезавантаження, перемонтування в'юх, store і SSE;
 * - початковий стан ставить theme-boot.js до першого кадру (логіка резолву — паритетна з
 *   `resolveTheme`); `?fixture=…&theme=light|dark` — locked: вибір застосовується, але не пишеться,
 *   події `storage` ігноруються.
 */

export const THEME_KEY = "adc.theme";
/** @typedef {"light" | "dark" | "system"} ThemePref */
/** @typedef {"light" | "dark"} Theme */
/** @typedef {{ pref: ThemePref, theme: Theme, locked: boolean, systemDark: boolean }} ThemeState */
export const THEME_COLOR = { light: "#f5f3ee", dark: "#1c1a18" };

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** @type {Set<(s: ThemeState) => void>} */
const listeners = new Set();
let inited = false;
let applySeq = 0;

/** @param {unknown} v @returns {ThemePref} невідоме → "system" */
export function parsePref(v) {
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/** @param {ThemePref} pref @param {boolean} systemDark @returns {Theme} */
export function resolveTheme(pref, systemDark) {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** @param {string} query */
function matches(query) {
  try {
    return typeof matchMedia === "function" && matchMedia(query).matches;
  } catch {
    return false;
  }
}

const root = () => document.documentElement;

/** Поточний стан. Початкові значення — з атрибутів, які поставив theme-boot.js. @returns {ThemeState} */
export function getTheme() {
  const el = root();
  const systemDark = matches(DARK_QUERY);
  const pref = parsePref(el.getAttribute("data-theme-pref"));
  const attr = el.getAttribute("data-theme");
  const theme = attr === "light" || attr === "dark" ? attr : resolveTheme(pref, systemDark);
  return { pref, theme, locked: el.hasAttribute("data-theme-locked"), systemDark };
}

function notify() {
  const s = getTheme();
  for (const fn of [...listeners]) {
    try {
      fn(s);
    } catch (err) {
      console.error("[theme] listener", err);
    }
  }
}

/**
 * Виставляє тему на <html>. Анімує (View Transitions) лише вибір користувача і не при reduced-motion;
 * на час заміни `data-theme-switching` вимикає transition блоків (base.css).
 * @param {ThemePref} pref
 * @param {boolean} animate
 */
function apply(pref, animate) {
  const el = root();
  const theme = resolveTheme(pref, matches(DARK_QUERY));
  // Швидкі перемикання підряд: swap з View Transition виконується асинхронно — застарілий не
  // перекриває новіший, а прибирає `data-theme-switching` лише останній.
  const seq = ++applySeq;
  const swap = () => {
    if (seq !== applySeq) return;
    el.setAttribute("data-theme", theme);
    el.setAttribute("data-theme-pref", pref);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
    notify();
  };
  const clear = () => {
    if (seq === applySeq) el.removeAttribute("data-theme-switching");
  };
  el.setAttribute("data-theme-switching", "");
  const doc =
    /** @type {Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }} */ (
      document
    );
  if (animate && !matches(REDUCED_QUERY) && typeof doc.startViewTransition === "function") {
    try {
      doc.startViewTransition(swap).finished.finally(clear);
      return;
    } catch {
      // VT недоступні посеред іншого переходу — міняємо миттєво.
    }
  }
  swap();
  requestAnimationFrame(() => requestAnimationFrame(clear));
}

/** Вибір користувача: зберегти (якщо не locked) → застосувати з анімацією → сповістити. @param {ThemePref} pref */
export function setThemePref(pref) {
  const p = parsePref(pref);
  if (!root().hasAttribute("data-theme-locked")) {
    try {
      // "system" теж пишеться явно — друга вкладка отримає подію storage.
      localStorage.setItem(THEME_KEY, p);
    } catch {
      // Приватний режим — вибір живе до перезавантаження.
    }
  }
  apply(p, true);
}

/** @param {(s: ThemeState) => void} fn @returns {() => void} відписка */
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Один раз з app.js: слухачі storage і matchMedia. Ідемпотентна. */
export function initTheme() {
  if (inited || typeof window === "undefined") return;
  inited = true;
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY && !root().hasAttribute("data-theme-locked")) apply(parsePref(e.newValue), false);
  });
  try {
    if (typeof matchMedia === "function")
      matchMedia(DARK_QUERY).addEventListener("change", () => {
        if (getTheme().pref === "system") apply("system", false);
      });
  } catch {
    // Старі браузери без MediaQueryList.addEventListener — тема за системою лише при завантаженні.
  }
}
