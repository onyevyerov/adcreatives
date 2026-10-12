import type { Palette } from "@adc/shared";
import { fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  deriveSemanticPalette,
  fixPalette,
  normalizeHex,
  paletteReport,
  parseColor,
  SEMANTIC_BASE,
} from "../src/color.ts";

describe("color", () => {
  it("parses hex, short hex and rgb()", () => {
    expect(parseColor("#6b3e26")).toEqual({ r: 107, g: 62, b: 38 });
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor("teal")).toBeNull();
    expect(normalizeHex("#abc")).toBe("#AABBCC");
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
  });
});

describe("fixPalette", () => {
  it("leaves a good palette untouched", () => {
    const { palette, fixes } = fixPalette(fixtureBrandKit.palette);
    expect(fixes).toEqual([]);
    expect(palette).toEqual(fixtureBrandKit.palette);
  });

  it("darkens low-contrast textOnLight and lightens textOnDark", () => {
    const { palette, fixes } = fixPalette({
      primary: "#1A237E",
      secondary: "#90CAF9",
      accent: "#D84315",
      background: "#FFFFFF",
      surface: "#F5F5F5",
      textOnDark: "#5C6BC0",
      textOnLight: "#9E9E9E",
      danger: null,
      warning: null,
      success: null,
    });
    expect(contrastRatio(palette.textOnLight, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.textOnDark, "#1A237E")).toBeGreaterThanOrEqual(4.5);
    expect(palette.primary).toBe("#1A237E");
    expect(fixes.length).toBeGreaterThanOrEqual(2);
    expect(fixes.join(" ")).toMatch(/текст на світлому/);
  });

  it("swaps inverted text colors", () => {
    const { palette, fixes } = fixPalette({
      ...fixtureBrandKit.palette,
      textOnDark: "#1E1410",
      textOnLight: "#FFFFFF",
    });
    expect(palette.textOnDark).toBe("#FFFFFF");
    expect(palette.textOnLight).toBe("#1E1410");
    expect(fixes[0]).toMatch(/переплутані/);
  });

  it("separates an accent that blends into the background and keeps text readable on it", () => {
    const { palette } = fixPalette({
      ...fixtureBrandKit.palette,
      background: "#FFF8F0",
      accent: "#FCEFE0",
    });
    const report = paletteReport(palette);
    expect(report.accentVsBackground).toBeGreaterThanOrEqual(3);
    expect(report.accent).toBeGreaterThanOrEqual(3);
    expect(report.background).toBeGreaterThanOrEqual(4.5);
    expect(report.surface).toBeGreaterThanOrEqual(4.5);
    expect(report.primary).toBeGreaterThanOrEqual(3);
  });

  it("works for a dark-themed palette and normalizes hex case", () => {
    const { palette } = fixPalette({
      primary: "#ffcc00",
      secondary: "#333333",
      accent: "#ff3366",
      background: "#121212",
      surface: "#1e1e1e",
      textOnDark: "#888888",
      textOnLight: "#222222",
      danger: null,
      warning: null,
      success: null,
    });
    expect(palette.primary).toBe("#FFCC00");
    const report = paletteReport(palette);
    expect(report.background).toBeGreaterThanOrEqual(4.5);
    expect(report.surface).toBeGreaterThanOrEqual(4.5);
    expect(report.primary).toBeGreaterThanOrEqual(3);
  });
});

describe("deriveSemanticPalette", () => {
  const roles = ["danger", "warning", "success"] as const;
  const light: Palette = {
    ...fixtureBrandKit.palette,
    accent: "#EF4444",
    background: "#FFFFFF",
    surface: "#FFFFFF",
  };
  const readable = (p: Palette) =>
    roles.every((r) => {
      const c = p[r] as string;
      return contrastRatio(c, p.background) >= 3 && contrastRatio(c, p.surface) >= 3;
    });

  it("derives null roles from the fixed bases mixed into the accent, without fixes", () => {
    const { palette, fixes } = deriveSemanticPalette(light);
    expect(fixes).toEqual([]);
    // База danger = акцент: домішка нічого не міняє, контраст з білим 3.8 — без підсвічування.
    expect(palette.danger).toBe(SEMANTIC_BASE.danger);
    // Жовтий на білому нечитабельний — затемнено до порогу.
    expect(palette.warning).not.toBe(SEMANTIC_BASE.warning);
    expect(readable(palette)).toBe(true);
    // Брендові кольори не змінюються.
    expect({ ...palette, danger: null, warning: null, success: null }).toEqual(light);
  });

  it("tints the bases toward the brand accent", () => {
    const blue = deriveSemanticPalette({ ...light, accent: "#1D4ED8" }).palette;
    const red = deriveSemanticPalette(light).palette;
    expect(blue.success).not.toBe(red.success);
    const g = parseColor(blue.success as string);
    // Зелений лишається зеленим: домішка акценту лише 15 %.
    expect(g && g.g > g.r && g.g > g.b).toBe(true);
  });

  it("lightens on a dark theme and checks both background and surface", () => {
    const dark: Palette = { ...fixtureBrandKit.palette, background: "#0B0B0F", surface: "#2A2A35" };
    const { palette } = deriveSemanticPalette(dark);
    expect(readable(palette)).toBe(true);
    const fixtureKit = deriveSemanticPalette(fixtureBrandKit.palette).palette;
    expect(readable(fixtureKit)).toBe(true);
  });

  it("keeps a readable site color, nudges an unreadable one and replaces garbage with a report", () => {
    const { palette, fixes } = deriveSemanticPalette({
      ...light,
      danger: "#b91c1c",
      warning: "#FDE68A",
      success: "зелений",
    });
    expect(palette.danger).toBe("#B91C1C");
    expect(contrastRatio(palette.warning as string, "#FFFFFF")).toBeGreaterThanOrEqual(3);
    expect(readable(palette)).toBe(true);
    expect(fixes).toHaveLength(2);
    expect(fixes.join(" ")).toMatch(/попередження.*#FDE68A/);
    expect(fixes.join(" ")).toMatch(/успіх.*не розпізнано/);
  });
});
