import { type Asset, type Logger, noopLogger, projectPaths, type Storage } from "@adc/shared";
import { readManifest, USER_PRIORITY, writeManifest } from "./assets.ts";
import { computePhash, dominantColors, imageInfo, isDuplicateHash, sharpOf } from "./image.ts";

/** Ліміти фото клієнта. */
export const MAX_USER_FILES = 10;
export const MAX_USER_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_USER_SIDE = 3000;

/** HEIC → JPEG. За замовчуванням `heic-convert`; у тестах підміняється. */
export type HeicConverter = (input: Buffer) => Promise<Buffer>;

export const defaultHeicConverter: HeicConverter = async (input) => {
  const { default: convert } = await import("heic-convert");
  const out = await convert({ buffer: new Uint8Array(input), format: "JPEG", quality: 0.92 });
  return Buffer.from(out);
};

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** Чи є файл HEIC/HEIF з HEVC (за сигнатурою `ftyp`; AVIF сюди не потрапляє). */
export function isHeic(data: Buffer): boolean {
  if (data.length < 16 || data.toString("latin1", 4, 8) !== "ftyp") return false;
  const boxSize = Math.min(data.readUInt32BE(0), data.length, 256);
  const major = data.toString("latin1", 8, 12);
  const brands = [major];
  for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(data.toString("latin1", i, i + 4));
  if (brands.includes("avif") || brands.includes("avis")) return false;
  return brands.some((b) => HEIC_BRANDS.has(b));
}

export type SkipReason = "limit" | "too_large" | "not_image" | "duplicate" | "missing" | "convert_failed";

export interface IngestResult {
  assets: Asset[];
  skipped: Array<{ file: string; reason: SkipReason }>;
}

export interface IngestOptions {
  storage: Storage;
  projectId: string;
  /** Ключі сховища (`projects/<id>/uploads/<file>`) або імена файлів у `uploads/`. */
  files: string[];
  heicConvert?: HeicConverter;
  logger?: Logger;
}

/**
 * Фото клієнта → асети: до 10 файлів по 25 МБ, HEIC → JPEG, EXIF-поворот, зменшення
 * до 3000 px по довшій стороні. `source: "user"`, пріоритет найвищий. Дописує в
 * `crawl/assets.json`, асети сайту не чіпає. Повторно завантажене фото (той самий
 * pHash) пропускається.
 */
export async function ingestUserPhotos(opts: IngestOptions): Promise<IngestResult> {
  const { storage, projectId } = opts;
  const logger = opts.logger ?? noopLogger;
  const convertHeic = opts.heicConvert ?? defaultHeicConverter;
  const paths = projectPaths(projectId);
  const manifest = await readManifest(storage, projectId);
  const existingUser = manifest.assets.filter((a) => a.source === "user");
  let nextIndex =
    existingUser.reduce((max, a) => Math.max(max, Number.parseInt(a.id.replace(/^u/, ""), 10) || 0), 0) + 1;

  const skipped: IngestResult["skipped"] = [];
  const created: Asset[] = [];
  const files = opts.files.slice(0, MAX_USER_FILES);
  for (const extra of opts.files.slice(MAX_USER_FILES)) skipped.push({ file: extra, reason: "limit" });

  for (const file of files) {
    const key = file.includes("/") ? file : paths.upload(file);
    if (!(await storage.exists(key))) {
      skipped.push({ file, reason: "missing" });
      continue;
    }
    let data = await storage.read(key);
    if (data.length > MAX_USER_FILE_BYTES) {
      skipped.push({ file, reason: "too_large" });
      continue;
    }
    if (isHeic(data)) {
      try {
        data = await convertHeic(data);
      } catch (err) {
        logger.warn("HEIC не сконвертувався", { file, error: (err as Error).message });
        skipped.push({ file, reason: "convert_failed" });
        continue;
      }
    }
    const info = await imageInfo(data);
    if (!info) {
      skipped.push({ file, reason: "not_image" });
      continue;
    }
    let out: { data: Buffer; info: { width: number; height: number } };
    let ext: "jpg" | "png";
    try {
      const meta = await sharpOf(data).metadata();
      // Прозорість зберігаємо в PNG, решта — JPEG.
      const keepAlpha =
        Boolean(meta.hasAlpha) && (info.format === "png" || info.format === "webp" || info.format === "svg");
      ext = keepAlpha ? "png" : "jpg";
      const pipeline = sharpOf(data)
        .rotate()
        .resize({ width: MAX_USER_SIDE, height: MAX_USER_SIDE, fit: "inside", withoutEnlargement: true });
      out = await (keepAlpha
        ? pipeline.png()
        : pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 88, mozjpeg: true })
      ).toBuffer({
        resolveWithObject: true,
      });
    } catch (err) {
      logger.warn("фото не обробилось", { file, error: (err as Error).message });
      skipped.push({ file, reason: "not_image" });
      continue;
    }
    const phash = await computePhash(out.data);
    if ([...existingUser, ...created].some((a) => isDuplicateHash(a.phash, phash))) {
      skipped.push({ file, reason: "duplicate" });
      continue;
    }
    const id = `u${String(nextIndex++).padStart(2, "0")}`;
    const assetKey = paths.asset(`${id}.${ext}`);
    await storage.write(assetKey, out.data);
    created.push({
      id,
      kind: "user",
      source: "user",
      path: assetKey,
      originUrl: null,
      pageUrl: null,
      mime: ext === "png" ? "image/png" : "image/jpeg",
      bytes: out.data.length,
      width: out.info.width,
      height: out.info.height,
      phash,
      dominantColors: await dominantColors(out.data),
      alt: null,
      context: null,
      isLogoCandidate: false,
      priority: USER_PRIORITY,
    });
  }

  if (created.length > 0) await writeManifest(storage, projectId, { user: [...existingUser, ...created] });
  return { assets: created, skipped };
}
