import {
  type CostRecorder,
  type Logger,
  noopLogger,
  type PromptLoader,
  projectPaths,
  STANDARD_SFX_CUES,
  type StandardSfxCue,
  type Storage,
  sharedPaths,
  shortHash,
  stableStringify,
} from "@adc/shared";
import { z } from "zod";
import { audioBytes, type ElevenLabsLike } from "./client.ts";
import { SFX_MODEL_ID, SFX_PROMPT_INFLUENCE, SFX_TIMEOUT_SECONDS } from "./constants.ts";
import type { ElevenLabsGate } from "./gate.ts";

/** Назва файлу з текстами стандартних cue: `prompts/elevenlabs/sfx-cues.md`. */
export const SFX_CUES_PROMPT = "elevenlabs/sfx-cues";

export interface CueDefinition {
  text: string;
  durationSeconds: number;
}
export type StandardCueLibrary = Record<StandardSfxCue, CueDefinition>;

/** Рядок списку: `- whoosh (0.6 s): текст промпта`. */
const CUE_LINE = /^\s*[-*]\s*`?([a-z][a-z0-9-]*)`?\s*\(\s*([\d.]+)\s*s\s*\)\s*:\s*(.+?)\s*$/;

/** Розбирає тіло `sfx-cues.md`; кидає помилку, якщо якогось із 8 стандартних cue немає. */
export function parseSfxCues(body: string): StandardCueLibrary {
  const found = new Map<string, CueDefinition>();
  for (const line of body.split(/\r?\n/)) {
    const m = CUE_LINE.exec(line);
    if (!m) continue;
    const [, cue, secs, text] = m;
    const durationSeconds = Number(secs);
    if (!cue || !text || !Number.isFinite(durationSeconds)) continue;
    found.set(cue, { text, durationSeconds: Math.min(30, Math.max(0.5, durationSeconds)) });
  }
  const missing = STANDARD_SFX_CUES.filter((c) => !found.has(c));
  if (missing.length > 0) throw new Error(`sfx-cues.md: немає cue ${missing.join(", ")}`);
  return Object.fromEntries(STANDARD_SFX_CUES.map((c) => [c, found.get(c)])) as StandardCueLibrary;
}

export function loadStandardCues(prompts: PromptLoader): StandardCueLibrary {
  const p = prompts.load(SFX_CUES_PROMPT);
  return parseSfxCues([p.system, p.user ?? ""].join("\n"));
}

/** Хеш SFX-запиту = ім'я файлу в кеші. Однаковий запит — той самий файл. */
export function sfxHash(def: CueDefinition): string {
  return shortHash(
    stableStringify({
      text: def.text,
      durationSeconds: def.durationSeconds,
      promptInfluence: SFX_PROMPT_INFLUENCE,
      modelId: SFX_MODEL_ID,
    }),
  );
}

export const SfxCacheMeta = z.object({
  cue: z.string(),
  text: z.string(),
  durationSeconds: z.number(),
  modelId: z.string(),
  createdAt: z.string(),
});
export type SfxCacheMeta = z.infer<typeof SfxCacheMeta>;

export interface SfxDeps {
  storage: Storage;
  client: () => ElevenLabsLike;
  gate: ElevenLabsGate;
  logger?: Logger;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface SfxFile {
  cue: string;
  /** Ключ файлу в сховищі. */
  key: string;
  hash: string;
  durationMs: number;
  /** true — щойно згенеровано (був платний виклик). */
  generated: boolean;
}

/** Один платний виклик textToSoundEffects + запис витрат. */
export async function generateSfx(
  deps: SfxDeps,
  cost: CostRecorder,
  cue: string,
  def: CueDefinition,
): Promise<Buffer> {
  const result = await deps.gate.run(
    `sfx:${cue}`,
    () =>
      deps.client().textToSoundEffects.convert(
        {
          text: def.text,
          durationSeconds: def.durationSeconds,
          promptInfluence: SFX_PROMPT_INFLUENCE,
          modelId: SFX_MODEL_ID,
        },
        {
          timeoutInSeconds: SFX_TIMEOUT_SECONDS,
          maxRetries: 0,
          ...(deps.signal ? { abortSignal: deps.signal } : {}),
        },
      ),
    deps.signal,
  );
  const audio = await audioBytes(result);
  try {
    await cost.record({
      provider: "elevenlabs",
      kind: "sfx",
      model: SFX_MODEL_ID,
      seconds: def.durationSeconds,
      detail: `sfx:${cue}`,
    });
  } catch (err) {
    (deps.logger ?? noopLogger).error("не вдалося записати витрати SFX", { cue, err: String(err) });
  }
  return audio;
}

/** Журнал витрат або лінива фабрика (спільний журнал створюється лише при промаху кешу). */
export type CostSource = CostRecorder | (() => CostRecorder);
const resolveCost = (c: CostSource): CostRecorder => (typeof c === "function" ? c() : c);

async function ensureCached(
  deps: SfxDeps,
  cost: CostSource,
  cue: string,
  def: CueDefinition,
  key: string,
  metaKey: string,
): Promise<SfxFile> {
  const hash = sfxHash(def);
  const durationMs = Math.round(def.durationSeconds * 1000);
  if (await deps.storage.exists(key)) return { cue, key, hash, durationMs, generated: false };
  const audio = await generateSfx(deps, resolveCost(cost), cue, def);
  await deps.storage.write(key, audio);
  const meta: SfxCacheMeta = {
    cue,
    text: def.text,
    durationSeconds: def.durationSeconds,
    modelId: SFX_MODEL_ID,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  await deps.storage.writeJson(metaKey, meta);
  return { cue, key, hash, durationMs, generated: true };
}

/**
 * Стандартний cue зі спільного кешу `cache/sfx/<hash>.mp3`. Якщо кеш не прогріто
 * (`pnpm sfx-cache` не запускали) — генерує і пише витрати у спільний журнал.
 */
export function ensureStandardSfx(
  deps: SfxDeps,
  sharedCost: CostSource,
  cue: string,
  def: CueDefinition,
): Promise<SfxFile> {
  const hash = sfxHash(def);
  return ensureCached(deps, sharedCost, cue, def, sharedPaths.sfxCache(hash), sharedPaths.sfxCacheMeta(hash));
}

/** Кастомний cue: кеш проєкту `audio/sfx/<hash>.mp3`, витрати — у журнал проєкту. */
export function ensureCustomSfx(
  deps: SfxDeps,
  cost: CostSource,
  projectId: string,
  cue: string,
  def: CueDefinition,
): Promise<SfxFile> {
  const hash = sfxHash(def);
  const paths = projectPaths(projectId);
  return ensureCached(deps, cost, cue, def, paths.sfx(`${hash}.mp3`), paths.sfx(`${hash}.json`));
}
