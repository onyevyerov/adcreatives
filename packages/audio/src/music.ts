import {
  type AudioPlan,
  type CostRecorder,
  type Logger,
  MusicMeta,
  type MusicTrackCheck,
  noopLogger,
  projectPaths,
  type Storage,
} from "@adc/shared";
import {
  type CompositionPlanV2,
  type ElevenLabsLike,
  type ElevenLabsRequestOptions,
  receiveAudio,
} from "./client.ts";
import {
  FORMAT_FALLBACK,
  MAX_MUSIC_RETRIES,
  MUSIC_MODEL_ID,
  MUSIC_OUTPUT_FORMAT,
  MUSIC_TIMEOUT_SECONDS,
  MUSIC_WINDOW_TAIL_MS,
  type OutputFormat,
} from "./constants.ts";
import { audioExt, type DecodeAudio, decodeAudio } from "./decode.ts";
import { classifyElevenLabsError, type ElevenLabsErrorInfo } from "./errors.ts";
import type { ElevenLabsGate } from "./gate.ts";
import { pcmLength, type StereoPcm } from "./pcm.ts";
import { musicPlanHash, planBpm, planTrackMs, planVideoMs, toCompositionPlan } from "./plan.ts";
import { betterCheck, checkTrack, chooseWindowOffset, cutWindow } from "./trackCheck.ts";
import { encodeWav } from "./wav.ts";

export interface MusicDeps {
  storage: Storage;
  client: () => ElevenLabsLike;
  gate: ElevenLabsGate;
  cost: CostRecorder;
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
  /** Декодер треку для перевірки й обрізання; дефолт — ffmpeg зі збірки Remotion. */
  decode?: DecodeAudio;
}

export interface GeneratedMusic {
  /** mp3 як є або WAV (PCM, загорнутий одразу після отримання). */
  audio: Buffer;
  /** Формат, у якому трек реально отримано (після фолбеку — `FORMAT_FALLBACK`). */
  outputFormat: OutputFormat;
  method: MusicMeta["method"];
  /** Промпт, що реально спрацював (compose), або null для composeDetailed. */
  promptUsed: string | null;
  durationMs: number;
}

export interface GenerateOptions {
  /** Номер спроби (1 — перша); з 2-ї — у `detail` витрат, щоб кожна спроба була окремим рядком. */
  attempt?: number;
}

function isV2Plan(v: unknown): v is CompositionPlanV2 {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { chunks?: unknown }).chunks) &&
    (v as { chunks: unknown[] }).chunks.length > 0
  );
}

function planMs(plan: CompositionPlanV2): number {
  return plan.chunks.reduce(
    (a, c) => a + ("durationMs" in c && typeof c.durationMs === "number" ? c.durationMs : 0),
    0,
  );
}

/** Відхилений запит (промпт чи план), а не збій мережі чи ключа: є сенс спробувати інший шлях. */
const isRejected = (info: ElevenLabsErrorInfo) =>
  info.kind === "bad_prompt" || (info.kind === "other" && (info.status === 400 || info.status === 422));

/**
 * Музика за планом — один трек одним запитом:
 * 1) `compose({prompt: promptFallback, musicLengthMs, forceInstrumental})` — основний шлях
 *    (єдиний промпт з тактовою структурою; генератор не будує аранжування наново на межах чанків);
 *    на відхилений промпт із пропозицією — один повтор із запропонованим промптом;
 * 2) лише якщо промпт відхилено — фолбек `composeDetailed` з композиційним планом (один чанк);
 *    якщо API відхилив і план, але запропонував заміну — один повтор із нею.
 * Формат — `MUSIC_OUTPUT_FORMAT`; якщо він недоступний на тарифі (`format_not_allowed`) — один повтор
 * того самого запиту в `FORMAT_FALLBACK` з попередженням у лог, далі всі запити — у ньому.
 * Решта помилок (ключ, квота, мережа) кидається одразу. 429 і тимчасові відмови повторює `ElevenLabsGate`.
 */
export async function generateMusic(
  deps: MusicDeps,
  plan: AudioPlan,
  opts: GenerateOptions = {},
): Promise<GeneratedMusic> {
  const logger = deps.logger ?? noopLogger;
  const trackMs = planTrackMs(plan);
  const suffix = (opts.attempt ?? 1) > 1 ? `:attempt${opts.attempt}` : "";
  const reqOpts: ElevenLabsRequestOptions = {
    timeoutInSeconds: MUSIC_TIMEOUT_SECONDS,
    maxRetries: 0,
    ...(deps.signal ? { abortSignal: deps.signal } : {}),
  };

  const record = async (seconds: number, detail: string) => {
    try {
      await deps.cost.record({
        provider: "elevenlabs",
        kind: "music",
        model: MUSIC_MODEL_ID,
        seconds,
        detail: `${detail}${suffix}`,
      });
    } catch (err) {
      logger.error("не вдалося записати витрати музики", { err: String(err) });
    }
  };

  // Формат недоступний на тарифі → один повтор того ж запиту у фолбек-форматі; далі всі запити — у ньому.
  let format: OutputFormat = MUSIC_OUTPUT_FORMAT;
  const withFormat = async (call: () => Promise<GeneratedMusic>): Promise<GeneratedMusic> => {
    try {
      return await call();
    } catch (err) {
      if (format === FORMAT_FALLBACK || deps.signal?.aborted) throw err;
      if (classifyElevenLabsError(err).kind !== "format_not_allowed") throw err;
      logger.warn("формат музики недоступний на тарифі — повтор у фолбек-форматі", {
        format,
        fallback: FORMAT_FALLBACK,
      });
      format = FORMAT_FALLBACK;
      return call();
    }
  };

  const composeOnce = async (prompt: string, detail: string): Promise<GeneratedMusic> => {
    const result = await deps.gate.run(
      "music:compose",
      () =>
        deps.client().music.compose(
          {
            prompt,
            musicLengthMs: trackMs,
            forceInstrumental: true,
            modelId: MUSIC_MODEL_ID,
            outputFormat: format,
          },
          reqOpts,
        ),
      deps.signal,
    );
    const audio = await receiveAudio(result, format, trackMs / 1000);
    await record(trackMs / 1000, detail);
    return { audio, outputFormat: format, method: "compose", promptUsed: prompt, durationMs: trackMs };
  };

  const compose = (prompt: string, detail: string) => withFormat(() => composeOnce(prompt, detail));

  const detailedOnce = async (
    compositionPlan: CompositionPlanV2,
    detail: string,
  ): Promise<GeneratedMusic> => {
    const result = await deps.gate.run(
      "music:composeDetailed",
      () =>
        deps
          .client()
          .music.composeDetailed({ compositionPlan, modelId: MUSIC_MODEL_ID, outputFormat: format }, reqOpts),
      deps.signal,
    );
    const ms = planMs(compositionPlan) || trackMs;
    const audio = await receiveAudio(result, format, ms / 1000);
    await record(ms / 1000, detail);
    return { audio, outputFormat: format, method: "composeDetailed", promptUsed: null, durationMs: ms };
  };

  const detailed = (compositionPlan: CompositionPlanV2, detail: string) =>
    withFormat(() => detailedOnce(compositionPlan, detail));

  /** Помилка, після якої фолбеку немає: скасування або не-відмова (ключ, квота, мережа). */
  const fatal = (err: unknown): ElevenLabsErrorInfo => {
    const info = classifyElevenLabsError(err);
    if (info.kind === "aborted" || deps.signal?.aborted || !isRejected(info)) throw err;
    return info;
  };

  const prompt = plan.promptFallback;
  try {
    return await compose(prompt, "music:compose");
  } catch (err) {
    const info = fatal(err);
    logger.warn("ElevenLabs відхилив промпт", { kind: info.kind, code: info.code, status: info.status });
    if (info.promptSuggestion && info.promptSuggestion !== prompt) {
      try {
        return await compose(info.promptSuggestion, "music:compose:suggested");
      } catch (err2) {
        const info2 = fatal(err2);
        logger.warn("запропонований промпт теж відхилено — фолбек composeDetailed", { code: info2.code });
      }
    }
  }

  try {
    return await detailed(toCompositionPlan(plan), "music:composeDetailed");
  } catch (err) {
    const info = classifyElevenLabsError(err);
    if (info.kind === "aborted" || deps.signal?.aborted) throw err;
    if (info.kind === "bad_prompt" && isV2Plan(info.planSuggestion)) {
      logger.warn("composeDetailed відхилив план, повтор із запропонованим", { code: info.code });
      return detailed(info.planSuggestion, "music:composeDetailed:suggested");
    }
    throw err;
  }
}

export interface EnsuredMusic {
  planHash: string;
  key: string;
  meta: MusicMeta;
  /** true — трек узято з кешу за хешем плану (без виклику API). */
  cached: boolean;
}

/**
 * Обрізаний на вікно відео трек: `audio/<planHash>/music.wav` (поруч із сирим `music.mp3`,
 * за яким стадія шукає трек для повторного використання).
 */
export function musicWavKey(projectId: string, planHash: string): string {
  return `${projectPaths(projectId).audioDir}/${planHash}/music.wav`;
}

/** Сирий трек у PCM-форматі (WAV): `audio/<planHash>/music-raw.wav` — розширення за вмістом. */
export function musicRawWavKey(projectId: string, planHash: string): string {
  return `${projectPaths(projectId).audioDir}/${planHash}/music-raw.wav`;
}

interface Attempt {
  music: GeneratedMusic;
  pcm: StereoPcm | null;
  check: MusicTrackCheck | null;
}

/**
 * Музика з кешу `audio/<planHash>/` або нова генерація:
 * 1) генерація → декодування → `checkTrack` у вікні відео (трек мінус 8 с запасу);
 * 2) `ok=false` → до 2 повторних генерацій (витрати кожної — окремий рядок `costs.jsonl`);
 * 3) найкраща спроба (пройшла / найменше провалів) → вікно відео без провалів у межах треку
 *    (зсув кратний такту, `offsetMs`) → `music.wav` (вікно + 1 с хвоста) і перевірка вже його;
 * 4) сирий трек найкращої спроби — у `music.mp3` (PCM-формат — `music-raw.wav`), метадані з `check`,
 *    `attempts`, `offsetMs` — у `music.json`.
 * Не вдалося декодувати (немає ffmpeg) або в плані немає темпу — лишається сирий трек,
 * `check: null`, `offsetMs: 0`.
 */
export async function ensureMusic(
  deps: MusicDeps,
  projectId: string,
  plan: AudioPlan,
  briefHash: string,
): Promise<EnsuredMusic> {
  const logger = deps.logger ?? noopLogger;
  const planHash = musicPlanHash(plan);
  const paths = projectPaths(projectId);
  const rawKey = paths.music(planHash);
  const rawWavKey = musicRawWavKey(projectId, planHash);
  const wavKey = musicWavKey(projectId, planHash);
  const metaKey = paths.musicMeta(planHash);
  if (await deps.storage.exists(metaKey)) {
    try {
      const meta = await deps.storage.readJson(metaKey, (v) => MusicMeta.parse(v));
      const key =
        meta.check !== null && (await deps.storage.exists(wavKey))
          ? wavKey
          : (await deps.storage.exists(rawKey))
            ? rawKey
            : (await deps.storage.exists(rawWavKey))
              ? rawWavKey
              : null;
      if (key) return { planHash, key, meta, cached: true };
    } catch {
      // битий music.json — генеруємо заново
    }
  }

  const videoMs = planVideoMs(plan);
  const bpm = planBpm(plan);
  const decode = deps.decode ?? decodeAudio;
  const decodeOpts = deps.signal ? { signal: deps.signal } : {};
  let best: Attempt | null = null;
  let attempts = 0;
  for (let n = 1; n <= 1 + MAX_MUSIC_RETRIES; n++) {
    let music: GeneratedMusic;
    try {
      music = await generateMusic(deps, plan, { attempt: n });
    } catch (err) {
      // Перша спроба — без треку нема що віддати; повторна — лишаємо найкращу з наявних.
      if (!best || deps.signal?.aborted) throw err;
      logger.warn("повторна генерація музики не вдалася — беремо найкращу спробу", { attempt: n });
      break;
    }
    attempts = n;
    if (bpm === null) {
      logger.warn("у плані немає темпу — трек без перевірки");
      best = { music, pcm: null, check: null };
      break;
    }
    let pcm: StereoPcm;
    try {
      pcm = await decode(music.audio, decodeOpts);
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      logger.warn("музику не вдалося розкодувати — без перевірки й обрізання", {
        attempt: n,
        err: String(err),
      });
      if (!best) best = { music, pcm: null, check: null };
      break;
    }
    const check = checkTrack(pcm, bpm, { videoMs });
    logger.info("перевірка треку", {
      attempt: n,
      outputFormat: music.outputFormat,
      ok: check.ok,
      kickOnsets: check.kickOnsets,
      beatConfidence: check.beatConfidence,
      gaps: check.gaps.length,
    });
    if (!best?.check || betterCheck(check, best.check)) best = { music, pcm, check };
    if (check.ok) break;
  }
  if (!best) throw new Error("музика: немає жодної спроби");

  const base = {
    planHash,
    modelId: MUSIC_MODEL_ID,
    method: best.music.method,
    promptUsed: best.music.promptUsed,
    briefHash,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    attempts: Math.max(1, attempts),
  };
  const bestRawKey = audioExt(best.music.audio) === "wav" ? rawWavKey : rawKey;
  await deps.storage.write(bestRawKey, best.music.audio);

  if (!best.pcm || !best.check || bpm === null) {
    const meta: MusicMeta = { ...base, durationMs: best.music.durationMs, check: null, offsetMs: 0 };
    await deps.storage.writeJson(metaKey, meta);
    return { planHash, key: bestRawKey, meta, cached: false };
  }

  const sr = best.pcm.sampleRate;
  const offsetMs = chooseWindowOffset(best.check.gaps, {
    trackMs: (pcmLength(best.pcm) / sr) * 1000,
    videoMs,
    tailMs: MUSIC_WINDOW_TAIL_MS,
    bpm,
    // Вікно — від сильної долі: вирівнювання такту у зведенні зрізає менше долі, а не до такту.
    barOffsetMs: best.check.barOffsetMs,
    barConfidence: best.check.barConfidence,
  });
  const cut = cutWindow(best.pcm, offsetMs, videoMs + MUSIC_WINDOW_TAIL_MS);
  const check = checkTrack(cut, bpm, { videoMs });
  if (offsetMs > 0) logger.info("вікно відео зсунуто з провалу", { offsetMs, ok: check.ok });
  const meta: MusicMeta = {
    ...base,
    durationMs: Math.round((pcmLength(cut) / sr) * 1000),
    check,
    offsetMs,
  };
  await deps.storage.write(wavKey, encodeWav(cut));
  await deps.storage.writeJson(metaKey, meta);
  return { planHash, key: wavKey, meta, cached: false };
}
