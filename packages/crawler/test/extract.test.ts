import { projectPaths, SiteData, StageError } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { addressesFromJsonLd, emailsFromText, mergeContacts, phonesFromText } from "../src/contacts.ts";
import { filterJsonLd } from "../src/crawl.ts";
import { mergeDesign } from "../src/design.ts";
import { buildManualSiteData, guessLanguage } from "../src/manual.ts";
import { createCrawlStage } from "../src/stage.ts";
import { makeContext } from "./helpers/context.ts";

const empty = { phones: [], emails: [], socials: [], addresses: [], bodyText: "" };

describe("контакти", () => {
  it("телефони з тексту: міжнародний і український формат, без дат і цін", () => {
    expect(
      phonesFromText("Дзвоніть: +380 (67) 123-45-67 або 067 765 43 21. Ціна 1500 грн, 2024-05-12"),
    ).toEqual(["+380 (67) 123-45-67", "067 765 43 21"]);
  });

  it("email з тексту без імен файлів", () => {
    expect(emailsFromText("hello@zerno.ua, logo@2x.png, Info@Cafe.com.")).toEqual([
      "hello@zerno.ua",
      "info@cafe.com",
    ]);
  });

  it("адреси з JSON-LD (вкладені й рядкові)", () => {
    expect(
      addressesFromJsonLd([
        { "@type": "LocalBusiness", address: { addressLocality: "Львів", streetAddress: "вул. Руська, 1" } },
        { "@graph": [{ "@type": "Organization", address: "Київ, Хрещатик 1" }] },
      ]),
    ).toEqual(["Львів, вул. Руська, 1", "Київ, Хрещатик 1"]);
  });

  it("mergeContacts: дедуп телефонів за цифрами, соцмереж за адресою; текст — лише як запасний варіант", () => {
    const res = mergeContacts([
      {
        ...empty,
        phones: ["+380671234567", "+38 067 123 45 67"],
        emails: ["Hello@Zerno.ua"],
        socials: [
          { network: "instagram", url: "https://instagram.com/zerno/" },
          { network: "instagram", url: "https://www.instagram.com/zerno" },
        ],
        bodyText: "Інший номер +380 50 000 00 01",
      },
      { ...empty, addresses: ["Львів, вул. Руська, 1"] },
    ]);
    expect(res).toEqual({
      phones: ["+380671234567"],
      emails: ["hello@zerno.ua"],
      addresses: ["Львів, вул. Руська, 1"],
      socials: [{ network: "instagram", url: "https://instagram.com/zerno/" }],
    });
  });
});

describe("JSON-LD", () => {
  it("лишає бізнесові блоки, розгортає @graph, відкидає WebSite/BreadcrumbList", () => {
    const res = filterJsonLd([
      { "@type": "WebSite", name: "x" },
      { "@graph": [{ "@type": "Organization", name: "Зерно" }, { "@type": "BreadcrumbList" }] },
      [{ "@type": "FAQPage" }, { "@type": ["Product", "Thing"] }],
      "garbage",
    ]);
    expect(res).toEqual([
      { "@type": "Organization", name: "Зерно" },
      { "@type": "FAQPage" },
      { "@type": ["Product", "Thing"] },
    ]);
  });
});

describe("дизайн", () => {
  it("сумує частоти кольорів, бере найчастіший шрифт на роль і радіус", () => {
    const d = mergeDesign([
      {
        cssVars: { "--brand": "#111" },
        colors: [
          { role: "button", value: "#6b3e26", count: 3 },
          { role: "background", value: "#FFF8F0", count: 10 },
          { role: "bogus", value: "#000000", count: 99 },
        ],
        fonts: [
          { role: "h1", family: "Montserrat", weight: 700 },
          { role: "body", family: "Inter", weight: 400 },
        ],
        radii: { "8px": 2 },
      },
      {
        cssVars: { "--brand": "#222", "--accent": "#e85d2a" },
        colors: [{ role: "button", value: "#6B3E26", count: 2 }],
        fonts: [{ role: "h1", family: "Montserrat", weight: 700 }],
        radii: { "999px": 5 },
      },
      null,
    ]);
    expect(d).toEqual({
      cssVars: { "--brand": "#111", "--accent": "#e85d2a" },
      colors: [
        { role: "background", value: "#FFF8F0", count: 10 },
        { role: "button", value: "#6B3E26", count: 5 },
      ],
      fonts: [
        { role: "h1", family: "Montserrat", weight: 700 },
        { role: "body", family: "Inter", weight: 400 },
      ],
      buttonRadius: "999px",
    });
    expect(mergeDesign([null])).toBeNull();
  });
});

describe("ручний режим", () => {
  it("мінімальний site.json із тексту клієнта", () => {
    const site = buildManualSiteData(
      "  Кав'ярня «Зерно», Львів. Тел. +380 67 123 45 67, hello@zerno.ua, instagram.com/zerno  ",
      new Date("2026-10-06T10:00:00Z"),
    );
    expect(() => SiteData.parse(site)).not.toThrow();
    expect(site).toMatchObject({
      source: "manual",
      url: null,
      finalUrl: null,
      language: "uk",
      pages: [],
      design: null,
      manualText: "Кав'ярня «Зерно», Львів. Тел. +380 67 123 45 67, hello@zerno.ua, instagram.com/zerno",
      contacts: {
        phones: ["+380 67 123 45 67"],
        emails: ["hello@zerno.ua"],
        socials: [{ network: "instagram", url: "https://instagram.com/zerno" }],
      },
    });
  });

  it("мова тексту", () => {
    expect(guessLanguage("Найкраща кава в місті")).toBe("uk");
    expect(guessLanguage("Best coffee in town")).toBe("en");
    expect(guessLanguage("Лучший кофе в городе ёлки")).toBe("ru");
    expect(guessLanguage("12345")).toBeNull();
  });

  it("crawlStage без URL → manual; без URL і тексту → no_input; соцмережа без тексту → unsupported_source", async () => {
    const { ctx, storage } = makeContext("crawl", {
      url: null,
      manualText: "Стоматологія «Усмішка» у Києві",
    });
    const res = await createCrawlStage()(ctx);
    expect(res.outputs).toEqual({ mode: "manual", partial: false, pages: 0, photos: 0 });
    const site = await storage.readJson(projectPaths("p1").site, (v) => SiteData.parse(v));
    expect(site.manualText).toBe("Стоматологія «Усмішка» у Києві");
    expect(await storage.exists(projectPaths("p1").assets)).toBe(true);

    const noInput = await createCrawlStage()(makeContext("crawl", { url: null, manualText: "  " }).ctx).catch(
      (e: unknown) => e,
    );
    expect((noInput as StageError).code).toBe("no_input");

    const social = await createCrawlStage()(
      makeContext("crawl", { url: "https://instagram.com/zerno", manualText: null }).ctx,
    ).catch((e: unknown) => e);
    expect((social as StageError).code).toBe("unsupported_source");
    expect((social as StageError).retryable).toBe(false);

    const socialWithText = await createCrawlStage()(
      makeContext("crawl", { url: "https://instagram.com/zerno", manualText: "Кав'ярня" }).ctx,
    );
    expect(socialWithText.outputs.mode).toBe("manual");
  });

  it("crawlStage з приватною адресою → unsafe_url без запуску браузера", async () => {
    const err = await createCrawlStage()(
      makeContext("crawl", { url: "http://169.254.169.254/latest/meta-data", manualText: null }).ctx,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).code).toBe("unsafe_url");
  });
});
