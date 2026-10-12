import { fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { resolveBrandFonts } from "../src/fonts.ts";

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
