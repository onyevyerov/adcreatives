import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";
import type { ApiDeps } from "../deps.ts";
import { decodeFileKey, parseRange } from "./files.ts";

export const STATIC_PREFIX = "/static/";

/** Лише ці типи; решта розширень → 404, щоб тека не віддавала випадкові файли. */
const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
};

/** `GET /static/*` — CSS, JS і медіа сторінки чату з `public/static/`. */
export function staticHandler(deps: ApiDeps) {
  const root = path.resolve(deps.config.publicDir, "static");
  return async (c: Context) => {
    const pathname = new URL(c.req.url).pathname;
    const key = pathname.startsWith(STATIC_PREFIX)
      ? decodeFileKey(pathname.slice(STATIC_PREFIX.length))
      : null;
    if (!key) return c.text("Недопустимий шлях", 400);
    const abs = path.resolve(root, key);
    if (!abs.startsWith(root + path.sep)) return c.text("Недопустимий шлях", 400);
    const type = STATIC_TYPES[path.extname(abs).toLowerCase()];
    if (!type) return c.text("Файл не знайдено", 404);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return c.text("Файл не знайдено", 404);

    const headers: Record<string, string> = {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      "Last-Modified": info.mtime.toUTCString(),
    };
    if (type === "video/mp4") {
      headers["Accept-Ranges"] = "bytes";
      const rangeHeader = c.req.header("range");
      if (rangeHeader) {
        const range = parseRange(rangeHeader, info.size);
        if (!range) return c.body(null, 416, { ...headers, "Content-Range": `bytes */${info.size}` });
        const body = Readable.toWeb(createReadStream(abs, range)) as unknown as ReadableStream;
        return c.body(body, 206, {
          ...headers,
          "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
          "Content-Length": String(range.end - range.start + 1),
        });
      }
    }
    if (c.req.method === "HEAD")
      return c.body(null, 200, { ...headers, "Content-Length": String(info.size) });
    const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
    return c.body(body, 200, { ...headers, "Content-Length": String(info.size) });
  };
}
