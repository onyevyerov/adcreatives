import {
  type AudioPlan,
  type CostRecorder,
  type Logger,
  MusicMeta,
  noopLogger,
  projectPaths,
  type Storage,
} from "@adc/shared";
import {
  audioBytes,
  type CompositionPlanV2,
  type ElevenLabsLike,
  type ElevenLabsRequestOptions,
} from "./client.ts";
import { MUSIC_MODEL_ID, MUSIC_OUTPUT_FORMAT, MUSIC_TIMEOUT_SECONDS } from "./constants.ts";
import { classifyElevenLabsError } from "./errors.ts";
import type { ElevenLabsGate } from "./gate.ts";
import { musicPlanHash, planTrackMs, toCompositionPlan } from "./plan.ts";

export interface MusicDeps {
  storage: Storage;
  client: () => ElevenLabsLike;
  gate: ElevenLabsGate;
  cost: CostRecorder;
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface GeneratedMusic {
  audio: Buffer;
  method: MusicMeta["method"];
  /** Промпт, що реально спрацював (compose), або null для composeDetailed. */
  promptUsed: string | null;
  durationMs: number;
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

/**
 * Музика за планом:
 * 1) `composeDetailed` з композиційним планом; якщо API відхилив план і запропонував заміну —
 *    один повтор із нею (запропонований промпт → одразу `compose` з ним);
 * 2) інакше фолбек `compose({prompt, musicLengthMs, forceInstrumental})`; на відхилений промпт
 *    із пропозицією — один повтор із запропонованим промптом.
 * 429 і тимчасові відмови повторює `ElevenLabsGate`.
 */
export async function generateMusic(deps: MusicDeps, plan: AudioPlan): Promise<GeneratedMusic> {
  const logger = deps.logger ?? noopLogger;
  const trackMs = planTrackMs(plan);
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
        detail,
      });
    } catch (err) {
      logger.error("не вдалося записати витрати музики", { err: String(err) });
    }
  };

  const detailed = async (compositionPlan: CompositionPlanV2, detail: string): Promise<GeneratedMusic> => {
    const result = await deps.gate.run(
      "music:composeDetailed",
      () =>
        deps
          .client()
          .music.composeDetailed(
            { compositionPlan, modelId: MUSIC_MODEL_ID, outputFormat: MUSIC_OUTPUT_FORMAT },
            reqOpts,
          ),
      deps.signal,
    );
    const audio = await audioBytes(result);
    const ms = planMs(compositionPlan) || trackMs;
    await record(ms / 1000, detail);
    return { audio, method: "composeDetailed", promptUsed: null, durationMs: ms };
  };

  const compose = async (prompt: string, detail: string): Promise<GeneratedMusic> => {
    const result = await deps.gate.run(
      "music:compose",
      () =>
        deps.client().music.compose(
          {
            prompt,
            musicLengthMs: trackMs,
            forceInstrumental: true,
            modelId: MUSIC_MODEL_ID,
            outputFormat: MUSIC_OUTPUT_FORMAT,
          },
          reqOpts,
        ),
      deps.signal,
    );
    const audio = await audioBytes(result);
    await record(trackMs / 1000, detail);
    return { audio, method: "compose", promptUsed: prompt, durationMs: trackMs };
  };

  const composeWithSuggestion = async (prompt: string, detail: string): Promise<GeneratedMusic> => {
    try {
      return await compose(prompt, detail);
    } catch (err) {
      const info = classifyElevenLabsError(err);
      if (info.kind === "bad_prompt" && info.promptSuggestion && info.promptSuggestion !== prompt) {
        logger.warn("ElevenLabs відхилив промпт, повтор із запропонованим", { code: info.code });
        return compose(info.promptSuggestion, "music:compose:suggested");
      }
      throw err;
    }
  };

  let fallbackPrompt = plan.promptFallback;
  try {
    return await detailed(toCompositionPlan(plan), "music:composeDetailed");
  } catch (err) {
    const info = classifyElevenLabsError(err);
    if (info.kind === "aborted" || deps.signal?.aborted) throw err;
    logger.warn("composeDetailed не вдався", { kind: info.kind, code: info.code, status: info.status });
    if (info.kind === "bad_prompt" && isV2Plan(info.planSuggestion)) {
      try {
        return await detailed(info.planSuggestion, "music:composeDetailed:suggested");
      } catch (err2) {
        const info2 = classifyElevenLabsError(err2);
        if (info2.kind === "aborted" || deps.signal?.aborted) throw err2;
        logger.warn("composeDetailed із запропонованим планом не вдався", { kind: info2.kind });
      }
    } else if (info.kind === "bad_prompt" && info.promptSuggestion) {
      // Запропонована заміна — промпт, а не план: це і є наш один повтор, уже через compose.
      fallbackPrompt = info.promptSuggestion;
      return compose(fallbackPrompt, "music:compose:suggested");
    }
  }
  return composeWithSuggestion(fallbackPrompt, "music:compose");
}

export interface EnsuredMusic {
  planHash: string;
  key: string;
  meta: MusicMeta;
  /** true — трек узято з кешу за хешем плану (без виклику API). */
  cached: boolean;
}

/** Музика з кешу `audio/<planHash>/` або нова генерація з записом `music.mp3` + `music.json`. */
export async function ensureMusic(
  deps: MusicDeps,
  projectId: string,
  plan: AudioPlan,
  briefHash: string,
): Promise<EnsuredMusic> {
  const planHash = musicPlanHash(plan);
  const paths = projectPaths(projectId);
  const key = paths.music(planHash);
  const metaKey = paths.musicMeta(planHash);
  if ((await deps.storage.exists(key)) && (await deps.storage.exists(metaKey))) {
    try {
      const meta = await deps.storage.readJson(metaKey, (v) => MusicMeta.parse(v));
      return { planHash, key, meta, cached: true };
    } catch {
      // битий music.json — генеруємо заново
    }
  }
  const music = await generateMusic(deps, plan);
  const meta: MusicMeta = {
    planHash,
    durationMs: music.durationMs,
    modelId: MUSIC_MODEL_ID,
    method: music.method,
    promptUsed: music.promptUsed,
    briefHash,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    check: null,
    attempts: 1,
  };
  await deps.storage.write(key, music.audio);
  await deps.storage.writeJson(metaKey, meta);
  return { planHash, key, meta, cached: false };
}
