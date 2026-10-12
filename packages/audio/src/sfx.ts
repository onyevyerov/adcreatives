import {
  type CostRecorder,
  type Logger,
  noopLogger,
  type PromptLoader,
  projectPaths,
  SoundCue,
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

/** Назва файлу з текстами бібліотеки SFX: `prompts/elevenlabs/sfx-cues.md`. */
export const SFX_CUES_PROMPT = "elevenlabs/sfx-cues";

export interface CueDefinition {
  text: string;
  durationSeconds: number;
}
/** Legacy-шлях `scene.sfxCue`: 8 стандартних cue, варіант 1 кожного. */
export type StandardCueLibrary = Record<StandardSfxCue, CueDefinition>;
/** Бібліотека звуків подій: кожен `SoundCue` → варіанти в порядку номерів (індекс 0 — варіант 1). */
export type SfxLibrary = Record<SoundCue, CueDefinition[]>;

/**
 * Рядок списку: `- pop.2 (0.5 s): текст промпта`; без номера (`- pop (0.5 s): …`) — варіант 1
 * (старий формат).
 */
const CUE_LINE = /^\s*[-*]\s*`?([a-z][a-z0-9-]*)(?:\.(\d+))?`?\s*\(\s*([\d.]+)\s*s\s*\)\s*:\s*(.+?)\s*$/;

/** Усі рядки cue з тіла `sfx-cues.md`: cue → (номер варіанта → опис). Дубль варіанта — помилка. */
function parseCueLines(body: string): Map<string, Map<number, CueDefinition>> {
  const found = new Map<string, Map<number, CueDefinition>>();
  for (const line of body.split(/\r?\n/)) {
    const m = CUE_LINE.exec(line);
    if (!m) continue;
    const [, cue, num, secs, text] = m;
    const durationSeconds = Number(secs);
    const variant = num === undefined ? 1 : Number(num);
    if (!cue || !text || !Number.isFinite(durationSeconds) || !(variant >= 1)) continue;
    const variants = found.get(cue) ?? new Map<number, CueDefinition>();
    if (variants.has(variant)) throw new Error(`sfx-cues.md: варіант ${cue}.${variant} задано двічі`);
    variants.set(variant, { text, durationSeconds: Math.min(30, Math.max(0.5, durationSeconds)) });
    found.set(cue, variants);
  }
  return found;
}

const sortedVariants = (variants: Map<number, CueDefinition>): CueDefinition[] =>
  [...variants.entries()].sort((a, b) => a[0] - b[0]).map(([, def]) => def);

/** Бібліотека звуків подій; кидає помилку, якщо якогось `SoundCue` або його варіанта 1 немає. */
export function parseSfxLibrary(body: string): SfxLibrary {
  const found = parseCueLines(body);
  const missing = SoundCue.options.filter((c) => !found.get(c)?.has(1));
  if (missing.length > 0) throw new Error(`sfx-cues.md: немає cue ${missing.join(", ")}`);
  return Object.fromEntries(
    SoundCue.options.map((c) => [c, sortedVariants(found.get(c) as Map<number, CueDefinition>)]),
  ) as SfxLibrary;
}

/** Legacy: варіант 1 кожного з 8 стандартних cue; кидає помилку, якщо якогось немає. */
export function parseSfxCues(body: string): StandardCueLibrary {
  const found = parseCueLines(body);
  const missing = STANDARD_SFX_CUES.filter((c) => !found.get(c)?.has(1));
  if (missing.length > 0) throw new Error(`sfx-cues.md: немає cue ${missing.join(", ")}`);
  return Object.fromEntries(STANDARD_SFX_CUES.map((c) => [c, found.get(c)?.get(1)])) as StandardCueLibrary;
}

const cuesBody = (prompts: PromptLoader) => {
  const p = prompts.load(SFX_CUES_PROMPT);
  return [p.system, p.user ?? ""].join("\n");
};

export function loadStandardCues(prompts: PromptLoader): StandardCueLibrary {
  return parseSfxCues(cuesBody(prompts));
}

export function loadSfxLibrary(prompts: PromptLoader): SfxLibrary {
  return parseSfxLibrary(cuesBody(prompts));
}

/** Мітка варіанта в журналі витрат і метаданих кешу: `pop.2`. */
export const variantLabel = (cue: string, variant: number) => `${cue}.${variant}`;

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
