import { describe, expect, it } from "vitest";
import {
  detectLanguageVersions,
  type LinkCandidate,
  parseSitemap,
  scoreCandidate,
  selectPages,
} from "../src/discovery.ts";

const link = (
  url: string,
  text = "",
  inNav = false,
  source: LinkCandidate["source"] = "home",
): LinkCandidate => ({
  url,
  text,
  inNav,
  source,
});

describe("пріоритизація сторінок", () => {
  it("ключові сторінки вище за інші; навігація вище за решту; політики внизу", () => {
    const about = scoreCandidate(link("https://x.com/about", "About", true));
    const menu = scoreCandidate(link("https://x.com/menu", "Меню", true));
    const contacts = scoreCandidate(link("https://x.com/kontakty", "Контакти", true));
    const random = scoreCandidate(link("https://x.com/some-article", "Стаття"));
    const policy = scoreCandidate(link("https://x.com/privacy-policy", "Політика"));
    expect(about).toBeGreaterThan(menu);
    expect(menu).toBeGreaterThan(contacts);
    expect(contacts).toBeGreaterThan(random);
    expect(random).toBeGreaterThan(policy);
  });

  it("розпізнає українські ключі в URL і в тексті анкора", () => {
    expect(scoreCandidate(link("https://x.com/%D0%BF%D0%BE%D1%81%D0%BB%D1%83%D0%B3%D0%B8"))).toBeGreaterThan(
      scoreCandidate(link("https://x.com/news")),
    );
    expect(scoreCandidate(link("https://x.com/p/12", "Відгуки"))).toBeGreaterThan(
      scoreCandidate(link("https://x.com/p/13", "Новина")),
    );
  });

  it("selectPages: той самий сайт, без пропусків і дублів, за пріоритетом, з лімітом", () => {
    const pages = selectPages({
      home: "https://www.cafe.com/",
      lang: "uk",
      otherVersions: ["https://cafe.com/en/"],
      limit: 4,
      candidates: [
        link("https://cafe.com/blog/hello-world", "Привіт"),
        link("https://www.cafe.com/menu#top", "Меню", true),
        link("https://cafe.com/menu/", "Меню"),
        link("https://cafe.com/about", "Про нас", true),
        link("https://cafe.com/", "Головна", true),
        link("https://cafe.com/en/about", "About", true),
        link("https://shop.cafe.com/products", "Магазин", true),
        link("https://other.com/about", "Про нас", true),
        link("https://cafe.com/price.pdf", "Прайс", true),
        link("https://cafe.com/blog/page/2", "Далі"),
        link("https://cafe.com/reviews", "", false, "sitemap"),
        link("https://cafe.com/contacts", "Контакти", true),
      ],
    });
    expect(pages).toEqual([
      "https://cafe.com/about",
      "https://www.cafe.com/menu",
      "https://cafe.com/contacts",
      "https://cafe.com/reviews",
    ]);
  });

  it("selectPages: якщо введено /en/, краулимо лише /en/…", () => {
    const pages = selectPages({
      home: "https://cafe.com/en/",
      lang: "en",
      otherVersions: ["https://cafe.com/"],
      limit: 10,
      candidates: [
        link("https://cafe.com/en/menu"),
        link("https://cafe.com/menu"),
        link("https://cafe.com/ua/menu"),
      ],
    });
    expect(pages).toEqual(["https://cafe.com/en/menu"]);
  });

  it("selectPages: інша мовна версія з нестандартним префіксом (hreflang) відсіюється", () => {
    const pages = selectPages({
      home: "https://cafe.com/",
      lang: "uk",
      otherVersions: ["https://cafe.com/de/"],
      limit: 10,
      candidates: [link("https://cafe.com/de/menu"), link("https://cafe.com/menu")],
    });
    expect(pages).toEqual(["https://cafe.com/menu"]);
  });
});

describe("sitemap.xml", () => {
  it("urlset і sitemap index, CDATA та &amp;", () => {
    const xml = `<?xml version="1.0"?>
      <urlset><url><loc>https://x.com/a</loc></url><url><loc><![CDATA[https://x.com/b?x=1&amp;y=2]]></loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual({
      pages: ["https://x.com/a", "https://x.com/b?x=1&y=2"],
      sitemaps: [],
    });
    const index = `<sitemapindex><sitemap><loc> https://x.com/page-sitemap.xml </loc></sitemap></sitemapindex>`;
    expect(parseSitemap(index)).toEqual({ pages: [], sitemaps: ["https://x.com/page-sitemap.xml"] });
  });

  it("обмежує кількість адрес", () => {
    const xml = `<urlset>${Array.from({ length: 50 }, (_, i) => `<url><loc>https://x.com/${i}</loc></url>`).join("")}</urlset>`;
    expect(parseSitemap(xml, 10).pages).toHaveLength(10);
  });
});

describe("мовні версії", () => {
  it("з hreflang і префіксів; поточна мова першою", () => {
    const res = detectLanguageVersions({
      home: "https://cafe.com/",
      htmlLang: "uk-UA",
      hreflang: [
        { hreflang: "uk", href: "https://cafe.com/" },
        { hreflang: "en-US", href: "/en/" },
        { hreflang: "x-default", href: "https://cafe.com/" },
        { hreflang: "pl", href: "https://evil.com/pl/" },
      ],
      links: ["https://cafe.com/ru/menu", "https://cafe.com/about"],
    });
    expect(res.language).toBe("uk");
    expect(res.versions).toEqual([
      { lang: "uk", url: "https://cafe.com/" },
      { lang: "en", url: "https://cafe.com/en/" },
      { lang: "ru", url: "https://cafe.com/ru/" },
    ]);
  });

  it("мова з префікса введеної адреси має пріоритет над lang", () => {
    const res = detectLanguageVersions({
      home: "https://cafe.com/en/",
      htmlLang: "uk",
      hreflang: [],
      links: ["https://cafe.com/ua/"],
    });
    expect(res.language).toBe("en");
    expect(res.versions.map((v) => v.lang)).toEqual(["en", "uk"]);
  });

  it("одна мова — порожній список версій", () => {
    expect(
      detectLanguageVersions({ home: "https://cafe.com/", htmlLang: "uk", hreflang: [], links: ["/about"] })
        .versions,
    ).toEqual([]);
  });
});
