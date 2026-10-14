import { readFileSync } from "node:fs";
import path from "node:path";
import { SiteData, type SiteFontFace } from "@adc/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CrawlResult, crawlSite } from "../src/crawl.ts";
import { mergeFontFaces } from "../src/design.ts";
import {
  fontFileKey,
  parseFontFaces,
  parseFontWeight,
  selectFontFiles,
  sniffFontFormat,
} from "../src/fonts.ts";
import { tmpStorage } from "./helpers/context.ts";
import { buildTtf, buildWoff2, FIXTURE_FONTS } from "./helpers/make-fonts.ts";
import {
  type FixtureServers,
  FONT_FIXTURE_DIR,
  startFixtureServers,
  testHostMap,
  testResolver,
} from "./helpers/server.ts";

const face = (family: string, weight: number, extra: Partial<SiteFontFace> = {}): SiteFontFace => ({
  family,
  weight,
  style: "normal",
  format: "woff2",
  url: `https://site.test/f/${family}-${weight}.woff2`,
  unicodeRange: null,
  path: null,
  ...extra,
});

describe("розбір @font-face", () => {
  it("сімейство, вага (діапазон → нижня межа), стиль, src за пріоритетом форматів, unicode-range", () => {
    const css = `
      /* @font-face { font-family: Commented; src: url(x.woff2); } */
      @font-face {
        font-family: 'Brand Sans';
        font-style: normal;
        font-weight: 300 800;
        src: local("Brand"), url(../f/brand.ttf) format("truetype"), url('../f/brand.woff') format('woff'),
          url("../f/brand.woff2?v=2#iefix") format("woff2");
        unicode-range: U+0400-045F, u+0490-0491;
      }
      @font-face { font-family: Brand Sans; font-weight: bold; font-style: oblique 10deg;
        src: url(/f/brand-bold.otf); }
      @font-face { font-family: "Inline"; src: url(data:font/woff2;base64,AAAA) format("woff2"); }
      @font-face { font-family: "Old"; src: url(old.eot) format("embedded-opentype"); }
      @font-face { font-family: "Creds"; src: url(https://user:pw@cdn.test/a.woff2); }
    `;
    expect(parseFontFaces(css, "https://site.test/css/main.css")).toEqual([
      {
        family: "Brand Sans",
        weight: 300,
        style: "normal",
        format: "woff2",
        url: "https://site.test/f/brand.woff2?v=2",
        unicodeRange: "U+0400-045F,U+0490-0491",
        path: null,
      },
      {
        family: "Brand Sans",
        weight: 700,
        style: "italic",
        format: "opentype",
        url: "https://site.test/f/brand-bold.otf",
        unicodeRange: null,
        path: null,
      },
    ]);
  });

  it("ключові слова ваги й некоректні значення", () => {
    expect(parseFontWeight(undefined)).toBe(400);
    expect(parseFontWeight("normal")).toBe(400);
    expect(parseFontWeight("bold")).toBe(700);
    expect(parseFontWeight("100 900")).toBe(100);
    expect(parseFontWeight("bolder")).toBeNull();
  });

  it("ключ файлу безпечний для шляху", () => {
    expect(fontFileKey(' "Zerno  Display" ')).toBe("zerno-display");
    expect(fontFileKey("Мій Шрифт")).toMatch(/^font-[0-9a-f]{8}$/);
  });

  it("дедуп граней з різних таблиць стилів", () => {
    const a = face("Brand", 400);
    expect(mergeFontFaces([[a], [{ ...a, family: "brand" }, face("Brand", 700)]])).toHaveLength(2);
  });
});

describe("вибір файлів", () => {
  const fonts = [
    { role: "h1" as const, family: "Display", weight: 800 },
    { role: "h2" as const, family: "Display", weight: 700 },
    { role: "body" as const, family: "Text", weight: 400 },
    { role: "button" as const, family: "Text", weight: 600 },
  ];

  it("лише сімейства ролей, стиль normal, найближчі ваги першими, не більше 6", () => {
    const faces = [
      ...[100, 200, 300, 400, 500, 600, 700, 900].map((w) => face("Display", w)),
      ...[300, 400, 700].map((w) => face("Text", w)),
      face("Text", 600, { style: "italic" }),
      face("Other", 400),
    ];
    const picked = selectFontFiles(faces, fonts).map((f) => `${f.family}-${f.weight}`);
    expect(picked).toHaveLength(6);
    // h1 800 → 700 (рівновіддалені 700/900 — перша), h2 700 уже є, body 400, button 600 → 700 (italic не рахується).
    expect(picked.slice(0, 3)).toEqual(["Display-700", "Text-400", "Text-700"]);
    expect(picked).not.toContain("Other-400");
    expect(picked.slice(3)).toEqual(["Display-400", "Text-300", "Display-300"]);
  });

  it("із кількох підмножин однієї ваги — повний файл або з кирилицею", () => {
    const latin = face("Text", 400, { url: "https://site.test/latin.woff2", unicodeRange: "U+0000-00FF" });
    const cyr = face("Text", 400, {
      url: "https://site.test/cyr.woff2",
      unicodeRange: "U+0400-045F,U+0490-0491",
    });
    expect(selectFontFiles([latin, cyr], fonts).map((f) => f.url)).toEqual(["https://site.test/cyr.woff2"]);
  });

  it("сигнатура файлу визначає формат; HTML замість шрифту відкидається", () => {
    const spec = FIXTURE_FONTS["plain-latin-400.woff2"];
    if (!spec) throw new Error("немає фікстури");
    expect(sniffFontFormat(buildWoff2(spec))).toBe("woff2");
    expect(sniffFontFormat(buildTtf(spec))).toBe("truetype");
    expect(sniffFontFormat(Buffer.from("<!doctype html><h1>404</h1>"))).toBeNull();
  });
});

describe("crawlSite: шрифти сайту", () => {
  let servers: FixtureServers;
  let result: CrawlResult;
  const storage = tmpStorage();

  beforeAll(async () => {
    servers = await startFixtureServers({ root: FONT_FIXTURE_DIR });
    result = await crawlSite(`${servers.origin}/`, {
      resolve: testResolver,
      hostMap: testHostMap,
      storage,
      projectId: "p1",
    });
  }, 120_000);

  afterAll(async () => {
    await servers?.close();
  });

  const faces = () => result.site.design?.fontFaces ?? [];
  const find = (family: string, style = "normal") =>
    faces().find((f) => f.family === family && f.style === style);

  it("збирає @font-face з CSS-файлу і вбудованого <style>", () => {
    expect(() => SiteData.parse(result.site)).not.toThrow();
    expect(result.site.design?.fonts).toContainEqual({ role: "h1", family: "Zerno Display", weight: 700 });
    expect(find("Zerno Display")).toEqual({
      family: "Zerno Display",
      weight: 700,
      style: "normal",
      format: "woff2",
      url: `${servers.origin}/fonts/zerno-display-700.woff2`,
      unicodeRange: "U+0000-00FF,U+0400-045F,U+0490-0491",
      path: "projects/p1/crawl/fonts/zerno-display-700.woff2",
    });
    expect(find("Plain Latin")).toMatchObject({
      weight: 400,
      url: `${servers.origin}/fonts/plain-latin-400.woff2`,
      path: "projects/p1/crawl/fonts/plain-latin-400.woff2",
    });
  });

  it("файли лежать у сховищі байт у байт", async () => {
    for (const name of ["zerno-display-700.woff2", "plain-latin-400.woff2"]) {
      const stored = await storage.read(`projects/p1/crawl/fonts/${name}`);
      expect(stored.equals(readFileSync(path.join(FONT_FIXTURE_DIR, "fonts", name)))).toBe(true);
    }
  });

  it("курсив і невикористані сімейства — без завантаження; приватні адреси відкинуто", () => {
    expect(find("Zerno Display", "italic")).toMatchObject({ path: null });
    expect(find("Unused Serif")).toMatchObject({ path: null });
    expect(faces().some((f) => f.family === "Leaky")).toBe(false);
    expect(servers.hits.some((h) => h.path.includes("unused-400"))).toBe(false);
    expect(servers.internalHits).toEqual([]);
  });
});
