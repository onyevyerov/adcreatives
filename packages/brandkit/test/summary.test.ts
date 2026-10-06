import { BrandCheckpointPayload } from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { brandCheckpointPayload, formatBrandSummaryText, summarizeBrandKit } from "../src/summary.ts";

const publicUrl = (key: string) => `/files/${key}`;

describe("brand summary", () => {
  it("builds a structure for chat templates", () => {
    const s = summarizeBrandKit(fixtureBrandKitFile, fixtureAssets.assets, { publicUrl });
    expect(s.name).toBe("Зерно");
    expect(s.swatches).toHaveLength(7);
    expect(s.swatches[0]).toEqual({ role: "primary", label: "основний", hex: "#6B3E26" });
    expect(s.logo).toMatchObject({ assetId: "a02", url: "/files/projects/p1/crawl/assets/a02.svg" });
    expect(s.logoCandidates).toEqual([{ assetId: "a02", url: "/files/projects/p1/crawl/assets/a02.svg" }]);
    expect(s.fonts.heading.family).toBe("Montserrat");
    expect(s.facts[0]).toMatchObject({ id: "f1", sourceLabel: "з сайту: https://zerno.example.com/uk/" });
    expect(s.questions[0]).toMatchObject({ default: "Привести нових гостей" });
    expect(s.photos).toEqual([{ assetId: "a01", url: "/files/projects/p1/crawl/assets/a01.jpg" }]);
    expect(s.needMorePhotos).toBe(true);
    expect(s.missingPhotos).toBe(2);
    expect(s.languageOptions).toHaveLength(2);
  });

  it("formats a Ukrainian chat text with swatches, facts with sources and question defaults", () => {
    const text = formatBrandSummaryText(
      summarizeBrandKit(fixtureBrandKitFile, fixtureAssets.assets, { publicUrl }),
    );
    expect(text).toContain("**Зерно** — Кава, яку обсмажуємо самі (кав'ярня)");
    expect(text).toContain("основний #6B3E26");
    expect(text).toContain("Капучино — 75 грн — з сайту: https://zerno.example.com/uk/");
    expect(text).toContain("якщо не відповісте: «Привести нових гостей»");
    expect(text).toContain("ще хоча б 2");
  });

  it("produces a valid brand checkpoint payload", () => {
    const payload = brandCheckpointPayload(fixtureBrandKitFile, fixtureAssets.assets, {
      publicUrl,
      formats: ["vertical"],
    });
    expect(BrandCheckpointPayload.parse(payload)).toMatchObject({
      needMorePhotos: true,
      formats: ["vertical"],
    });
  });
});
