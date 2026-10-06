import { AssetManifest, projectPaths, readTrace, SiteData, StageError } from "@adc/shared";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrawlFailedError, type CrawlResult, crawlSite } from "../src/crawl.ts";
import { createCrawlStage } from "../src/stage.ts";
import { makeContext, tmpStorage } from "./helpers/context.ts";
import { type FixtureServers, startFixtureServers, testHostMap, testResolver } from "./helpers/server.ts";

const net = { resolve: testResolver, hostMap: testHostMap };

let servers: FixtureServers;
let result: CrawlResult;
const storage = tmpStorage();
const progress: Array<{ phase: string; done: number; total: number }> = [];

beforeAll(async () => {
  servers = await startFixtureServers();
  result = await crawlSite(`${servers.origin}/`, {
    ...net,
    storage,
    projectId: "p1",
    onProgress: (p) => {
      progress.push(p);
    },
  });
}, 120_000);

afterAll(async () => {
  await servers?.close();
});

const pagePaths = () => result.site.pages.map((p) => new URL(p.url).pathname);

describe("crawlSite на фікстурі", () => {
  it("повертає валідний SiteData з головною першою", () => {
    expect(() => SiteData.parse(result.site)).not.toThrow();
    expect(result.site.source).toBe("site");
    expect(result.site.partial).toBe(false);
    expect(result.site.finalUrl).toBe(`${servers.origin}/`);
    expect(pagePaths()[0]).toBe("/");
    const home = result.site.pages[0];
    expect(home?.title).toBe("Зерно — кав'ярня у Львові");
    expect(home?.description).toBe("Спешелті кава і випічка щодня з 8:00");
    expect(home?.og["og:title"]).toBe("Зерно");
    expect(home?.headings).toContainEqual({ level: 1, text: "Кава, яку обсмажуємо самі" });
    expect(home?.buttons).toContain("Забронювати столик");
    expect(result.site.stats.pagesVisited).toBe(result.site.pages.length);
  });

  it("обирає сторінки того самого сайту (з www), пропускає файли, пагінацію, фільтри, календарі й піддомени", () => {
    const paths = pagePaths();
    expect(paths).toEqual(
      expect.arrayContaining(["/about", "/menu", "/services", "/contacts", "/team", "/reviews"]),
    );
    expect(result.site.pages.some((p) => p.url.includes("www.site.test"))).toBe(true);
    for (const bad of ["/blog/page/2", "/catalog", "/files/price.pdf", "/events/calendar", "/blog/page/3"]) {
      expect(paths).not.toContain(bad);
    }
    expect(result.site.pages.some((p) => p.url.includes("blog.site.test"))).toBe(false);
    expect(servers.hits.some((h) => h.host.startsWith("blog.site.test"))).toBe(false);
  });

  it("краулить лише мовну версію введеної адреси, решту записує в languageVersions", () => {
    expect(result.site.language).toBe("uk");
    expect(pagePaths().some((p) => p.startsWith("/en"))).toBe(false);
    expect(result.site.languageVersions).toEqual([
      { lang: "uk", url: `${servers.origin}/` },
      { lang: "en", url: `${servers.origin}/en/` },
    ]);
  });

  it("закриває cookie-банер до знімка першого екрана", async () => {
    expect(servers.hits.some((h) => h.path === "/consent-accepted")).toBe(true);
    const first = result.site.screenshots.find(
      (s) => s.viewport === "first" && new URL(s.pageUrl).pathname === "/",
    );
    expect(first).toBeDefined();
    const { data, info } = await sharp(await storage.read(first?.path as string))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(1440);
    expect(info.height).toBe(900);
    let red = 0;
    for (let i = 0; i < data.length; i += 3) {
      if ((data[i] as number) > 220 && (data[i + 1] as number) < 40 && (data[i + 2] as number) < 40) red++;
    }
    expect(red / (info.width * info.height)).toBeLessThan(0.01);
  });

  it("знімає перший екран кожної сторінки і ще два екрани головної", () => {
    const shots = result.site.screenshots;
    const home = shots.filter((s) => new URL(s.pageUrl).pathname === "/").map((s) => s.viewport);
    expect(home).toEqual(["first", "below-1", "below-2"]);
    expect(shots.filter((s) => s.viewport === "first")).toHaveLength(result.site.pages.length);
    for (const s of shots) {
      expect(s.path.startsWith(projectPaths("p1").screenshotsDir)).toBe(true);
      expect([s.width, s.height]).toEqual([1440, 900]);
    }
    for (const p of result.site.pages) expect(p.screenshot).not.toBeNull();
  });

  it("прокручує сторінку для lazy-load", () => {
    const lazyHit = servers.hits.find(
      (h) => h.path === "/img/lazy-photo.jpg" && !h.ua.includes("AdCreativeBot"),
    );
    expect(lazyHit).toBeDefined();
    expect(result.assets.some((a) => a.originUrl?.endsWith("/img/lazy-photo.jpg"))).toBe(true);
  });

  it("витягує текст без шапки/футера, JSON-LD, контакти, навігацію", () => {
    const about = result.site.pages.find((p) => p.url.endsWith("/about"));
    expect(about?.text).toContain("Ми відкрились у 2015 році");
    expect(about?.text).not.toContain("Footer text");
    const home = result.site.pages[0];
    expect(home?.jsonLd).toEqual([expect.objectContaining({ "@type": "CafeOrCoffeeShop", name: "Зерно" })]);
    expect(result.site.contacts.phones).toEqual(["+380671234567"]);
    expect(result.site.contacts.emails).toEqual(["hello@zerno.test"]);
    expect(result.site.contacts.socials.map((s) => s.network)).toEqual(
      expect.arrayContaining(["instagram", "telegram"]),
    );
    expect(result.site.contacts.addresses).toContain("Львів, вул. Руська, 1");
    expect(result.site.navigation.map((n) => n.text)).toEqual(
      expect.arrayContaining(["Про нас", "Меню", "Послуги", "Контакти"]),
    );
  });

  it("збирає дизайн із computed styles", () => {
    const design = result.site.design;
    expect(design?.cssVars).toMatchObject({ "--brand": "#6b3e26", "--accent": "#e85d2a" });
    expect(design?.colors).toContainEqual(expect.objectContaining({ role: "button", value: "#6B3E26" }));
    expect(design?.colors).toContainEqual(expect.objectContaining({ role: "background", value: "#FFF8F0" }));
    expect(design?.colors).toContainEqual(expect.objectContaining({ role: "link", value: "#E85D2A" }));
    expect(design?.fonts).toContainEqual({ role: "h1", family: "Arial", weight: 700 });
    expect(design?.fonts).toContainEqual(expect.objectContaining({ role: "body", family: "Georgia" }));
    expect(design?.buttonRadius).toBe("999px");
  });

  it("збирає асети: лого, іконку, og, фото (найбільший srcset), CSS-фон; дедуп за pHash", async () => {
    const byOrigin = (suffix: string) => result.assets.filter((a) => a.originUrl?.endsWith(suffix));
    const logo = byOrigin("/img/logo.svg")[0];
    expect(logo).toMatchObject({ kind: "logo", isLogoCandidate: true, mime: "image/svg+xml" });
    // Скрипти з SVG вирізано.
    expect((await storage.readText(logo?.path as string)).includes("<script")).toBe(false);
    expect(byOrigin("/img/touch-icon.png")[0]).toMatchObject({ kind: "icon", isLogoCandidate: true });
    expect(byOrigin("/img/og.jpg")[0]).toMatchObject({ kind: "og" });
    expect(byOrigin("/img/bg.jpg")[0]).toMatchObject({ kind: "background", width: 1920 });
    // Три варіанти одного кадру (800, 1600, копія 640) → один асет у найбільшому розмірі.
    const hero = result.assets.filter((a) => a.originUrl?.includes("/img/hero"));
    expect(hero).toHaveLength(1);
    expect(hero[0]).toMatchObject({ width: 1600, height: 900, alt: "Бариста готує капучино", kind: "photo" });
    expect(hero[0]?.context).toContain("Сніданки до 12:00");
    const team = byOrigin("/img/team.jpg")[0];
    expect(team?.context).toBe("Наша команда");
    for (const a of result.assets) {
      expect(a.source).toBe("site");
      expect(a.id).toMatch(/^a\d{2}$/);
      expect(await storage.exists(a.path)).toBe(true);
      expect(a.dominantColors.length).toBeGreaterThan(0);
    }
    expect(result.assets.length).toBeLessThanOrEqual(40);
  });

  it("обриває запити сторінки до приватних адрес", () => {
    expect(result.blocked.some((u) => u.startsWith(servers.internalOrigin))).toBe(true);
    expect(servers.internalHits).toEqual([]);
  });

  it("повідомляє прогрес по сторінках", () => {
    const pages = progress.filter((p) => p.phase === "pages");
    expect(pages.at(-1)).toMatchObject({ done: pages.at(-1)?.total });
    expect(pages[0]?.done).toBe(1);
  });
});

describe("безпека й збої", () => {
  it("блокує редирект на 127.0.0.1 і не доходить до внутрішнього сервісу", async () => {
    const hitsBefore = servers.internalHits.length;
    const err = await crawlSite(`${servers.origin}/redirect-internal`, {
      ...net,
      storage: tmpStorage(),
      projectId: "p2",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlFailedError);
    expect((err as CrawlFailedError).reason).toBe("unsafe_url");
    expect(servers.internalHits.length).toBe(hitsBefore);
    expect(servers.hits.some((h) => h.path === "/redirect-internal")).toBe(true);
  });

  it("відхиляє приватну адресу ще до запуску браузера", async () => {
    const err = await crawlSite(`${servers.internalOrigin}/`, {
      ...net,
      storage: tmpStorage(),
      projectId: "p3",
    }).catch((e: unknown) => e);
    expect((err as CrawlFailedError).reason).toBe("unsafe_url");
    expect(servers.internalHits).toEqual([]);
  });

  it("недоступна головна → crawl_failed у стадії", async () => {
    const { ctx } = makeContext("crawl", { url: `${servers.origin}/missing-page`, manualText: null });
    const err = await createCrawlStage(net)(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).code).toBe("crawl_failed");
    const trace = await readTrace(ctx.storage, "p1");
    expect(trace).toEqual([expect.objectContaining({ stage: "crawl", ok: false })]);
  });

  it("недоступний сайт + текст клієнта → ручний режим", async () => {
    const { ctx, storage: s } = makeContext("crawl", {
      url: `${servers.origin}/missing-page`,
      manualText: "Кав'ярня Зерно у Львові. Телефон +380 67 123 45 67",
    });
    const res = await createCrawlStage(net)(ctx);
    expect(res.outputs).toMatchObject({ mode: "manual", pages: 0 });
    const site = await s.readJson(projectPaths("p1").site, (v) => SiteData.parse(v));
    expect(site.source).toBe("manual");
    expect(site.contacts.phones).toEqual(["+380 67 123 45 67"]);
  });

  it("ліміт часу: головна є, решта не встигла → partial", async () => {
    const res = await crawlSite(`${servers.origin}/slowsite/`, {
      ...net,
      storage: tmpStorage(),
      projectId: "p4",
      timeBudgetMs: 9_000,
    });
    expect(res.site.partial).toBe(true);
    expect(res.site.pages[0]?.title).toBe("Повільний сайт");
    expect(res.site.pages.some((p) => p.url.includes("/slow/"))).toBe(false);
    expect(res.site.stats.durationMs).toBeLessThan(20_000);
  }, 40_000);
});

describe("crawlStage", () => {
  it("пише site.json, assets.json, прогрес і трейс", async () => {
    const { ctx, storage: s, emit } = makeContext("crawl", { url: `${servers.origin}/`, manualText: null });
    const res = await createCrawlStage({ ...net, maxPages: 3 })(ctx);
    expect(res.outputs.mode).toBe("site");
    expect(res.outputs.pages).toBe(3);
    expect(res.outputs.photos).toBeGreaterThanOrEqual(2);
    const paths = projectPaths("p1");
    expect(res.artifacts).toEqual(expect.arrayContaining([paths.site, paths.assets]));
    const site = await s.readJson(paths.site, (v) => SiteData.parse(v));
    // Пріоритизація: з навігації першими «Про нас», «Меню», «Послуги».
    expect(site.pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/about", "/menu"]);
    const manifest = await s.readJson(paths.assets, (v) => AssetManifest.parse(v));
    expect(manifest.assets.length).toBeGreaterThan(0);
    const labels = emit.events
      .filter((e) => e.type === "progress")
      .map((e) => (e as { label: string }).label);
    expect(labels).toContain("Сканую сайт… 3/3");
    const trace = await readTrace(s, "p1");
    expect(trace).toEqual([expect.objectContaining({ stage: "crawl", ok: true })]);
  }, 60_000);
});
