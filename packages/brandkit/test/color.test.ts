import { fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { contrastRatio, fixPalette, normalizeHex, paletteReport, parseColor } from "../src/color.ts";

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
