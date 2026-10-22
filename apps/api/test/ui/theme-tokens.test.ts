/**
 * Guard темної теми: кольори — лише токени, `--ink` — лише текст, дисплейні кеглі з поправкою
 * трекінгу, темний блок покриває всі колірні токени, а світлі значення нових токенів = старим.
 * CSS парситься регекспом за декларацією, без залежностей.
 *
 * - R1 — поза tokens.css немає `#hex`, `rgb(a)(`, `hsl(a)(`;
 * - R2 — `var(--ink)` лише в `color`, `caret-color`, `text-decoration-color`, `fill`, `stroke`,
 *   `-webkit-text-fill-color` і в селекторах `__glyph`;
 * - R3 — немає `--on-ink`, `--cb-tile-line`, `--cb-add-line`;
 * - R4 — `font` з `var(--f-display)` ≥ 28px (або `clamp(` з мінімумом ≥ 28px) має
 *   `letter-spacing: calc(<старе> + var(--trk-display))`;
 * - R5 — tokens.css: темний блок, світлі значення нових токенів, без `#000` / `#fff` у темному.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const CSS_DIR = path.join(DEFAULT_PUBLIC_DIR, "static", "css");
const CSS_FILES = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith(".css"))
  .sort();

type Decl = { prop: string; value: string };
type Rule = { selector: string; decls: Decl[] };

/** Правила з деклараціями; вкладені блоки (@media) дають власні правила зі своїм селектором. */
function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: { selector: string; body: string }[] = [];
  let buf = "";
  for (const ch of src) {
    if (ch === "{") {
      stack.push({ selector: buf.trim(), body: "" });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (!top) continue;
      top.body += buf;
      buf = "";
      rules.push({ selector: top.selector, decls: decls(top.body) });
    } else if (ch === ";" && stack.length) {
      const top = stack.at(-1);
      if (top) top.body += `${buf};`;
      buf = "";
    } else buf += ch;
  }
  return rules;
}

function decls(body: string): Decl[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.includes(":"))
    .map((d) => {
      const i = d.indexOf(":");
      return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
    });
}

const read = (f: string) => readFileSync(path.join(CSS_DIR, f), "utf8");

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const INK = /var\(--ink\)/;
const INK_PROPS = new Set([
  "color",
  "caret-color",
  "text-decoration-color",
  "fill",
  "stroke",
  "-webkit-text-fill-color",
]);
const LEGACY = /--on-ink\b|--cb-tile-line\b|--cb-add-line\b/;
const TRACKED = /^calc\(-?\d*\.?\d+em \+ var\(--trk-display\)\)$/;

/** Розмір дисплейного кегля з `font`: «300 28px / 1.1 …» або мінімум `clamp(48px, …)`. */
function displaySize(font: string): number | null {
  if (!font.includes("var(--f-display)")) return null;
  const clamp = font.match(/clamp\(\s*(\d*\.?\d+)px/);
  if (clamp) return Number(clamp[1]);
  const px = font.match(/(?:^|\s)(\d*\.?\d+)px\s*(?:\/|\s)/);
  return px ? Number(px[1]) : null;
}

/** Не колірні токени :root (T2–T4). */
const NON_COLOR = /^--(f-|r-|t-)|^--(topbar-h|chat-col|btn-h|btn-h-sm|btn-h-lg|ease|ac-delta)$/;

function check(file: string) {
  const css = read(file);
  const rules = parse(css);
  const problems: string[] = [];
  const where = (r: Rule, d: Decl) => `${r.selector} { ${d.prop}: ${d.value} }`;

  if (LEGACY.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) problems.push("R3: застарілий токен");

  for (const r of rules) {
    for (const d of r.decls) {
      if (file !== "tokens.css" && RAW_COLOR.test(d.value)) problems.push(`R1: ${where(r, d)}`);
      if (INK.test(d.value) && !INK_PROPS.has(d.prop) && !r.selector.includes("__glyph"))
        problems.push(`R2: ${where(r, d)}`);
      if (d.prop === "font") {
        const size = displaySize(d.value);
        if (size !== null && size >= 28) {
          const ls = r.decls.find((x) => x.prop === "letter-spacing");
          if (!ls || !TRACKED.test(ls.value))
            problems.push(`R4: ${r.selector} (${size}px) — ${ls?.value ?? "—"}`);
        }
      }
    }
  }
  return { rules, problems };
}

describe("theme-tokens (R1–R4 на файл, R5 — tokens.css)", () => {
  it("файли знайдено", () => {
    expect(CSS_FILES).toContain("tokens.css");
    expect(CSS_FILES).toContain("theme-switch.css");
  });

  it.each(CSS_FILES)("%s", (file) => {
    const { rules, problems } = check(file);
    expect(problems).toEqual([]);
    if (file !== "tokens.css") return;

    // R5
    const light = rules.find((r) => r.selector === ":root");
    const dark = rules.find((r) => r.selector === ':root[data-theme="dark"]');
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    const lightMap = new Map(light?.decls.map((d) => [d.prop, d.value]));
    const darkMap = new Map(dark?.decls.map((d) => [d.prop, d.value]));
    const colorTokens = [...lightMap.keys()].filter((k) => k.startsWith("--") && !NON_COLOR.test(k));
    expect(colorTokens.length).toBeGreaterThan(40);
    expect(colorTokens.filter((k) => !darkMap.has(k))).toEqual([]);
    expect([...darkMap.keys()].filter((k) => k.startsWith("--") && !lightMap.has(k))).toEqual([]);
    expect(lightMap.get("color-scheme")).toBe("light");
    expect(darkMap.get("color-scheme")).toBe("dark");

    const same: Record<string, string> = {
      "--fill-strong": "#151412",
      "--edge-strong": "#151412",
      "--focus-ring": "#151412",
      "--progress": "#151412",
      "--media-bg": "#151412",
      "--on-fill-strong": "#f5f3ee",
      "--on-media": "#f5f3ee",
      "--media-ring": "rgba(21, 20, 18, 0.12)",
      "--logo-plate": "#fcfbf8",
      "--line-tile": "rgba(21, 20, 18, 0.14)",
      "--line-dashed": "rgba(21, 20, 18, 0.25)",
      "--diamond-stale": "rgba(21, 20, 18, 0.4)",
      "--trk-display": "0em",
    };
    for (const [k, v] of Object.entries(same)) expect(lightMap.get(k), k).toBe(v);
    // Світла незмінна: значення, що існували до темної теми.
    expect(lightMap.get("--ink")).toBe("#151412");
    expect(lightMap.get("--card")).toBe(lightMap.get("--logo-plate"));
    expect(lightMap.get("--line-soft")).toBe(lightMap.get("--media-ring"));

    for (const v of darkMap.values()) expect(v).not.toMatch(/#(000|fff)(000|fff)?\b/i);
  });
});
