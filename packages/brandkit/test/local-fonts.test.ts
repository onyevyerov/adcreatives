import { readFileSync } from "node:fs";
import type { FontChoice, SiteFontFace, Typography } from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile } from "@adc/shared/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fixTypography,
  fontHasCyrillic,
  loadSiteFonts,
  resolveFont,
  type SiteFontFile,
} from "../src/fonts.ts";
import { formatBrandSummaryText, summarizeBrandKit } from "../src/summary.ts";
import { tempStorage } from "./helpers.ts";

/** Ті самі файли, що віддає мок-сервер краулера (packages/crawler/test/fixtures/fontsite/fonts). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/fonts/${name}`, import.meta.url));
const CYR = "projects/p1/crawl/fonts/zerno-display-700.woff2";
const LATIN = "projects/p1/crawl/fonts/plain-latin-400.woff2";

const face = (family: string, weight: number, path: string | null, extra: Partial<SiteFontFace> = {}) =>
  ({
    family,
    weight,
    style: "normal",
    format: "woff2",
    url: `https://site.test/fonts/${weight}.woff2`,
    unicodeRange: null,
    path,
    ...extra,
  }) satisfies SiteFontFace;

const choice = (family: string, weights: number[]): FontChoice => ({
  family,
  weights,
  origin: "site",
  files: [],
});

const typography = (heading: string, body: string): Typography => ({
  heading: choice(heading, [700]),
  body: choice(body, [400]),
  mono: null,
  detected: [],
});

let local: SiteFontFile[];

beforeAll(async () => {
  const storage = tempStorage();
  await storage.write(CYR, fixture("zerno-display-700.woff2"));
  await storage.write(LATIN, fixture("plain-latin-400.woff2"));
  await storage.write("projects/p1/crawl/fonts/broken-400.woff2", Buffer.from("<!doctype html>"));
  local = await loadSiteFonts(storage, [
    face("Zerno Display", 700, CYR),
    face("Plain Latin", 400, LATIN),
    face("Zerno Display", 700, null, { style: "italic" }),
    face("Unused Serif", 400, null),
    face("Broken", 400, "projects/p1/crawl/fonts/broken-400.woff2"),
  ]);
});

describe("файли шрифтів сайту", () => {
  it("fontkit бачить кирилицю (ж, ї, є, ґ) лише в першому файлі", () => {
    expect(fontHasCyrillic(fixture("zerno-display-700.woff2"))).toBe(true);
    expect(fontHasCyrillic(fixture("plain-latin-400.woff2"))).toBe(false);
  });

  it("loadSiteFonts бере лише завантажені normal-файли, що розбираються", () => {
    expect(local).toEqual([
      { family: "Zerno Display", weight: 700, format: "woff2", path: CYR, cyrillic: true },
      { family: "Plain Latin", weight: 400, format: "woff2", path: LATIN, cyrillic: false },
    ]);
  });
});

describe("resolveFont: локальні файли сайту", () => {
  it("українська: обирає файл із кирилицею і відхиляє файл без неї", () => {
    const res = fixTypography(typography("Zerno Display", "Plain Latin"), {
      language: "uk",
      siteFonts: ["Zerno Display", "Plain Latin"],
      localFonts: local,
    });
    expect(res.typography.heading).toEqual({
      family: "Zerno Display",
      weights: [700],
      origin: "local",
      files: [{ weight: 700, style: "normal", format: "woff2", path: CYR }],
    });
    expect(res.typography.body.origin).toBe("substitute");
    expect(res.typography.body.files).toEqual([]);
    expect(res.fixes).toContain("Шрифт заголовків «Zerno Display» узято з сайту.");
    expect(res.fixes.some((f) => f.startsWith("Шрифт тексту «Plain Latin»"))).toBe(true);
  });

  it("без кирилиці (англійська) підходить і латинський файл", () => {
    const r = resolveFont(choice("plain latin", [400]), "body", {
      cyrillic: false,
      detected: [],
      local,
    });
    expect(r.choice).toMatchObject({ family: "Plain Latin", origin: "local", weights: [400] });
    expect(r.fix).toBe("Шрифт тексту «Plain Latin» узято з сайту.");
  });

  it("ваги — найближчі наявні файли", () => {
    const r = resolveFont(choice("Zerno Display", [400, 900]), "heading", {
      cyrillic: true,
      detected: [],
      local,
    });
    expect(r.choice.weights).toEqual([700]);
    expect(r.choice.files.map((f) => f.weight)).toEqual([700]);
  });

  it("Google Fonts має пріоритет над файлами сайту", () => {
    const r = resolveFont(choice("Montserrat", [700]), "heading", {
      cyrillic: true,
      detected: ["Montserrat"],
      local: [{ family: "Montserrat", weight: 700, format: "woff2", path: CYR, cyrillic: true }],
    });
    expect(r.choice).toEqual({ family: "Montserrat", weights: [700], origin: "site", files: [] });
  });

  it("моно не береться з файлів сайту", () => {
    const res = fixTypography(
      { ...typography("Zerno Display", "Inter"), mono: choice("Zerno Display", [400]) },
      { language: "uk", localFonts: local },
    );
    expect(res.typography.mono?.origin).not.toBe("local");
  });

  it("без даних про файли (правка бренд-кіта) локальний вибір лишається, новий — замінюється", () => {
    const kept: FontChoice = {
      family: "Zerno Display",
      weights: [700],
      origin: "local",
      files: [{ weight: 700, style: "normal", format: "woff2", path: CYR }],
    };
    const again = resolveFont(kept, "heading", { cyrillic: true, detected: [] });
    expect(again).toEqual({ choice: kept, fix: null });
    const fresh = resolveFont(choice("Zerno Display", [700]), "heading", { cyrillic: true, detected: [] });
    expect(fresh.choice.origin).toBe("substitute");
  });
});

describe("підсумок для власника", () => {
  it("позначає шрифт сайту «(з сайту)»", () => {
    const kit = {
      ...fixtureBrandKitFile,
      typography: {
        ...fixtureBrandKitFile.typography,
        heading: {
          family: "Zerno Display",
          weights: [700],
          origin: "local" as const,
          files: [{ weight: 700, style: "normal" as const, format: "woff2" as const, path: CYR }],
        },
      },
    };
    const text = formatBrandSummaryText(
      summarizeBrandKit(kit, fixtureAssets.assets, { publicUrl: (k) => k }),
    );
    expect(text).toContain("заголовки — Zerno Display 700 (з сайту)");
  });
});
