import { describe, expect, it } from "vitest";
import fontsData from "../src/fonts.json" with { type: "json" };
import {
  findGoogleFont,
  fixTypography,
  googleFonts,
  hasCyrillic,
  primaryFamily,
  resolveFont,
} from "../src/fonts.ts";

const opts = (cyrillic: boolean, detected: string[] = []) => ({ cyrillic, detected });

describe("fonts.json", () => {
  it("has unique families and every substitute/fallback exists with cyrillic", () => {
    const names = googleFonts().map((f) => f.family.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const target of Object.values(fontsData.substitutes)) {
      const f = findGoogleFont(target);
      expect(f, target).not.toBeNull();
      expect(f && hasCyrillic(f), target).toBe(true);
    }
    for (const pair of Object.values(fontsData.fallbacks)) {
      for (const name of [pair.heading, pair.body]) {
        const f = findGoogleFont(name);
        expect(f && hasCyrillic(f), name).toBe(true);
      }
    }
  });

  it("knows cyrillic support of popular fonts", () => {
    for (const name of ["Inter", "Montserrat", "Manrope", "Roboto", "Rubik", "Playfair Display"]) {
      expect(hasCyrillic(findGoogleFont(name) as never), name).toBe(true);
    }
    for (const name of ["Poppins", "Lato", "DM Sans", "Bebas Neue"]) {
      expect(hasCyrillic(findGoogleFont(name) as never), name).toBe(false);
    }
  });
});

describe("resolveFont", () => {
  it("extracts primary family from a CSS stack", () => {
    expect(primaryFamily('"Montserrat", Arial, sans-serif')).toBe("Montserrat");
    expect(primaryFamily("sans-serif")).toBeNull();
  });

  it("keeps a site font with cyrillic for uk and marks origin site", () => {
    const r = resolveFont(
      { family: "montserrat", weights: [700, 800], origin: "substitute" },
      "heading",
      opts(true, ["Montserrat"]),
    );
    expect(r.fix).toBeNull();
    expect(r.choice).toEqual({ family: "Montserrat", weights: [700, 800], origin: "site" });
  });

  it("replaces a latin-only font for uk via substitutes map", () => {
    const r = resolveFont({ family: "Poppins", weights: [600], origin: "site" }, "heading", opts(true));
    expect(r.choice.family).toBe("Montserrat");
    expect(r.choice.origin).toBe("substitute");
    expect(r.fix).toMatch(/кирилиці/);
  });

  it("keeps a latin-only font for en", () => {
    const r = resolveFont({ family: "Poppins", weights: [600], origin: "site" }, "heading", opts(false));
    expect(r.fix).toBeNull();
    expect(r.choice.family).toBe("Poppins");
  });

  it("maps commercial fonts and unknown fonts to cyrillic Google Fonts", () => {
    expect(
      resolveFont({ family: "Gilroy", weights: [700], origin: "site" }, "heading", opts(true)).choice.family,
    ).toBe("Manrope");
    const unknown = resolveFont(
      { family: "Foo Grotesk", weights: [400], origin: "site" },
      "body",
      opts(true),
    );
    expect(unknown.choice.family).toBe("Inter");
    expect(unknown.fix).toMatch(/немає в перевіреному списку/);
    const serif = resolveFont(
      { family: "My Serif Antiqua", weights: [400], origin: "site" },
      "body",
      opts(true),
    );
    expect(serif.choice.family).toBe("Lora");
  });

  it("snaps weights to available ones", () => {
    const r = resolveFont({ family: "PT Sans", weights: [500, 800], origin: "site" }, "body", opts(true));
    expect(r.choice.weights).toEqual([400, 700]);
  });
});

describe("fixTypography", () => {
  it("requires cyrillic for a cyrillic brand name even when language is en", () => {
    const res = fixTypography(
      {
        heading: { family: "Bebas Neue", weights: [400], origin: "site" },
        body: { family: "Inter", weights: [400], origin: "site" },
        mono: null,
        detected: [],
      },
      { language: "en", brandName: "Зерно", siteFonts: ['"Inter", sans-serif'] },
    );
    expect(res.typography.heading.family).toBe("Oswald");
    expect(res.typography.body.origin).toBe("site");
    expect(res.typography.detected).toEqual(["Inter"]);
    expect(res.fixes).toHaveLength(1);
  });
});
