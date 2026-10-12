import { describe, expect, it } from "vitest";
import fontsData from "../src/fonts.json" with { type: "json" };
import {
  DEFAULT_MONO,
  findGoogleFont,
  fixTypography,
  googleFonts,
  hasCyrillic,
  primaryFamily,
  resolveFont,
  resolveMono,
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

describe("resolveMono", () => {
  const brand = {
    heading: { family: "Montserrat", weights: [700], origin: "site" as const },
    body: { family: "Inter", weights: [400], origin: "site" as const },
  };

  it("has JetBrains Mono with cyrillic in fonts.json", () => {
    expect(DEFAULT_MONO).toBe("JetBrains Mono");
    const f = findGoogleFont(DEFAULT_MONO);
    expect(f?.category).toBe("monospace");
    expect(f && hasCyrillic(f)).toBe(true);
  });

  it("null → JetBrains Mono, origin site when the site uses it", () => {
    expect(resolveMono(null, brand, opts(true))).toEqual({
      choice: { family: "JetBrains Mono", weights: [400, 700], origin: "substitute" },
      fix: null,
    });
    expect(resolveMono(null, brand, opts(true, ["JetBrains Mono"])).choice.origin).toBe("site");
  });

  it("null and a monospace brand font → the brand font itself", () => {
    const r = resolveMono(
      null,
      { ...brand, body: { family: "Roboto Mono", weights: [400], origin: "site" } },
      opts(true, ["Roboto Mono"]),
    );
    expect(r.fix).toBeNull();
    expect(r.choice).toEqual({ family: "Roboto Mono", weights: [400, 700], origin: "site" });
  });

  it("keeps a valid monospace choice, replaces a proportional or latin-only one", () => {
    const fira = resolveMono({ family: "Fira Code", weights: [500], origin: "site" }, brand, opts(true));
    expect(fira).toEqual({
      choice: { family: "Fira Code", weights: [500], origin: "substitute" },
      fix: null,
    });

    const inter = resolveMono({ family: "Inter", weights: [500], origin: "site" }, brand, opts(true));
    expect(inter.choice.family).toBe("JetBrains Mono");
    expect(inter.choice.weights).toEqual([500]);
    expect(inter.fix).toMatch(/не моноширинний/);

    const space = resolveMono({ family: "Space Mono", weights: [700], origin: "site" }, brand, opts(true));
    expect(space.choice.family).toBe("JetBrains Mono");
    expect(space.fix).toMatch(/кирилиці/);
    expect(
      resolveMono({ family: "Space Mono", weights: [700], origin: "site" }, brand, opts(false)).choice.family,
    ).toBe("Space Mono");

    const menlo = resolveMono(
      { family: "Menlo, monospace", weights: [400], origin: "site" },
      brand,
      opts(true),
    );
    expect(menlo.choice.family).toBe("JetBrains Mono");
  });

  it("fixTypography always fills mono", () => {
    const res = fixTypography(
      { heading: brand.heading, body: brand.body, mono: null, detected: [] },
      { language: "uk", brandName: "Зерно" },
    );
    expect(res.typography.mono?.family).toBe("JetBrains Mono");
    expect(res.fixes).toEqual([]);
  });
});
