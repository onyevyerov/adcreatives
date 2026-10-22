// @vitest-environment happy-dom
/**
 * Крок 0 темної теми: lib/theme.js (резолв, вибір, синхронізація вкладок і системи) і паритет
 * з theme-boot.js, який ставить тему до першого кадру.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ThemeModule from "../../public/static/js/lib/theme.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

type Theme = typeof ThemeModule;
type Pref = "light" | "dark" | "system";

const BOOT_SRC = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "static", "js", "theme-boot.js"), "utf8");

/** Керований matchMedia: `dark` / `reduced` і слухачі `change` для prefers-color-scheme. */
function fakeMedia(init: { dark?: boolean; reduced?: boolean } = {}) {
  const env = { dark: init.dark ?? false, reduced: init.reduced ?? false };
  const listeners = new Set<() => void>();
  const matchMedia = (q: string) => ({
    media: q,
    get matches() {
      if (q.includes("prefers-color-scheme: dark")) return env.dark;
      if (q.includes("prefers-reduced-motion: reduce")) return env.reduced;
      return false;
    },
    addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn),
  });
  return {
    env,
    matchMedia,
    setDark(v: boolean) {
      env.dark = v;
      for (const fn of listeners) fn();
    },
  };
}

const html = () => document.documentElement;
const meta = () => document.querySelector('meta[name="theme-color"]');
const frames = () => new Promise((r) => setTimeout(r, 60));

/** Свіжий модуль (стан initTheme і підписників — на модуль). */
async function load(): Promise<Theme> {
  vi.resetModules();
  return import("../../public/static/js/lib/theme.js");
}

/** Атрибути, які поставив би boot. */
function bootAttrs(pref: Pref, theme: "light" | "dark", locked = false) {
  html().setAttribute("data-theme", theme);
  html().setAttribute("data-theme-pref", pref);
  if (locked) html().setAttribute("data-theme-locked", "");
}

describe("lib/theme.js", () => {
  let media: ReturnType<typeof fakeMedia>;
  beforeEach(() => {
    media = fakeMedia();
    vi.stubGlobal("matchMedia", media.matchMedia);
    const m = document.createElement("meta");
    m.setAttribute("name", "theme-color");
    m.setAttribute("content", "#f5f3ee");
    document.head.append(m);
  });
  afterEach(async () => {
    await frames(); // відкладені clear() з rAF — до наступного тесту
    vi.unstubAllGlobals();
    localStorage.clear();
    document.head.textContent = "";
    for (const a of ["data-theme", "data-theme-pref", "data-theme-locked", "data-theme-switching"])
      html().removeAttribute(a);
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it("parsePref: невідоме → system", async () => {
    const { parsePref } = await load();
    expect(parsePref("light")).toBe("light");
    expect(parsePref("dark")).toBe("dark");
    expect(parsePref("system")).toBe("system");
    for (const v of [null, undefined, "", "Dark", "auto", 1, {}]) expect(parsePref(v)).toBe("system");
  });

  it("resolveTheme: 6 комбінацій", async () => {
    const { resolveTheme } = await load();
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("getTheme читає атрибути boot", async () => {
    const { getTheme } = await load();
    bootAttrs("system", "dark");
    media.env.dark = true;
    expect(getTheme()).toEqual({ pref: "system", theme: "dark", locked: false, systemDark: true });
  });

  it("setThemePref пише adc.theme, ставить data-theme/-pref, theme-color і сповіщає", async () => {
    const { setThemePref, subscribeTheme, THEME_KEY } = await load();
    bootAttrs("system", "light");
    const seen: string[] = [];
    const off = subscribeTheme((s) => seen.push(`${s.pref}:${s.theme}`));
    setThemePref("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(html().getAttribute("data-theme-pref")).toBe("dark");
    expect(meta()?.getAttribute("content")).toBe("#1c1a18");
    setThemePref("system");
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(meta()?.getAttribute("content")).toBe("#f5f3ee");
    off();
    setThemePref("light");
    expect(seen).toEqual(["dark:dark", "system:light"]);
  });

  it("data-theme-switching знято після кадру", async () => {
    const { setThemePref } = await load();
    setThemePref("dark");
    expect(html().hasAttribute("data-theme-switching")).toBe(true);
    await frames();
    expect(html().hasAttribute("data-theme-switching")).toBe(false);
  });

  it("View Transitions — лише без reduced-motion", async () => {
    const { setThemePref } = await load();
    const vt = vi.fn((cb: () => void) => {
      cb();
      return { finished: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = vt;
    setThemePref("dark");
    expect(vt).toHaveBeenCalledOnce();
    expect(html().getAttribute("data-theme")).toBe("dark");
    await frames();
    expect(html().hasAttribute("data-theme-switching")).toBe(false);
    media.env.reduced = true;
    setThemePref("light");
    expect(vt).toHaveBeenCalledOnce();
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  it("швидкі перемикання з VT: застарілий swap не перекриває новіший, switching знімає останній", async () => {
    const { setThemePref } = await load();
    bootAttrs("light", "light");
    const pending: { cb: () => void; done: () => void }[] = [];
    (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => {
      let done = () => {};
      const finished = new Promise<void>((r) => {
        done = r;
      });
      pending.push({ cb, done });
      return { finished };
    };
    setThemePref("dark");
    setThemePref("system");
    pending[0]?.cb();
    pending[0]?.done();
    await frames();
    expect(html().getAttribute("data-theme-pref")).toBe("light");
    expect(html().hasAttribute("data-theme-switching")).toBe(true);
    pending[1]?.cb();
    pending[1]?.done();
    await frames();
    expect(html().getAttribute("data-theme-pref")).toBe("system");
    expect(html().getAttribute("data-theme")).toBe("light");
    expect(html().hasAttribute("data-theme-switching")).toBe(false);
  });

  it("locked (фікстура з &theme=) — застосовує, але нічого не пише", async () => {
    const { setThemePref, THEME_KEY } = await load();
    bootAttrs("dark", "dark", true);
    setThemePref("light");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  it("недоступне сховище — не помилка", async () => {
    const { setThemePref } = await load();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => setThemePref("dark")).not.toThrow();
    expect(html().getAttribute("data-theme")).toBe("dark");
    spy.mockRestore();
  });

  it("подія storage застосовує тему миттєво; у locked — ігнорується", async () => {
    const { initTheme, THEME_KEY } = await load();
    bootAttrs("system", "light");
    initTheme();
    initTheme(); // ідемпотентна
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(html().getAttribute("data-theme-pref")).toBe("dark");
    expect(html().hasAttribute("data-theme-switching")).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "light" }));
    expect(html().getAttribute("data-theme")).toBe("dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: null }));
    expect(html().getAttribute("data-theme-pref")).toBe("system");
    html().setAttribute("data-theme-locked", "");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  it("matchMedia change діє лише при system", async () => {
    const { initTheme, setThemePref } = await load();
    bootAttrs("system", "light");
    initTheme();
    media.setDark(true);
    expect(html().getAttribute("data-theme")).toBe("dark");
    media.setDark(false);
    expect(html().getAttribute("data-theme")).toBe("light");
    setThemePref("light");
    media.setDark(true);
    expect(html().getAttribute("data-theme")).toBe("light");
  });
});

describe("theme-boot.js ↔ resolveTheme (паритет)", () => {
  afterEach(() => {
    for (const a of ["data-theme", "data-theme-pref", "data-theme-locked"]) html().removeAttribute(a);
    document.head.textContent = "";
  });

  const STORED = [null, "light", "dark", "system", "bogus"] as const;
  const QUERIES = [
    "",
    "?fixture=n3-guest",
    "?fixture=n3-guest&theme=dark",
    "?fixture=x&theme=light",
    "?theme=dark",
  ];
  const matrix = STORED.flatMap((stored) =>
    QUERIES.flatMap((search) => [false, true].map((systemDark) => ({ stored, search, systemDark }))),
  );

  it.each(matrix)(
    "$stored · «$search» · система темна: $systemDark",
    async ({ stored, search, systemDark }) => {
      const { resolveTheme, parsePref, THEME_KEY } = await load();
      const m = document.createElement("meta");
      m.setAttribute("name", "theme-color");
      document.head.append(m);
      const store = new Map<string, string>(stored === null ? [] : [[THEME_KEY, stored]]);
      runInNewContext(BOOT_SRC, {
        document,
        localStorage: { getItem: (k: string) => store.get(k) ?? null },
        location: { search },
        matchMedia: (q: string) => ({ matches: q.includes("dark") && systemDark }),
        URLSearchParams,
      });

      const q = new URLSearchParams(search);
      const t = q.get("theme");
      const locked = q.has("fixture") && (t === "light" || t === "dark");
      const pref = locked ? (t as Pref) : parsePref(stored);
      const theme = resolveTheme(pref, systemDark);
      expect(html().getAttribute("data-theme")).toBe(theme);
      expect(html().getAttribute("data-theme-pref")).toBe(pref);
      expect(html().hasAttribute("data-theme-locked")).toBe(locked);
      expect(m.getAttribute("content")).toBe(theme === "dark" ? "#1c1a18" : "#f5f3ee");
    },
  );

  it("сховище кидає — тема за системою", () => {
    runInNewContext(BOOT_SRC, {
      document,
      localStorage: {
        getItem() {
          throw new Error("SecurityError");
        },
      },
      location: { search: "" },
      matchMedia: () => ({ matches: true }),
      URLSearchParams,
    });
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(html().getAttribute("data-theme-pref")).toBe("system");
  });
});
