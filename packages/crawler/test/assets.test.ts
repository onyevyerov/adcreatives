import { AssetManifest, projectPaths } from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  type AssetCandidate,
  buildSiteAssets,
  readManifest,
  sanitizeSvg,
  sitePriority,
  writeManifest,
} from "../src/assets.ts";
import { computePhash, dominantColors, hammingDistance, imageInfo, isDuplicateHash } from "../src/image.ts";
import { tmpStorage } from "./helpers/context.ts";
import { renderScene } from "./helpers/server.ts";

const candidate = (over: Partial<AssetCandidate> = {}): AssetCandidate => ({
  url: "https://x.com/img.jpg",
  kind: "photo",
  alt: null,
  context: null,
  pageUrl: "https://x.com/",
  pageIndex: 0,
  top: 100,
  renderedWidth: 800,
  renderedHeight: 600,
  svg: null,
  ...over,
});

describe("pHash", () => {
  it("той самий кадр у різних розмірах і якості — дублікат; різні кадри — ні", async () => {
    const big = await renderScene("hero", 1600, 900);
    const small = await sharp(big).resize(400).jpeg({ quality: 40 }).toBuffer();
    const other = await renderScene("lazy", 1600, 900);
    const [a, b, c] = await Promise.all([computePhash(big), computePhash(small), computePhash(other)]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(isDuplicateHash(a, b)).toBe(true);
    expect(isDuplicateHash(a, c)).toBe(false);
    expect(hammingDistance(a as string, c as string)).toBeGreaterThan(10);
  });

  it("hammingDistance", () => {
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistance("ffff", "ffff")).toBe(0);
    expect(hammingDistance("ff", "fff")).toBe(64);
    expect(isDuplicateHash(null, "00")).toBe(false);
  });

  it("не-зображення → null", async () => {
    expect(await computePhash(Buffer.from("not an image"))).toBeNull();
    expect(await imageInfo(Buffer.from("<html></html>"))).toBeNull();
  });
});

describe("кольори й метадані", () => {
  it("домінантні кольори без прозорих пікселів", async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 50, height: 100, channels: 4, background: "#6b3e26" } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    expect(await dominantColors(png)).toEqual(["#6B3E26"]);
  });

  it("imageInfo враховує EXIF-поворот і SVG", async () => {
    const rotated = await sharp({ create: { width: 400, height: 200, channels: 3, background: "#ffffff" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(await imageInfo(rotated)).toMatchObject({
      width: 200,
      height: 400,
      mime: "image/jpeg",
      ext: "jpg",
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"></svg>');
    expect(await imageInfo(svg)).toMatchObject({
      width: 320,
      height: 120,
      mime: "image/svg+xml",
      ext: "svg",
    });
  });
});

describe("buildSiteAssets", () => {
  it("дедуп за pHash лишає найбільший файл з атрибутами пріоритетнішого; дрібні відкидає; ліміт", async () => {
    const storage = tmpStorage();
    const hero1600 = await renderScene("hero", 1600, 900);
    const hero800 = await renderScene("hero", 800, 450);
    const team = await renderScene("team", 1200, 800);
    const og = await renderScene("og", 1200, 630);
    const tiny = await renderScene("lazy", 120, 90);
    const assets = await buildSiteAssets(
      [
        {
          candidate: candidate({ url: "https://x.com/hero-800.jpg", alt: "Бариста", context: "Сніданки" }),
          data: hero800,
        },
        {
          candidate: candidate({ url: "https://x.com/hero-1600.jpg", pageIndex: 2, top: 4000 }),
          data: hero1600,
        },
        { candidate: candidate({ url: "https://x.com/team.jpg", pageIndex: 1 }), data: team },
        { candidate: candidate({ url: "https://x.com/og.jpg", kind: "og" }), data: og },
        { candidate: candidate({ url: "https://x.com/tiny.jpg" }), data: tiny },
        { candidate: candidate({ url: "https://x.com/broken.jpg" }), data: Buffer.from("oops") },
      ],
      { storage, projectId: "p1" },
    );
    expect(assets.map((a) => a.originUrl)).toEqual([
      "https://x.com/hero-1600.jpg",
      "https://x.com/team.jpg",
      "https://x.com/og.jpg",
    ]);
    expect(assets[0]).toMatchObject({
      id: "a01",
      width: 1600,
      height: 900,
      alt: "Бариста",
      context: "Сніданки",
    });
    expect(assets[2]).toMatchObject({ kind: "og", isLogoCandidate: true });
    expect(assets[0]?.path).toBe(projectPaths("p1").asset("a01.jpg"));
    expect(await storage.exists(assets[0]?.path as string)).toBe(true);

    const limited = await buildSiteAssets(
      [
        { candidate: candidate({ url: "https://x.com/a.jpg" }), data: hero1600 },
        { candidate: candidate({ url: "https://x.com/b.jpg" }), data: team },
      ],
      { storage, projectId: "p2", maxAssets: 1 },
    );
    expect(limited).toHaveLength(1);
  });

  it("лого має найвищий пріоритет серед асетів сайту; SVG очищується від скриптів", async () => {
    const storage = tmpStorage();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" onload="alert(1)"><script>alert(2)</script><rect width="200" height="80" fill="#6b3e26"/></svg>';
    const assets = await buildSiteAssets(
      [
        {
          candidate: candidate({ url: "https://x.com/team.jpg" }),
          data: await renderScene("team", 1200, 800),
        },
        { candidate: candidate({ url: "inline-svg:0-0", kind: "logo", svg }), data: Buffer.from(svg) },
      ],
      { storage, projectId: "p1" },
    );
    expect(assets[0]).toMatchObject({
      kind: "logo",
      originUrl: null,
      mime: "image/svg+xml",
      isLogoCandidate: true,
    });
    const stored = await storage.readText(assets[0]?.path as string);
    expect(stored).not.toMatch(/script|onload/i);
    expect(sitePriority(candidate({ kind: "logo" }), 10, 10)).toBeGreaterThan(
      sitePriority(candidate(), 4000, 3000),
    );
  });

  it("sanitizeSvg", () => {
    expect(
      sanitizeSvg('<svg><a href="javascript:alert(1)"><foreignObject><b/></foreignObject></a></svg>'),
    ).toBe('<svg><a href="#"></a></svg>');
  });
});

describe("маніфест", () => {
  it("асети сайту замінюються, фото клієнта зберігаються і йдуть першими", async () => {
    const storage = tmpStorage();
    const base = {
      kind: "photo" as const,
      originUrl: null,
      pageUrl: null,
      mime: "image/jpeg",
      bytes: 1,
      width: 1,
      height: 1,
      phash: null,
      dominantColors: [],
      alt: null,
      context: null,
      isLogoCandidate: false,
    };
    await writeManifest(storage, "p1", {
      site: [{ ...base, id: "a01", source: "site", path: "projects/p1/crawl/assets/a01.jpg", priority: 40 }],
    });
    await writeManifest(storage, "p1", {
      user: [
        {
          ...base,
          id: "u01",
          kind: "user",
          source: "user",
          path: "projects/p1/crawl/assets/u01.jpg",
          priority: 100,
        },
      ],
    });
    await writeManifest(storage, "p1", {
      site: [{ ...base, id: "a01", source: "site", path: "projects/p1/crawl/assets/a01.png", priority: 50 }],
    });
    const m = await readManifest(storage, "p1");
    expect(() => AssetManifest.parse(m)).not.toThrow();
    expect(m.assets.map((a) => [a.id, a.path.slice(-7)])).toEqual([
      ["u01", "u01.jpg"],
      ["a01", "a01.png"],
    ]);
  });
});
