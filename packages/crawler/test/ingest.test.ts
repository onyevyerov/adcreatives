import { AssetManifest, projectPaths, readTrace, StageError } from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { writeManifest } from "../src/assets.ts";
import { ingestUserPhotos, isHeic, MAX_USER_FILE_BYTES } from "../src/ingest.ts";
import { createIngestStage } from "../src/stage.ts";
import { makeContext, tmpStorage } from "./helpers/context.ts";
import { renderScene } from "./helpers/server.ts";

const paths = projectPaths("p1");

/** Мінімальний заголовок HEIC (ftyp heic) — справжній HEVC-файл sharp створити не вміє. */
function fakeHeic(): Buffer {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftyp", 4, "latin1");
  ftyp.write("heic", 8, "latin1");
  ftyp.write("mif1", 16, "latin1");
  ftyp.write("heic", 20, "latin1");
  return Buffer.concat([ftyp, Buffer.alloc(64)]);
}

describe("isHeic", () => {
  it("розпізнає HEIC і не плутає з AVIF/JPEG", async () => {
    expect(isHeic(fakeHeic())).toBe(true);
    const avif = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#fff" } })
      .avif()
      .toBuffer();
    expect(isHeic(avif)).toBe(false);
    expect(isHeic(await renderScene("hero", 32, 32))).toBe(false);
  });
});

describe("ingestUserPhotos", () => {
  it("EXIF-поворот, зменшення до 3000 px, JPEG/PNG, source=user, найвищий пріоритет, дописує маніфест", async () => {
    const storage = tmpStorage();
    // Існуючий асет сайту не має зникнути.
    await writeManifest(storage, "p1", {
      site: [
        {
          id: "a01",
          kind: "photo",
          source: "site",
          path: paths.asset("a01.jpg"),
          originUrl: "https://x.com/a.jpg",
          pageUrl: "https://x.com/",
          mime: "image/jpeg",
          bytes: 10,
          width: 800,
          height: 600,
          phash: null,
          dominantColors: [],
          alt: null,
          context: null,
          isLogoCandidate: false,
          priority: 60,
        },
      ],
    });
    // 4000×2000 з EXIF orientation=6 → після повороту 2000×4000 → зменшення до 1500×3000.
    const big = await sharp(await renderScene("hero", 4000, 2000))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    await storage.write(paths.upload("big.jpg"), big);
    const transparent = await sharp({
      create: { width: 600, height: 400, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    await storage.write(paths.upload("logo.png"), transparent);

    const res = await ingestUserPhotos({
      storage,
      projectId: "p1",
      files: ["big.jpg", paths.upload("logo.png")],
    });
    expect(res.skipped).toEqual([]);
    expect(res.assets.map((a) => a.id)).toEqual(["u01", "u02"]);
    expect(res.assets[0]).toMatchObject({
      kind: "user",
      source: "user",
      width: 1500,
      height: 3000,
      mime: "image/jpeg",
      priority: 100,
      path: paths.asset("u01.jpg"),
    });
    const meta = await sharp(await storage.read(res.assets[0]?.path as string)).metadata();
    expect([meta.width, meta.height]).toEqual([1500, 3000]);
    expect(res.assets[1]).toMatchObject({ mime: "image/png", width: 600, height: 400 });

    const manifest = await storage.readJson(paths.assets, (v) => AssetManifest.parse(v));
    expect(manifest.assets.map((a) => a.id)).toEqual(["u01", "u02", "a01"]);
    // Оригінали лишаються в uploads/.
    expect(await storage.exists(paths.upload("big.jpg"))).toBe(true);
  });

  it("ліміти: понад 10 файлів, понад 25 МБ, не фото, відсутній файл, дубль", async () => {
    const storage = tmpStorage();
    const photo = await renderScene("team", 800, 600);
    const files: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `f${i}.jpg`;
      files.push(name);
      // Перші два — однакові (дубль), решта — різні кадри.
      const scene = i < 2 ? photo : await renderScene(i % 2 ? "lazy" : "og", 600 + i * 40, 400 + i * 7);
      await storage.write(paths.upload(name), scene);
    }
    await storage.write(paths.upload("f2.jpg"), Buffer.alloc(MAX_USER_FILE_BYTES + 1));
    await storage.write(paths.upload("f3.jpg"), Buffer.from("definitely not an image"));
    files[4] = "nope.jpg";

    const res = await ingestUserPhotos({ storage, projectId: "p1", files });
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.file, s.reason]));
    expect(reasons).toMatchObject({
      "f1.jpg": "duplicate",
      "f2.jpg": "too_large",
      "f3.jpg": "not_image",
      "nope.jpg": "missing",
      "f10.jpg": "limit",
      "f11.jpg": "limit",
    });
    expect(res.assets.length).toBeLessThanOrEqual(10);
    expect(res.assets[0]?.id).toBe("u01");

    // Наступне завантаження продовжує нумерацію.
    await storage.write(paths.upload("later.jpg"), await renderScene("bg", 900, 600));
    const again = await ingestUserPhotos({ storage, projectId: "p1", files: ["later.jpg"] });
    expect(again.assets[0]?.id).toBe(`u${String(res.assets.length + 1).padStart(2, "0")}`);
  });

  it("HEIC конвертується в JPEG (конвертер підмінено: sharp не створює HEVC)", async () => {
    const storage = tmpStorage();
    await storage.write(paths.upload("IMG_0001.HEIC"), fakeHeic());
    const jpeg = await sharp(await renderScene("lazy", 3200, 2400))
      .withMetadata({ orientation: 8 })
      .jpeg()
      .toBuffer();
    const convert = vi.fn(async () => jpeg);
    const res = await ingestUserPhotos({
      storage,
      projectId: "p1",
      files: ["IMG_0001.HEIC"],
      heicConvert: convert,
    });
    expect(convert).toHaveBeenCalledOnce();
    expect(res.assets[0]).toMatchObject({ mime: "image/jpeg", width: 2250, height: 3000 });

    const broken = await ingestUserPhotos({
      storage,
      projectId: "p1",
      files: ["IMG_0001.HEIC"],
      heicConvert: async () => {
        throw new Error("bad heic");
      },
    });
    expect(broken.skipped).toEqual([{ file: "IMG_0001.HEIC", reason: "convert_failed" }]);
  });

  it("справжній heic-convert підключено (на некоректному файлі — помилка, а не падіння)", async () => {
    const storage = tmpStorage();
    await storage.write(paths.upload("x.heic"), fakeHeic());
    const res = await ingestUserPhotos({ storage, projectId: "p1", files: ["x.heic"] });
    expect(res.skipped).toEqual([{ file: "x.heic", reason: "convert_failed" }]);
  });
});

describe("ingestStage", () => {
  it("повертає assetIds, пише трейс і повідомляє про пропущені файли", async () => {
    const { ctx, storage, emit } = makeContext("ingest", { files: ["a.jpg", "b.txt"] });
    await storage.write(paths.upload("a.jpg"), await renderScene("og", 1000, 700));
    await storage.write(paths.upload("b.txt"), Buffer.from("hello"));
    const res = await createIngestStage()(ctx);
    expect(res.outputs.assetIds).toEqual(["u01"]);
    expect(res.artifacts).toContain(paths.assets);
    expect(emit.events.some((e) => e.type === "message" && e.text.includes("b.txt"))).toBe(true);
    expect(await readTrace(storage, "p1")).toEqual([expect.objectContaining({ stage: "ingest", ok: true })]);
  });

  it("жодне фото не підійшло → StageError photos_invalid", async () => {
    const { ctx, storage } = makeContext("ingest", { files: ["b.txt"] });
    await storage.write(paths.upload("b.txt"), Buffer.from("hello"));
    const err = await createIngestStage()(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).code).toBe("photos_invalid");
  });
});
