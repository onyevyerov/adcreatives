import { describe, expect, it } from "vitest";
import {
  cleanUrl,
  isSameSite,
  isSkippableUrl,
  langPrefixOf,
  normalizeLang,
  pageKey,
  parseUrl,
} from "../src/url.ts";

const u = (s: string) => new URL(s);

describe("нормалізація адрес", () => {
  it("pageKey: без www, фрагмента, трекінгу, кінцевого слеша й index.html; параметри відсортовані", () => {
    expect(pageKey(u("https://www.Example.com/About/?utm_source=x#team"))).toBe("example.com/about");
    expect(pageKey(u("http://example.com/about"))).toBe("example.com/about");
    expect(pageKey(u("https://example.com/index.html"))).toBe("example.com/");
    expect(pageKey(u("https://example.com/menu/index.php"))).toBe("example.com/menu");
    expect(pageKey(u("https://example.com/"))).toBe("example.com/");
    expect(pageKey(u("https://example.com/p?b=2&a=1&fbclid=z"))).toBe("example.com/p?a=1&b=2");
    expect(pageKey(u("https://example.com:8080/x"))).toBe("example.com:8080/x");
  });

  it("cleanUrl прибирає фрагмент і параметри відстеження", () => {
    expect(cleanUrl(u("https://example.com/a?utm_medium=x&id=5#top"))).toBe("https://example.com/a?id=5");
  });

  it("parseUrl приймає лише http(s)", () => {
    expect(parseUrl("/about", "https://example.com/")?.href).toBe("https://example.com/about");
    expect(parseUrl("mailto:a@b.c")).toBeNull();
    expect(parseUrl("javascript:alert(1)")).toBeNull();
    expect(parseUrl("::bad")).toBeNull();
  });

  it("той самий сайт з www і без; інші піддомени — ні", () => {
    expect(isSameSite(u("https://www.example.com/a"), u("http://example.com/"))).toBe(true);
    expect(isSameSite(u("https://blog.example.com/"), u("https://example.com/"))).toBe(false);
    expect(isSameSite(u("https://example.com.evil.com/"), u("https://example.com/"))).toBe(false);
  });
});

describe("що пропускаємо", () => {
  it.each([
    "https://x.com/price.pdf",
    "https://x.com/photo.JPG",
    "https://x.com/blog/page/2",
    "https://x.com/catalog?page=3",
    "https://x.com/shop?sort=price",
    "https://x.com/shop?filter_color=red",
    "https://x.com/shop?a=1&b=2&c=3",
    "https://x.com/events/calendar",
    "https://x.com/2024/05/12/post",
    "https://x.com/cart",
    "https://x.com/wp-admin/",
    "https://x.com/tag/coffee",
    "https://x.com/search?q=kava",
  ])("пропускає %s", (url) => {
    expect(isSkippableUrl(u(url))).toBe(true);
  });

  it.each([
    "https://x.com/about",
    "https://x.com/menu",
    "https://x.com/services/catering",
    "https://x.com/?utm_source=fb",
    "https://x.com/product?id=5",
  ])("не пропускає %s", (url) => {
    expect(isSkippableUrl(u(url))).toBe(false);
  });
});

describe("мови", () => {
  it("мовний префікс шляху", () => {
    expect(langPrefixOf(u("https://x.com/en/about"))).toBe("en");
    expect(langPrefixOf(u("https://x.com/ua/"))).toBe("uk");
    expect(langPrefixOf(u("https://x.com/uk"))).toBe("uk");
    expect(langPrefixOf(u("https://x.com/ru-ru/menu"))).toBe("ru");
    expect(langPrefixOf(u("https://x.com/de/"))).toBeNull();
    expect(langPrefixOf(u("https://x.com/menu"))).toBeNull();
  });

  it("normalizeLang", () => {
    expect(normalizeLang("uk-UA")).toBe("uk");
    expect(normalizeLang("ua")).toBe("uk");
    expect(normalizeLang("EN")).toBe("en");
    expect(normalizeLang("")).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });
});
