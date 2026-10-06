import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { UnsafeUrlError } from "@adc/shared";
import type { UrlGuard } from "./guard.ts";

/** User-Agent для запитів із Node (sitemap, картинки). */
export const CRAWLER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 AdCreativeBot/0.1";

/** `lookup` для http(s).request/net.connect, що з'єднується лише з перевіреною IP. */
export function pinnedLookup(guard: UrlGuard): LookupFunction {
  return (hostname, options, callback) => {
    guard.resolveTarget(hostname).then(
      (ip) => {
        const family = isIP(ip) === 6 ? 6 : 4;
        if (options.all)
          (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
            { address: ip, family },
          ]);
        else callback(null, ip, family);
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, "", 4),
    );
  };
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  /** Максимальний розмір тіла; більше — помилка. */
  maxBytes?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SafeFetchResponse {
  /** Адреса після редиректів. */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class FetchError extends Error {
  override name = "FetchError";
}

/**
 * GET із Node з перевіркою кожного редиректу: протокол, приватні адреси, DNS;
 * з'єднання — лише з перевіреною IP.
 */
export async function safeFetch(
  guard: UrlGuard,
  input: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = input;
  for (let hop = 0; ; hop++) {
    let url: URL;
    try {
      url = await guard.assert(current);
      await guard.resolveTarget(url.hostname);
    } catch (err) {
      if (err instanceof UnsafeUrlError) guard.noteBlocked(current);
      throw err;
    }
    const res = await requestOnce(guard, url, opts);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= maxRedirects) throw new FetchError(`забагато редиректів: ${input}`);
      current = new URL(location, url).href;
      continue;
    }
    return { ...res, url: url.href };
  }
}

function requestOnce(
  guard: UrlGuard,
  url: URL,
  opts: SafeFetchOptions,
): Promise<Omit<SafeFetchResponse, "url">> {
  const maxBytes = opts.maxBytes ?? 30 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(guard),
        headers: {
          "user-agent": CRAWLER_USER_AGENT,
          accept: "*/*",
          "accept-encoding": "identity",
          ...opts.headers,
        },
        timeout: timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          reject(new FetchError(`файл завеликий: ${declared} байт`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new FetchError(`файл завеликий: понад ${maxBytes} байт`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FetchError(`час очікування вичерпано: ${url.href}`)));
    req.on("error", reject);
    req.end();
  });
}
