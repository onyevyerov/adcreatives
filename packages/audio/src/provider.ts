import type { AudioPlan, CostRecorder, Logger, StageContext, Storage } from "@adc/shared";
import { z } from "zod";
import type { EpidemicGate } from "./epidemic/gate.ts";
import type { EnsuredMusic, MusicDeps } from "./music.ts";
import type { CueDefinition, SfxDeps, SfxFile } from "./sfx.ts";

/**
 * Провайдери музики і SFX (тест Epidemic Sound поруч з ElevenLabs): мінімальний клієнт Partner API
 * Epidemic, квота завантажень і сигнатури функцій провайдера, які викликає стадія `audio`.
 * Epidemic не генерує — шукає готовий трек чи семпл у каталозі, підганяє трек під тривалість і
 * завантажує; кожне завантаження лічиться (безкоштовний тариф — 50).
 */

/** Трек каталогу (`GET /v0/tracks/search`), лише потрібні поля. */
export interface EpidemicTrack {
  id: string;
  title: string;
  mainArtists: string[];
  bpm: number | null;
  /** Тривалість, с. */
  length: number;
  moods: Array<{ id: string; name: string }>;
  genres: Array<{ id: string; name: string }>;
  hasVocals: boolean;
}

/** Семпл каталогу (`GET /v0/sound-effects/search`). */
export interface EpidemicSoundEffect {
  id: string;
  title: string;
  /** Тривалість, с. */
  length: number;
}

export interface EpidemicRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Мінімальний клієнт Partner API; справжній — HTTP (`createEpidemicClient`), у тестах — `mockEpidemic()`. */
export interface EpidemicLike {
  searchTracks(
    q: {
      term: string;
      bpmMin?: number;
      bpmMax?: number;
      vocalType?: Array<"NONE" | "PRESENCE" | "LEAD">;
      sort?: "Relevance" | "BPM" | "Duration" | "Popularity";
      order?: "asc" | "desc";
      limit?: number;
      offset?: number;
    },
    o?: EpidemicRequestOptions,
  ): Promise<{ tracks: EpidemicTrack[] }>;
  /** Кожен виклик — завантаження (лічиться квотою). */
  trackDownloadUrl(
    trackId: string,
    q: { quality: "normal" | "high" },
    o?: EpidemicRequestOptions,
  ): Promise<{ url: string; expires: string }>;
  /** Бета `POST /v0/tracks/versions`: підгонка треку під тривалість. */
  startVersion(
    body: { trackId: string; durationMs: number },
    o?: EpidemicRequestOptions,
  ): Promise<{ jobId: string; status: string }>;
  versionStatus(
    jobId: string,
    o?: EpidemicRequestOptions,
  ): Promise<{
    status: string;
    results?: { previewUrl?: string; highQualityUrl?: string } | null;
    message?: string;
  }>;
  searchSoundEffects(
    q: {
      term: string;
      sort?: "best-match" | "length" | "popular";
      order?: "asc" | "desc";
      limit?: number;
      offset?: number;
    },
    o?: EpidemicRequestOptions,
  ): Promise<{ soundEffects: EpidemicSoundEffect[] }>;
  /** Кожен виклик — завантаження (лічиться квотою). */
  soundEffectDownloadUrl(
    id: string,
    q: { quality: "normal" | "high" },
    o?: EpidemicRequestOptions,
  ): Promise<{ url: string; expires: string }>;
  /** Байти за підписаним URL (не рахується клієнтом — рахує квота). */
  fetchBytes(url: string, o?: EpidemicRequestOptions): Promise<Buffer>;
}

/** Класифікація помилок Epidemic (як `classifyElevenLabsError`): для черги й зрозумілих `StageError`. */
export type EpidemicErrorKind =
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "server"
  | "network"
  | "aborted"
  | "quota"
  | "other";

export class EpidemicError extends Error {
  override name = "EpidemicError";
  readonly kind: EpidemicErrorKind;
  /** HTTP-статус відповіді; null — до відповіді (мережа, квота, немає ключа). */
  readonly status: number | null;

  constructor(
    kind: EpidemicErrorKind,
    message: string = `Epidemic: ${kind}`,
    status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.kind = kind;
    this.status = status;
  }
}

/** Ліміт завантажень безкоштовного тарифу і поріг, на якому прогін зупиняється. */
export const EPIDEMIC_DOWNLOAD_LIMIT = 50;
export const EPIDEMIC_DOWNLOAD_SOFT_LIMIT = 45;
export const EpidemicDownloadKind = z.enum(["track", "version", "version_fetch", "sfx"]);
export type EpidemicDownloadKind = z.infer<typeof EpidemicDownloadKind>;

/** Файл лічильника в теці Epidemic (поза DATA_DIR прогону). */
export const EPIDEMIC_DOWNLOADS_FILE = "downloads.json";
export const EpidemicDownloadsFile = z.object({
  version: z.literal(1),
  used: z.number().int().min(0),
  events: z.array(
    z.object({
      ts: z.string(),
      kind: EpidemicDownloadKind,
      id: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});
export type EpidemicDownloadsFile = z.infer<typeof EpidemicDownloadsFile>;

/** Локальний лічильник завантажень (поза DATA_DIR прогону). */
export interface EpidemicQuota {
  /** Поточне значення лічильника. */
  used(): Promise<number>;
  /**
   * Перед платним кроком: якщо `used() ≥ EPIDEMIC_DOWNLOAD_SOFT_LIMIT` — `EpidemicError` kind "quota"
   * (стадія перетворює на `StageError("epidemic_quota")`, не retryable). Інакше інкремент + рядок
   * журналу; повертає нове значення.
   */
  consume(kind: EpidemicDownloadKind, id: string, detail?: string): Promise<number>;
}

/** Усе, що потрібно провайдеру Epidemic понад `MusicDeps`/`SfxDeps`. */
export interface EpidemicDeps {
  /** Ліниво: без ключа падає лише при реальному виклику. */
  client: () => EpidemicLike;
  quota: EpidemicQuota;
  /** Постійний кеш завантажень (`ADC_EPIDEMIC_DIR`), не DATA_DIR прогону. */
  cache: Storage;
  gate: EpidemicGate;
  /**
   * Режим «лише кеш» (`ADC_EPIDEMIC_CACHE_ONLY=1`): жодних запитів і завантажень — лише те, що вже
   * лежить у `cache`; чого немає — подія без звуку (SFX) або помилка квоти (музика).
   */
  cacheOnly?: boolean;
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Повідомлення, коли режим «лише кеш» не пускає завантаження. */
export const EPIDEMIC_CACHE_ONLY_MESSAGE =
  "Epidemic: режим «лише кеш» (ADC_EPIDEMIC_CACHE_ONLY=1) — нових завантажень немає";

/** Квота, що не пускає жодного завантаження (режим «лише кеш»). */
export function cacheOnlyQuota(inner: EpidemicQuota): EpidemicQuota {
  return {
    used: () => inner.used(),
    consume: async () => {
      throw new EpidemicError("quota", EPIDEMIC_CACHE_ONLY_MESSAGE);
    },
  };
}

/** Музика: та сама форма результату, що в `ensureMusic` (`music.ts`). */
export type EnsureMusicFn = (
  deps: MusicDeps & { epidemic: EpidemicDeps; llm: StageContext<"audio">["llm"]; targetBpm: number },
  projectId: string,
  plan: AudioPlan,
  briefHash: string,
) => Promise<EnsuredMusic>;

/** SFX: які варіанти реально прозвучать — вирішує стадія і просить лише їх. */
export interface SfxVariantRequest {
  cue: string;
  /** 1-based. */
  variant: number;
  def: CueDefinition;
  custom: boolean;
}

export type EnsureSfxVariantsFn = (
  deps: SfxDeps & { epidemic: EpidemicDeps; cost: CostRecorder; projectId: string },
  requests: readonly SfxVariantRequest[],
) => Promise<Array<{ cue: string; variant: number; file: SfxFile; epidemicId: string; title: string }>>;
