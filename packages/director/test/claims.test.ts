import type { BrandKit, Storyboard } from "@adc/shared";
import { ClaimsReport } from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { extractClaims, verifyClaims } from "../src/claims.ts";

function withTexts(texts: Array<{ headline: string; sub?: string | null; factIds?: string[] }>): Storyboard {
  const base = fixtureStoryboard.scenes[0] as Storyboard["scenes"][number];
  return {
    ...fixtureStoryboard,
    scenes: texts.map((t, i) => ({
      ...base,
      id: `s${i + 1}`,
      factIds: t.factIds ?? [],
      text: { headline: t.headline, sub: t.sub ?? null, emphasis: [] },
    })),
  };
}

const enBrand: BrandKit = {
  ...fixtureBrandKit,
  identity: { ...fixtureBrandKit.identity, name: "Bean Lab", language: "en", city: "Austin" },
  location: { address: "12 Main St, Austin", city: "Austin", hours: "Mon–Fri 7:00–19:00" },
  contacts: { ...fixtureBrandKit.contacts, phones: ["+1 (512) 555-0134"] },
  facts: [
    { id: "f1", kind: "price", text: "Latte $4.50", source: "site", sourceUrl: null, quote: "Latte — $4.50" },
    {
      id: "f2",
      kind: "claim",
      text: "Best coffee in Austin 2025 (Austin Chronicle)",
      source: "site",
      sourceUrl: null,
      quote: null,
    },
    {
      id: "c1",
      kind: "discount",
      text: "20% off for students",
      source: "client",
      sourceUrl: null,
      quote: null,
    },
  ],
};

describe("extractClaims", () => {
  it("uk: ціни, відсотки, час, №1, найкращий, гарантія", () => {
    const found = extractClaims("№1 у Львові: капучино 75 грн, -10% до 10:00. Найкраща кава з гарантією!");
    expect(found.map((c) => [c.kind, c.text])).toEqual([
      ["superlative", "№1"],
      ["price", "75 грн"],
      ["percent", "-10%"],
      ["date", "10:00"],
      ["superlative", "Найкраща"],
      ["guarantee", "гарантією"],
    ]);
  });

  it("en: $ prices, #1, best, guaranteed, dates and plain numbers", () => {
    const found = extractClaims("#1 latte for $4.50 — best in town since 2015, 300 happy guests, guaranteed");
    expect(found.map((c) => c.kind)).toEqual([
      "superlative",
      "price",
      "superlative",
      "date",
      "number",
      "guarantee",
    ]);
    expect(found.find((c) => c.kind === "price")?.value).toBe("4.5");
  });

  it("не плутає слова з маркерами: наймаємо, gluten-free, interest", () => {
    expect(extractClaims("Наймаємо бариста. Gluten-free interest")).toEqual([]);
  });
});

describe("verifyClaims", () => {
  it("uk: факти фікстури підтверджують ціну і знижку; адреса й графік — контакти", () => {
    const report = verifyClaims(fixtureStoryboard, { ...fixtureBrandKit, version: 3 });
    expect(ClaimsReport.parse(report)).toBeTruthy();
    expect(report.brandkitVersion).toBe(3);
    expect(report.unverified).toEqual([]);
    const texts = report.verified.map((c) => [c.text, c.factId, c.matchedContact]);
    expect(texts).toContainEqual(["75 грн", "f1", false]);
    expect(texts).toContainEqual(["-10%", "f2", false]);
    expect(texts).toContainEqual(["10:00", "f2", false]);
    expect(texts).toContainEqual(["1", null, true]); // «вул. Руська, 1»
  });

  it("uk: непідтверджені число і маркер переваги", () => {
    const report = verifyClaims(
      withTexts([
        { headline: "Найкраща кава у Львові", sub: "Знижка 30% щопонеділка" },
        { headline: "Відкриті 8:00–21:00" },
      ]),
      fixtureBrandKit,
    );
    expect(report.unverified.map((c) => [c.sceneId, c.field, c.kind, c.text])).toEqual([
      ["s1", "headline", "superlative", "Найкраща"],
      ["s1", "sub", "percent", "30%"],
    ]);
    expect(report.verified.filter((c) => c.matchedContact).map((c) => c.text)).toEqual(["8:00", "21:00"]);
  });

  it("en: facts, client facts win, phone from contacts, unverified superlative", () => {
    const report = verifyClaims(
      withTexts([
        { headline: "Best coffee in Austin", sub: "Latte $4.50" },
        { headline: "20% off for students", sub: "Call (512) 555-0134" },
        { headline: "The cheapest brunch, guaranteed" },
      ]),
      enBrand,
    );
    const v = report.verified.map((c) => [c.text, c.factId ?? (c.matchedContact ? "contact" : null)]);
    expect(v).toContainEqual(["Best", "f2"]);
    expect(v).toContainEqual(["$4.50", "f1"]);
    expect(v).toContainEqual(["20%", "c1"]);
    expect(v).toContainEqual(["(512) 555-0134", "contact"]);
    expect(report.unverified.map((c) => c.text)).toEqual(["cheapest", "guaranteed"]);
  });
});

describe("verifyClaims: items і текст сайту", () => {
  const SITE = [
    '<page url="https://webreportio.com/" title="WebReport">',
    "## Аудит сайту",
    "Повний звіт від $300–2000 за 48 годин",
    "Агенція: 3–10 робочих днів | Ми: 1 день",
    "Найшвидший аудит у регіоні",
    "</page>",
  ].join("\n");

  function withItems(items: Array<{ id: string; text: string }>): Storyboard {
    const sb = withTexts([{ headline: "Аудит сайту" }]);
    (sb.scenes[0] as Storyboard["scenes"][number]).items = items.map((i) => ({
      ...i,
      role: "number" as const,
      group: null,
      factIds: [],
    }));
    return sb;
  }

  it("«від $300–2000» в items підтверджується текстом сайту (matchedSite)", () => {
    const report = verifyClaims(withItems([{ id: "t1", text: "від $300–2000" }]), fixtureBrandKit, {
      siteText: SITE,
    });
    expect(report.unverified).toEqual([]);
    expect(report.verified.map((c) => [c.field, c.itemId, c.text, c.kind, c.matchedSite])).toEqual([
      ["item", "t1", "$300", "price", true],
      ["item", "t1", "2000", "date", true], // «2000» екстрактор вважає роком
    ]);
    expect(ClaimsReport.parse(report)).toBeTruthy();
  });

  it("без тексту сайту ті самі items — непідтверджені; чужі числа сайту не підтверджують", () => {
    const items = [
      { id: "t1", text: "від $300–2000" },
      { id: "t2", text: "Звіт за 4 години" },
      { id: "t3", text: "Найшвидший аудит" },
      { id: "t4", text: "20000 перевірок" },
    ];
    const none = verifyClaims(withItems(items), fixtureBrandKit);
    expect(none.unverified.map((c) => [c.itemId, c.text])).toEqual([
      ["t1", "$300"],
      ["t1", "2000"],
      ["t2", "4"],
      ["t3", "Найшвидший"],
      ["t4", "20000"],
    ]);
    const site = verifyClaims(withItems(items), fixtureBrandKit, { siteText: SITE });
    expect(site.verified.filter((c) => c.matchedSite).map((c) => c.text)).toEqual([
      "$300",
      "2000",
      "Найшвидший",
    ]);
    expect(site.unverified.map((c) => c.text)).toEqual(["4", "20000"]);
  });

  it("факт бренд-кіта має пріоритет над сайтом; factIds пункту — першими", () => {
    const report = verifyClaims(withItems([{ id: "t1", text: "Капучино 75 грн" }]), fixtureBrandKit, {
      siteText: "Капучино 75 грн",
    });
    expect(report.verified.map((c) => [c.itemId, c.factId, c.matchedSite])).toEqual([["t1", "f1", false]]);
  });
});
