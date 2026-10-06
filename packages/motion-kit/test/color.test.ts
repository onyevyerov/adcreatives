import { fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  averageColor,
  contrastRatio,
  minContrastFor,
  mix,
  parseColor,
  readableOn,
  relativeLuminance,
  withAlpha,
} from "../src/color.ts";

const palette = fixtureBrandKit.palette;

describe("кольори", () => {
  it("розбирає hex, короткий hex, rgb(a)", () => {
    expect(parseColor("#FF8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
    expect(parseColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(10 20 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("transparent")?.a).toBe(0);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("контраст WCAG: чорний/білий = 21, однакові = 1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
  });

  it("readableOn обирає з палітри бренду", () => {
    expect(readableOn(palette.primary, palette)).toBe(palette.textOnDark);
    expect(readableOn(palette.background, palette)).toBe(palette.textOnLight);
    // Без палітри — білий/майже чорний.
    expect(readableOn("#000000")).toBe("#FFFFFF");
    expect(readableOn("#FFFFFF")).toBe("#111111");
  });

  it("readableOn з поганою палітрою повертається до чистих кольорів", () => {
    const bad = { textOnDark: "#777777", textOnLight: "#888888" };
    expect(readableOn("#7F7F7F", bad)).toMatch(/^#(FFFFFF|111111)$/);
  });

  it("результат readableOn має контраст ≥ 3 для всіх кольорів палітри фікстури", () => {
    for (const bg of Object.values(palette)) {
      expect(contrastRatio(readableOn(bg, palette), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("mix / averageColor / withAlpha", () => {
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(averageColor(["#000000", "#FFFFFF"])).toBe("#808080");
    expect(withAlpha("#FF0000", 0.25)).toBe("rgba(255, 0, 0, 0.25)");
  });

  it("поріг контрасту за розміром шрифту", () => {
    expect(minContrastFor(72)).toBe(3);
    expect(minContrastFor(24)).toBe(4.5);
  });
});
