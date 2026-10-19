import {
  AudioPlan,
  type AudioProvider,
  type BrandKit,
  computeTimeline,
  framesToMs,
  inputsHash,
  type MusicBrief,
  type MusicChunk,
  type SfxSpec,
  STANDARD_SFX_CUES,
  type Storyboard,
  shortHash,
  stableStringify,
} from "@adc/shared";
import { z } from "zod";
import { type ChunkLayout, clampChunkMs } from "./chunks.ts";
import type { CompositionPlanV2 } from "./client.ts";
import {
  CUSTOM_SFX_MAX_SECONDS,
  CUSTOM_SFX_MIN_SECONDS,
  LEGACY_TRACK_TAIL_MS,
  MAX_CUSTOM_SFX,
  MUSIC_MODEL_ID,
  MUSIC_OUTPUT_FORMAT,
  REQUIRED_NEGATIVE_STYLES,
  REQUIRED_POSITIVE_STYLES,
  TRACK_TAIL_MS,
} from "./constants.ts";
import { parseKey } from "./key.ts";
import type { Sanitizer } from "./sanitize.ts";
import type { StandardCueLibrary } from "./sfx.ts";

/** Назва промпта стадії. */
export const AUDIO_PLAN_PROMPT = "audio-plan";

/**
 * Чернетка плану від LLM: та сама форма, що `AudioPlan`, але без числових меж —
 * тривалості й набір сцен чанків однаково перекриваються кодом за таймлайном,
 * тож відповідь не має падати на валідації через них.
 */
export const AudioPlanDraft = z.object({
  compositionPlan: z.object({
    positiveGlobalStyles: z.array(z.string()),
    negativeGlobalStyles: z.array(z.string()),
    chunks: z.array(
      z.object({
        label: z.string(),
        section: z.string(),
        sceneIds: z.array(z.string()),
        durationMs: z.number(),
        positiveStyles: z.array(z.string()),
        negativeStyles: z.array(z.string()),
        contextAdherence: z.enum(["low", "medium", "high"]),
      }),
    ),
  }),
  /** Одна тональність треку («A minor»): у неї ж зведення строїть тональні cue (`PITCHED_SOUND_CUES`). */
  key: z.string().nullable().default(null),
  promptFallback: z.string(),
  sfx: z.array(
    z.object({
      cue: z.string(),
      text: z.string(),
      durationSeconds: z.number(),
      custom: z.boolean(),
    }),
  ),
});
export type AudioPlanDraft = z.infer<typeof AudioPlanDraft>;

const STANDARD = new Set<string>(STANDARD_SFX_CUES);
export const isStandardCue = (cue: string) => STANDARD.has(cue);

/** SFX-cue, на які посилається розкадровка (у порядку сцен, без повторів). */
export function referencedCues(storyboard: Pick<Storyboard, "scenes">): {
  standard: string[];
  custom: string[];
} {
  const standard: string[] = [];
  const custom: string[] = [];
  for (const s of storyboard.scenes) {
    const cue = s.sfxCue?.trim();
    if (!cue) continue;
    const list = isStandardCue(cue) ? standard : custom;
    if (!list.includes(cue)) list.push(cue);
  }
  return { standard, custom: custom.slice(0, MAX_CUSTOM_SFX) };
}

/** Хеш музичного брифу: незмінний бриф + не довше відео = трек можна лишити. */
export function musicBriefHash(brief: MusicBrief): string {
  return shortHash(stableStringify(brief));
}

/** Змінні промпта `audio-plan`. Назва бренду свідомо не передається. */
export function audioPlanVars(
  brand: BrandKit,
  storyboard: Storyboard,
  layout: ChunkLayout,
  sanitizer: Sanitizer,
): Record<string, unknown> {
  const timeline = computeTimeline(storyboard);
  const cues = referencedCues(storyboard);
  return {
    brand: {
      category: brand.identity.category,
      audience: sanitizer.text(brand.audience),
      tone: sanitizer.styles(brand.voice.tone),
      mood: sanitizer.styles(brand.visualStyle.mood),
      motionPersonality: brand.visualStyle.motionPersonality,
      musicHints: sanitizer.styles(brand.visualStyle.musicHints),
    },
    musicBrief: {
      ...storyboard.musicBrief,
      genre: sanitizer.text(storyboard.musicBrief.genre),
      mood: sanitizer.styles(storyboard.musicBrief.mood),
      instrumentation: sanitizer.styles(storyboard.musicBrief.instrumentation),
    },
    scenes: storyboard.scenes.map((s, i) => {
      const ts = timeline.scenes[i];
      return {
        id: s.id,
        purpose: s.purpose,
        startMs: ts ? framesToMs(ts.from, timeline.fps) : 0,
        durationMs: ts ? framesToMs(ts.durationInFrames, timeline.fps) : 0,
        musicEnergy: s.musicEnergy,
        transitionIn: s.transitionIn,
        sfxCue: s.sfxCue,
        motionIntent: sanitizer.text(s.motionIntent),
      };
    }),
    chunks: layout.chunks.map((c) => ({
      label: c.label,
      sceneIds: c.sceneIds,
      durationMs: c.durationMs,
      energy: c.energy,
    })),
    videoMs: layout.videoMs,
    trackMs: layout.trackMs,
    steadySeconds: steadySeconds(layout.videoMs),
    standardCues: [...STANDARD_SFX_CUES],
    customCues: cues.custom,
  };
}

const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));

function ensureIncluded(list: string[], required: readonly string[]): string[] {
  const have = lower(list);
  return [...list, ...required.filter((r) => !have.has(r.toLowerCase()))];
}

/**
 * Стилі чанка, коли модель їх не дала: генератор план аранжування однаково ігнорує,
 * а арку (вступ / брейкдаун) робить зведення, тож трек має бути рівним.
 */
function steadyStyles(): string[] {
  return ["steady groove", "full arrangement", "kick on every beat"];
}

const BPM_STYLE = /\b\d{2,3}\s*bpm\b/i;
const BPM_ANY = /\b\d{2,3}\s*bpm\b/gi;

/** Секція єдиного чанка, коли модель її не дала. */
const MAIN_SECTION = "main groove";

/** Скільки перших секунд трек мусить іти рівно: вся тривалість відео, з округленням угору. */
export const steadySeconds = (videoMs: number) => Math.max(1, Math.ceil(videoMs / 1000));

const NO_STOP = /no stop in the first \d+ seconds/i;

/**
 * Промпт `compose` (основний запит): темп рівно `bpm`, тональність, тактова структура
 * (4/4, фрази по 4 такти) і явні заборони брейку, філу й зупинки в перших N секундах.
 * Додає лише те, чого бракує; число N завжди з таймлайну.
 */
export function withTrackStructure(
  prompt: string,
  opts: { bpm: number; key: string | null; videoMs: number },
) {
  const n = steadySeconds(opts.videoMs);
  const tempo = `${opts.bpm} BPM`;
  let out = prompt.replace(BPM_ANY, tempo).replace(NO_STOP, `no stop in the first ${n} seconds`).trim();
  out = out.replace(/[\s.,;]+$/, "");
  const add: string[] = [];
  if (!out.toLowerCase().includes(tempo.toLowerCase())) add.push(tempo);
  if (opts.key && !out.toLowerCase().includes(opts.key.toLowerCase())) add.push(`in ${opts.key}`);
  if (!/\b4\/4\b/.test(out)) add.push("4/4 time");
  if (!/phrases of 4 bars|4-bar phrases/i.test(out)) add.push("phrases of 4 bars");
  if (!/kick on every beat/i.test(out)) add.push("kick on every beat");
  if (!/no breakdown/i.test(out)) add.push("no breakdown");
  if (!/no fill/i.test(out)) add.push("no fill");
  if (!NO_STOP.test(out)) add.push(`no stop in the first ${n} seconds`);
  if (add.length > 0) out = out ? `${out}. ${add.join(", ")}` : add.join(", ");
  if (!/instrumental/i.test(out)) out = `${out}, instrumental`;
  return out;
}

/** Темп у глобальних стилях — рівно `musicBrief.bpm` (інший темп зламав би сітку долей). */
function withBriefTempo(styles: string[], bpm: number): string[] {
  const tempo = `${bpm} BPM`;
  const rest = styles.filter((s) => !BPM_STYLE.test(s) || s.toLowerCase() === tempo.toLowerCase());
  return rest.some((s) => s.toLowerCase() === tempo.toLowerCase()) ? rest : [...rest, tempo];
}

export interface NormalizeOptions {
  layout: ChunkLayout;
  storyboard: Pick<Storyboard, "scenes" | "musicBrief">;
  sanitizer: Sanitizer;
  standardCues: StandardCueLibrary;
}

/**
 * Доводить чернетку LLM до валідного `AudioPlan` кодом:
 * рівно один чанк на весь трек (відео + 8 с) — навіть якщо чернетка чи каркас мають кілька;
 * промпт `compose` — з тактовою структурою і заборонами брейку; стилі очищені від назв; "instrumental" і
 * ["vocals","lyrics"] гарантовані; темп — рівно `musicBrief.bpm`; розпізнана тональність — у `key`
 * і в глобальних стилях; contextAdherence "high"; SFX — стандартні з бібліотеки
 * і до 3 кастомних з тривалістю 0.5–1.5 с.
 */
export function normalizeAudioPlan(draft: AudioPlanDraft, opts: NormalizeOptions): AudioPlan {
  const { layout, storyboard, sanitizer, standardCues } = opts;
  const brief = storyboard.musicBrief;
  const draftChunks = draft.compositionPlan.chunks;

  let positiveGlobal = sanitizer.styles(draft.compositionPlan.positiveGlobalStyles);
  if (positiveGlobal.length === 0) {
    positiveGlobal = sanitizer.styles([brief.genre, ...brief.instrumentation, `${brief.bpm} BPM`]);
  }
  // Одна тональність: розпізнана — у плані (для висоти подій) і в стилях генератора.
  const trackKey = draft.key && parseKey(draft.key) ? sanitizer.text(draft.key.trim()) || null : null;
  positiveGlobal = withBriefTempo(positiveGlobal, brief.bpm);
  if (trackKey) positiveGlobal = ensureIncluded(positiveGlobal, [trackKey]);
  positiveGlobal = ensureIncluded(positiveGlobal, REQUIRED_POSITIVE_STYLES);
  // "instrumental" не може бути серед негативних.
  const negativeGlobal = ensureIncluded(
    sanitizer.styles(draft.compositionPlan.negativeGlobalStyles).filter((s) => !/instrumental/i.test(s)),
    REQUIRED_NEGATIVE_STYLES,
  );

  // Один чанк: стилі — з першого чанка чернетки, де вони є (модель копіює їх між чанками).
  const match = draftChunks.find((d) => sanitizer.styles(d.positiveStyles).length > 0) ?? draftChunks[0];
  const positive = sanitizer.styles(match?.positiveStyles ?? []);
  const section = sanitizer.text(match?.section ?? "") || MAIN_SECTION;
  const labels = [...new Set(layout.chunks.map((c) => c.label))];
  const chunk: MusicChunk = {
    label: labels.join("+").slice(0, 100) || "section",
    section,
    sceneIds: layout.chunks.flatMap((c) => c.sceneIds),
    durationMs: clampChunkMs(layout.trackMs),
    positiveStyles: positive.length > 0 ? positive : steadyStyles(),
    negativeStyles: sanitizer.styles(match?.negativeStyles ?? []).filter((s) => !/instrumental/i.test(s)),
    contextAdherence: "high",
  };

  let promptFallback = sanitizer.text(draft.promptFallback);
  if (!promptFallback) {
    promptFallback = sanitizer.text(
      [brief.genre, ...brief.mood, `${brief.bpm} BPM`, ...brief.instrumentation].join(", "),
    );
  }
  promptFallback = withTrackStructure(promptFallback, {
    bpm: brief.bpm,
    key: trackKey,
    videoMs: layout.videoMs,
  });

  const cues = referencedCues({ scenes: storyboard.scenes as Storyboard["scenes"] });
  const sfx: SfxSpec[] = [];
  for (const cue of cues.standard) {
    const def = standardCues[cue as keyof StandardCueLibrary];
    if (def) sfx.push({ cue, text: def.text, durationSeconds: def.durationSeconds, custom: false });
  }
  for (const cue of cues.custom) {
    const d = draft.sfx.find((s) => s.cue === cue);
    const text = d ? sanitizer.text(d.text) : "";
    if (!text) continue;
    const seconds = Number.isFinite(d?.durationSeconds) ? (d?.durationSeconds as number) : 1;
    sfx.push({
      cue,
      text,
      durationSeconds: Math.min(CUSTOM_SFX_MAX_SECONDS, Math.max(CUSTOM_SFX_MIN_SECONDS, seconds)),
      custom: true,
    });
  }

  return AudioPlan.parse({
    compositionPlan: {
      positiveGlobalStyles: positiveGlobal,
      negativeGlobalStyles: negativeGlobal,
      chunks: [chunk],
    },
    key: trackKey,
    promptFallback,
    sfx,
  });
}

/**
 * План для `music_v2_5`: глобальні стилі додаються в кожен чанк (у v2-плані глобальних
 * стилів немає, а "instrumental" має діяти на весь трек); текст чанка — лише назва секції
 * (`section` від моделі: intro/build/peak…, інакше `label` з purpose сцен).
 */
export function toCompositionPlan(plan: AudioPlan): CompositionPlanV2 {
  const { positiveGlobalStyles, negativeGlobalStyles, chunks } = plan.compositionPlan;
  const merge = (a: readonly string[], b: readonly string[]) => {
    const seen = new Set<string>();
    return [...a, ...b].filter((s) => {
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return {
    chunks: chunks.map((c) => ({
      text: `[${(c.section || c.label).replace(/[[\]{}]/g, "").slice(0, 100) || "section"}]`,
      durationMs: c.durationMs,
      positiveStyles: merge(positiveGlobalStyles, c.positiveStyles),
      negativeStyles: merge(negativeGlobalStyles, c.negativeStyles),
      contextAdherence: c.contextAdherence,
    })),
  };
}

/** Тривалість треку за планом, мс. */
export function planTrackMs(plan: AudioPlan): number {
  return plan.compositionPlan.chunks.reduce((a, c) => a + c.durationMs, 0);
}

/**
 * Тривалість відео за планом, мс: трек мінус запас (8 с; у старих багаточанкових планах — 1 с).
 */
export function planVideoMs(plan: AudioPlan): number {
  const tail = plan.compositionPlan.chunks.length > 1 ? LEGACY_TRACK_TAIL_MS : TRACK_TAIL_MS;
  return Math.max(0, planTrackMs(plan) - tail);
}

/** Темп плану зі стилю «<bpm> BPM» (`withBriefTempo` кладе його завжди); null — не знайдено. */
export function planBpm(plan: AudioPlan): number | null {
  for (const s of plan.compositionPlan.positiveGlobalStyles) {
    const m = /\b(\d{2,3})\s*bpm\b/i.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Хеш плану музики = ключ кешу `audio/<planHash>/`. */
export function musicPlanHash(plan: AudioPlan): string {
  return inputsHash({
    modelId: MUSIC_MODEL_ID,
    outputFormat: MUSIC_OUTPUT_FORMAT,
    compositionPlan: toCompositionPlan(plan),
    promptFallback: plan.promptFallback,
    trackMs: planTrackMs(plan),
  });
}

/**
 * Хеш плану музики з урахуванням провайдера: для `elevenlabs` — побайтно `musicPlanHash` (кеш не
 * скидається); для `epidemic` — окремий простір ключів (без моделі й формату ElevenLabs), щоб трек
 * одного провайдера не підхопився замість іншого.
 */
export function musicPlanHashFor(provider: AudioProvider, plan: AudioPlan): string {
  if (provider === "elevenlabs") return musicPlanHash(plan);
  return inputsHash({
    provider,
    compositionPlan: toCompositionPlan(plan),
    promptFallback: plan.promptFallback,
    trackMs: planTrackMs(plan),
  });
}

/** Чи придатний уже збережений план для поточної розкадровки (повтор стадії, правка без зміни таймінгів). */
export function planMatchesLayout(
  plan: AudioPlan,
  layout: ChunkLayout,
  storyboard: Pick<Storyboard, "scenes">,
): boolean {
  const a = plan.compositionPlan.chunks;
  if (a.length !== layout.chunks.length) return false;
  const sameChunks = a.every((c, i) => {
    const sk = layout.chunks[i];
    return (
      sk !== undefined && c.durationMs === sk.durationMs && c.sceneIds.join(",") === sk.sceneIds.join(",")
    );
  });
  return sameChunks && planCoversCues(plan, storyboard);
}

/** Чи покриває план усі SFX-cue розкадровки (для повторного використання плану при правці). */
export function planCoversCues(plan: AudioPlan, storyboard: Pick<Storyboard, "scenes">): boolean {
  const cues = referencedCues(storyboard);
  return [...cues.standard, ...cues.custom].every((cue) => plan.sfx.some((s) => s.cue === cue));
}
