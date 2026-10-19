import { z } from "zod";
import { EpidemicError, type EpidemicLike, type EpidemicRequestOptions } from "../provider.ts";
import { epidemicKindForStatus } from "./errors.ts";

/**
 * HTTP-клієнт Partner API Epidemic Sound на `fetch` (без SDK).
 *
 * - база `https://api.epidemicsound.com`, перевизначення — `EPIDEMIC_API_BASE` (тести/проксі);
 * - API-ключ напряму `Authorization: Bearer <ключ>`, без обміну на токени;
 * - повторювані query-ключі (`vocalType=NONE&vocalType=…`) — через `URLSearchParams.append`;
 * - таймаут `o.timeoutMs` (дефолт 30 с, `fetchBytes` — 120 с) разом із сигналом викликача;
 * - відповіді валідуються мінімально: лише потрібні поля, зайві ігноруються;
 * - помилки — `EpidemicError` (401/403 unauthorized, 404 not_found, 429 rate_limited, 5xx server,
 *   мережа/таймаут network, скасування aborted). Повтори — справа `EpidemicGate`, не клієнта.
 */

export const EPIDEMIC_API_BASE = "https://api.epidemicsound.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const BYTES_TIMEOUT_MS = 120_000;

const Named = z.object({ id: z.coerce.string(), name: z.string() });
const NamedList = z
  .array(Named)
  .nullish()
  .transform((v) => v ?? []);

/** Артист може прийти рядком або об'єктом з `name` — нормалізуємо до рядка. */
const Artist = z.union([z.string(), z.object({ name: z.string() }).transform((a) => a.name)]);

const TrackSchema = z.object({
  id: z.coerce.string(),
  title: z.string(),
  mainArtists: z
    .array(Artist)
    .nullish()
    .transform((v) => v ?? []),
  bpm: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
  length: z.number(),
  moods: NamedList,
  genres: NamedList,
  hasVocals: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
});

const SoundEffectSchema = z.object({
  id: z.coerce.string(),
  title: z.string(),
  length: z.number(),
});

const TracksResponse = z.object({ tracks: z.array(TrackSchema) });
const SoundEffectsResponse = z.object({ soundEffects: z.array(SoundEffectSchema) });
const DownloadResponse = z.object({ url: z.string().min(1), expires: z.string() });
const StartVersionResponse = z.object({ jobId: z.coerce.string(), status: z.string() });
const VersionStatusResponse = z.object({
  status: z.string(),
  results: z.object({ previewUrl: z.string().optional(), highQualityUrl: z.string().optional() }).nullish(),
  message: z.string().optional(),
});

type Query = Record<string, string | number | ReadonlyArray<string | number> | undefined>;

function apiBase(): string {
  const raw = process.env.EPIDEMIC_API_BASE?.trim() || EPIDEMIC_API_BASE;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function buildUrl(pathname: string, query: Query = {}): URL {
  const url = new URL(pathname.replace(/^\//, ""), apiBase());
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
  }
  return url;
}

/** Без `undefined`-значень (у URL не має потрапити `limit=undefined`). */
function defined<T extends object>(q: T): Query {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as Query;
}

function withoutSecrets(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

async function bodySnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

export function createEpidemicClient(
  apiKey: string | undefined = process.env.EPIDEMIC_API_KEY,
  fetchImpl: typeof fetch = fetch,
): EpidemicLike {
  const key = apiKey?.trim();
  if (!key) throw new EpidemicError("unauthorized", "Epidemic: немає EPIDEMIC_API_KEY");

  /** Один HTTP-виклик: таймаут + сигнал викликача, мапінг помилок у `EpidemicError`. */
  async function send(
    url: URL,
    init: RequestInit,
    o: EpidemicRequestOptions | undefined,
    defaultTimeoutMs: number,
  ): Promise<Response> {
    const label = withoutSecrets(url);
    if (o?.signal?.aborted) {
      throw new EpidemicError("aborted", `Epidemic: скасовано (${label})`, null, { cause: o.signal.reason });
    }
    const timeoutMs = o?.timeoutMs ?? defaultTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = o?.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal });
    } catch (err) {
      if (o?.signal?.aborted) {
        throw new EpidemicError("aborted", `Epidemic: скасовано (${label})`, null, { cause: err });
      }
      if (timeout.aborted) {
        throw new EpidemicError("network", `Epidemic: таймаут ${timeoutMs} мс (${label})`, null, {
          cause: err,
        });
      }
      const kind = err instanceof TypeError ? "network" : "other";
      throw new EpidemicError(kind, `Epidemic: ${(err as Error)?.message ?? String(err)} (${label})`, null, {
        cause: err,
      });
    }
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      throw new EpidemicError(
        epidemicKindForStatus(res.status),
        `Epidemic: HTTP ${res.status} (${init.method ?? "GET"} ${label})${snippet ? `: ${snippet}` : ""}`,
        res.status,
      );
    }
    return res;
  }

  async function api<S extends z.ZodType>(
    schema: S,
    method: "GET" | "POST",
    pathname: string,
    o: EpidemicRequestOptions | undefined,
    query?: Query,
    body?: unknown,
  ): Promise<z.output<S>> {
    const url = buildUrl(pathname, query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await send(
      url,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      o,
      DEFAULT_TIMEOUT_MS,
    );
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new EpidemicError("other", `Epidemic: відповідь не JSON (${withoutSecrets(url)})`, res.status, {
        cause: err,
      });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new EpidemicError(
        "other",
        `Epidemic: неочікувана форма відповіді (${withoutSecrets(url)}): ${parsed.error.message.slice(0, 300)}`,
        res.status,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  const id = (v: string) => encodeURIComponent(v);

  return {
    searchTracks: (q, o) => api(TracksResponse, "GET", "/v0/tracks/search", o, defined(q)),
    trackDownloadUrl: (trackId, q, o) =>
      api(DownloadResponse, "GET", `/v0/tracks/${id(trackId)}/download`, o, {
        format: "mp3",
        quality: q.quality,
      }),
    startVersion: (body, o) =>
      api(StartVersionResponse, "POST", "/v0/tracks/versions", o, undefined, {
        trackId: body.trackId,
        durationMs: body.durationMs,
      }),
    versionStatus: async (jobId, o) => {
      const r = await api(VersionStatusResponse, "GET", `/v0/tracks/versions/${id(jobId)}`, o);
      return {
        status: r.status,
        ...(r.results !== undefined ? { results: r.results } : {}),
        ...(r.message !== undefined ? { message: r.message } : {}),
      };
    },
    searchSoundEffects: (q, o) => api(SoundEffectsResponse, "GET", "/v0/sound-effects/search", o, defined(q)),
    soundEffectDownloadUrl: (sfxId, q, o) =>
      api(DownloadResponse, "GET", `/v0/sound-effects/${id(sfxId)}/download`, o, { quality: q.quality }),
    fetchBytes: async (url, o) => {
      // Підписаний URL CDN: без Authorization (ключ не має йти сторонньому хосту).
      const target = new URL(url);
      const res = await send(target, { method: "GET" }, o, BYTES_TIMEOUT_MS);
      try {
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (o?.signal?.aborted)
          throw new EpidemicError("aborted", "Epidemic: скасовано", null, { cause: err });
        throw new EpidemicError(
          "network",
          `Epidemic: обірване завантаження (${withoutSecrets(target)})`,
          null,
          {
            cause: err,
          },
        );
      }
    },
  };
}
