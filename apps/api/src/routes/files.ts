import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { PROJECTS_DIR, type PublicUser, type Storage } from "@adc/shared";
import type { Context } from "hono";
import type { ApiDeps } from "../deps.ts";
import { canSee, isProjectId, projectOwner } from "../intake.ts";
import type { AppEnv } from "../session.ts";

export const FILES_PREFIX = "/files/";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  // HTML із краулу ніколи не рендеримо на нашому походженні.
  ".html": "text/plain; charset=utf-8",
  ".htm": "text/plain; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Ключ сховища з шляху після `/files/`. Кожен сегмент декодується окремо; відкидаються
 * порожні сегменти, `.`/`..`, приховані файли, слеші й `\` усередині сегмента, NUL і
 * диски Windows. Повертає null, якщо шлях недопустимий.
 */
export function decodeFileKey(raw: string): string | null {
  if (!raw) return null;
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!s || s.startsWith(".") || /[\\/\0]/.test(s) || /^[a-zA-Z]:/.test(s)) return null;
    out.push(s);
  }
  return out.join("/");
}

/** `bytes=start-end` → межі (включно) або null, якщо діапазон некоректний. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // SVG/текст із сайтів клієнтів не повинні виконувати скрипти на нашому походженні.
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
};

/**
 * Чи може користувач читати ключ сховища: `projects/<id>/…` — власник проєкту або admin;
 * будь-що інше (`cache/…`, `costs*.jsonl`, `users/…`, `outbox/…`) — лише admin.
 */
export async function canReadKey(storage: Storage, user: PublicUser, key: string): Promise<boolean> {
  if (user.isAdmin) return true;
  const [top, id] = key.split("/");
  if (top !== PROJECTS_DIR || !id || !isProjectId(id)) return false;
  return canSee(user, await projectOwner(storage, id));
}

/** `GET /files/*` — файли лише всередині DATA_DIR і лише ті, до яких має доступ користувач сесії. */
export function filesHandler(deps: ApiDeps) {
  return async (c: Context<AppEnv>) => {
    const pathname = new URL(c.req.url).pathname;
    const key = pathname.startsWith(FILES_PREFIX) ? decodeFileKey(pathname.slice(FILES_PREFIX.length)) : null;
    if (!key) return c.text("Недопустимий шлях", 400);
    let abs: string;
    try {
      abs = deps.storage.absPath(key);
    } catch {
      return c.text("Недопустимий шлях", 400);
    }
    const user = c.get("user");
    if (!user) return c.text("Потрібно увійти.", 401);
    // Чужий і неіснуючий файл — однакова 404, без витоку існування.
    if (!(await canReadKey(deps.storage, user, key))) return c.text("Файл не знайдено", 404);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return c.text("Файл не знайдено", 404);

    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      "Content-Type": contentTypeFor(abs),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    };
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
      const range = parseRange(rangeHeader, info.size);
      if (!range) {
        return c.body(null, 416, { ...headers, "Content-Range": `bytes */${info.size}` });
      }
      const body = Readable.toWeb(createReadStream(abs, range)) as unknown as ReadableStream;
      return c.body(body, 206, {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
        "Content-Length": String(range.end - range.start + 1),
      });
    }
    if (c.req.method === "HEAD")
      return c.body(null, 200, { ...headers, "Content-Length": String(info.size) });
    const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
    return c.body(body, 200, { ...headers, "Content-Length": String(info.size) });
  };
}
