import type { Fact, SiteData } from "@adc/shared";
import { fixtureBrandKit, fixtureSiteData } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { addClientFacts, assignFactIds, conflicts, extractNumbers, verifySiteFacts } from "../src/facts.ts";

const HOME = "https://zerno.example.com/uk/";

function siteFact(overrides: Partial<Fact>): Fact {
  return {
    id: "f9",
    kind: "claim",
    text: "x",
    source: "site",
    sourceUrl: HOME,
    quote: "x",
    ...overrides,
  };
}

describe("verifySiteFacts", () => {
  it("accepts the fixture facts", () => {
    const res = verifySiteFacts(fixtureBrandKit.facts, fixtureSiteData);
    expect(res.dropped).toEqual([]);
    expect(res.facts).toHaveLength(2);
  });

  it("drops facts whose quote is not on the site", () => {
    const res = verifySiteFacts(
      [siteFact({ text: "Найкраща кава в Україні", quote: "Найкраща кава в Україні" })],
      fixtureSiteData,
    );
    expect(res.facts).toEqual([]);
    expect(res.dropped[0]?.reason).toMatch(/не знайдено/);
    expect(res.fixes[0]).toMatch(/прибрано/);
  });

  it("drops facts whose numbers differ from the quote", () => {
    const res = verifySiteFacts(
      [siteFact({ kind: "price", text: "Капучино — 70 грн", quote: "Капучино — 75 грн." })],
      fixtureSiteData,
    );
    expect(res.facts).toEqual([]);
    expect(res.dropped[0]?.reason).toMatch(/70/);
  });

  it("tolerates whitespace, dash and case differences; fills missing quote from text", () => {
    const res = verifySiteFacts(
      [
        siteFact({ kind: "price", text: "Капучино — 75 грн", quote: "капучино  - 75 грн" }),
        siteFact({ kind: "claim", text: "Обсмажуємо зерно щотижня", quote: null, sourceUrl: null }),
      ],
      fixtureSiteData,
    );
    expect(res.dropped).toEqual([]);
    expect(res.facts[1]?.quote).toBe("Обсмажуємо зерно щотижня");
    expect(res.facts[1]?.sourceUrl).toBe(HOME);
  });

  it("corrects the sourceUrl to the page where the quote is found", () => {
    const site: SiteData = structuredClone(fixtureSiteData);
    site.pages.push({
      ...structuredClone(site.pages[0] as SiteData["pages"][number]),
      url: `${HOME}menu`,
      text: "Лате — 85 грн.",
    });
    const res = verifySiteFacts(
      [siteFact({ kind: "price", text: "Лате — 85 грн", quote: "Лате — 85 грн." })],
      site,
    );
    expect(res.facts[0]?.sourceUrl).toBe(`${HOME}menu`);
    expect(res.fixes[0]).toMatch(/джерело виправлено/);
  });

  it("turns facts quoted from manual client text into client facts", () => {
    const site: SiteData = {
      ...structuredClone(fixtureSiteData),
      pages: [],
      manualText: "Хліб — 40 грн щодня.",
    };
    const res = verifySiteFacts(
      [siteFact({ kind: "price", text: "Хліб — 40 грн", quote: "Хліб — 40 грн" })],
      site,
    );
    expect(res.facts[0]).toMatchObject({ source: "client", sourceUrl: null });
  });
});

describe("ids and client facts", () => {
  it("extracts numbers with spaces and decimals", () => {
    expect(extractNumbers("від 1 200 грн, рейтинг 4,8 і 10%")).toEqual(["1200", "4.8", "10"]);
  });

  it("assigns f/c ids and keeps stable ones", () => {
    const facts: Fact[] = [
      siteFact({ id: "f7" }),
      siteFact({ id: "zzz" }),
      { ...siteFact({ id: "f1" }), source: "client", sourceUrl: null, quote: null },
    ];
    expect(assignFactIds(facts).map((f) => f.id)).toEqual(["f1", "f2", "c1"]);
    expect(assignFactIds(facts, new Set(["f7"])).map((f) => f.id)).toEqual(["f7", "f1", "c1"]);
  });

  it("client fact replaces a conflicting site fact; duplicates ignored", () => {
    const res = addClientFacts(fixtureBrandKit.facts, [
      { kind: "discount", text: "Знижка 15% на каву з собою" },
      { kind: "price", text: "Капучино — 75 грн" },
    ]);
    expect(res.replaced.map((f) => f.id)).toEqual(["f2"]);
    expect(res.added).toHaveLength(1);
    expect(res.added[0]).toMatchObject({ id: "c1", source: "client", sourceUrl: null, quote: null });
    expect(res.facts.map((f) => f.id)).toEqual(["f1", "c1"]);
    expect(res.fixes[0]).toMatch(/замінено фактом клієнта/);
  });

  it("conflicts: different entities sharing a generic word do not conflict; same entity with other numbers does", () => {
    const site = (kind: Fact["kind"], text: string) => siteFact({ kind, text, quote: text });
    expect(
      conflicts(site("price", "Тариф Starter — $10/міс"), { kind: "price", text: "Тариф Pro — $40/міс" }),
    ).toBe(false);
    expect(conflicts(site("price", "Капучино 65 грн"), { kind: "price", text: "Капучино 70 грн" })).toBe(
      true,
    );
    expect(
      conflicts(site("claim", "Безкоштовна доставка від 500 грн"), {
        kind: "claim",
        text: "Безкоштовна доставка від 400 грн",
      }),
    ).toBe(true);
    // Переказ того самого факту іншими словами — усе ще конфлікт.
    expect(
      conflicts(site("price", "Капучино — 65 грн за чашку"), {
        kind: "price",
        text: "Капучино коштує 70 грн",
      }),
    ).toBe(true);
    // Інші сутності з тим самим загальним словом.
    expect(
      conflicts(site("price", "Курс англійської — 3000 грн"), {
        kind: "price",
        text: "Курс німецької — 3200 грн",
      }),
    ).toBe(false);
    // Ті самі числа або інший вид — не конфлікт.
    expect(conflicts(site("price", "Капучино 70 грн"), { kind: "price", text: "Капучино — 70 грн" })).toBe(
      false,
    );
    expect(conflicts(site("price", "Капучино 65 грн"), { kind: "claim", text: "Капучино 70 грн" })).toBe(
      false,
    );
  });

  it("client price for one tariff keeps the other tariffs' site prices", () => {
    const facts: Fact[] = [
      siteFact({ id: "f1", kind: "price", text: "Тариф Starter — $10/міс" }),
      siteFact({ id: "f2", kind: "price", text: "Тариф Pro — $40/міс" }),
    ];
    const res = addClientFacts(facts, [{ kind: "price", text: "Тариф Pro — $45/міс" }]);
    expect(res.replaced.map((f) => f.id)).toEqual(["f2"]);
    expect(res.facts.map((f) => f.id)).toEqual(["f1", "c1"]);
  });
});
