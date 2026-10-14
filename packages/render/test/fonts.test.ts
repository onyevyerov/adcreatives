import { fixtureBrandKit } from "@adc/shared/fixtures";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import { describe, expect, it } from "vitest";
import { resolveBrandFonts, resolveLocalFonts } from "../src/fonts.ts";

describe("resolveBrandFonts", () => {
  it("додає моношрифт: без вибору бренд-кіта — JetBrains Mono", async () => {
    const brand = { ...fixtureBrandKit, typography: { ...fixtureBrandKit.typography, mono: null } };
    const families = (await resolveBrandFonts(brand)).map((f) => f.fontFamily);
    expect(families).toContain("JetBrains Mono");
  });

  it("mono бренд-кіта — його сімейство; спільне з body не дублюється", async () => {
    const body = fixtureBrandKit.typography.body;
    const brand = { ...fixtureBrandKit, typography: { ...fixtureBrandKit.typography, mono: body } };
    const families = (await resolveBrandFonts(brand)).map((f) => f.fontFamily);
    expect(families.filter((f) => f === body.family)).toHaveLength(1);
    expect(families).not.toContain("JetBrains Mono");
  });
});

describe("resolveLocalFonts", () => {
  const files = (name: string) =>
    [400, 700].map((weight) => ({
      weight,
      style: "normal" as const,
      format: "woff2" as const,
      path: `projects/p1/crawl/fonts/${name}-${weight}.woff2`,
    }));

  it("ролі з origin local → fonts/<basename>; Google Fonts і замінники пропускаються", () => {
    const brand: BrandKit = {
      ...fixtureBrandKit,
      typography: {
        ...fixtureBrandKit.typography,
        heading: { family: "Zerno Display", weights: [400, 700], origin: "local", files: files("zerno") },
        mono: { family: "Zerno Mono", weights: [400], origin: "local", files: files("zmono").slice(0, 1) },
      },
    };
    expect(resolveLocalFonts(brand)).toEqual([
      { family: "Zerno Display", weight: 400, format: "woff2", src: "fonts/zerno-400.woff2" },
      { family: "Zerno Display", weight: 700, format: "woff2", src: "fonts/zerno-700.woff2" },
      { family: "Zerno Mono", weight: 400, format: "woff2", src: "fonts/zmono-400.woff2" },
    ]);
    expect(resolveLocalFonts(fixtureBrandKit)).toEqual([]);
  });

  it("спільне сімейство heading і body не дублюється", () => {
    const role = {
      family: "Zerno Display",
      weights: [400, 700],
      origin: "local" as const,
      files: files("zerno"),
    };
    const brand = {
      ...fixtureBrandKit,
      typography: { ...fixtureBrandKit.typography, heading: role, body: role },
    };
    expect(resolveLocalFonts(brand)).toHaveLength(2);
  });
});
