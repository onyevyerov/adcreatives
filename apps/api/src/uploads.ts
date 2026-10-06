import { projectPaths, type Storage } from "@adc/shared";
import { nanoid } from "nanoid";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_REQUEST } from "./config.ts";

/** Значення `c.req.parseBody({ all: true })`. */
export type BodyValue = string | File | Array<string | File>;
export type ParsedBody = Record<string, BodyValue | undefined>;

/** Поля multipart, у яких шукаємо фото. */
const FILE_FIELDS = ["photos", "photos[]", "files", "files[]", "file"];

export function fieldString(value: BodyValue | undefined): string | null {
  const v = Array.isArray(value) ? value.find((x) => typeof x === "string") : value;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Файли з тіла; порожні частини (input file без вибору) відкидаються. */
export function collectFiles(body: ParsedBody): File[] {
  const out: File[] = [];
  for (const field of FILE_FIELDS) {
    const v = body[field];
    for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      if (typeof item !== "string" && item.size > 0) out.push(item);
    }
  }
  return out;
}

export class UploadError extends Error {
  override name = "UploadError";
  constructor(
    public readonly code: "too_many_files" | "file_too_large",
    message: string,
  ) {
    super(message);
  }
}

export function validateFiles(files: readonly File[]): void {
  if (files.length > MAX_PHOTOS_PER_REQUEST) {
    throw new UploadError("too_many_files", `Можна додати до ${MAX_PHOTOS_PER_REQUEST} фото за раз.`);
  }
  const big = files.find((f) => f.size > MAX_PHOTO_BYTES);
  if (big) {
    throw new UploadError(
      "file_too_large",
      `Файл «${big.name}» більший за ${MAX_PHOTO_BYTES / 1024 / 1024} МБ. Надішліть фото до 25 МБ.`,
    );
  }
}

/**
 * Безпечне ім'я файлу в `uploads/`: випадковий префікс (без колізій) + очищене оригінальне ім'я
 * (щоб у повідомленнях про пропущені фото клієнт бачив знайому назву).
 */
export function safeUploadName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext =
    dot > 0
      ? base
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 8)
      : "";
  const stem =
    (dot > 0 ? base.slice(0, dot) : base)
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "photo";
  return `${nanoid(8)}-${stem}${ext ? `.${ext}` : ""}`;
}

/** Зберігає оригінали в `projects/<id>/uploads/`; повертає ключі сховища. */
export async function saveUploads(
  storage: Storage,
  projectId: string,
  files: readonly File[],
): Promise<string[]> {
  const paths = projectPaths(projectId);
  const keys: string[] = [];
  for (const file of files) {
    const key = paths.upload(safeUploadName(file.name));
    await storage.write(key, new Uint8Array(await file.arrayBuffer()));
    keys.push(key);
  }
  return keys;
}
