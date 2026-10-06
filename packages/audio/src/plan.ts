import {
  AudioPlan,
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
import type { ChunkLayout } from "./chunks.ts";
import type { CompositionPlanV2 } from "./client.ts";
import {
  CUSTOM_SFX_MAX_SECONDS,
  CUSTOM_SFX_MIN_SECONDS,
  MAX_CUSTOM_SFX,
  MUSIC_MODEL_ID,
  MUSIC_OUTPUT_FORMAT,
  REQUIRED_NEGATIVE_STYLES,
  REQUIRED_POSITIVE_STYLES,
} from "./constants.ts";
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
        sceneIds: z.array(z.string()),
        durationMs: z.number(),
        positiveStyles: z.array(z.string()),
        negativeStyles: z.array(z.string()),
        contextAdherence: z.enum(["low", "medium", "high"]),
      }),
    ),
  }),
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
      language: brand.identity.language,
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
    standardCues: [...STANDARD_SFX_CUES],
    customCues: cues.custom,
  };
}

const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));

function ensureIncluded(list: string[], required: readonly string[]): string[] {
  const have = lower(list);
  return [...list, ...required.filter((r) => !have.has(r.toLowerCase()))];
}

function energyStyles(energy: number): string[] {
  if (energy < 0.35) return ["calm", "sparse arrangement", "soft dynamics"];
  if (energy < 0.7) return ["steady groove", "building energy"];
  return ["energetic", "full arrangement", "driving rhythm"];
}

export interface NormalizeOptions {
  layout: ChunkLayout;
  storyboard: Pick<Storyboard, "scenes" | "musicBrief">;
  sanitizer: Sanitizer;
  standardCues: StandardCueLibrary;
}

/**
 * Доводить чернетку LLM до валідного `AudioPlan` кодом:
 * межі й тривалості чанків — з таймлайну; стилі очищені від назв; "instrumental" і
 * ["vocals","lyrics"] гарантовані; contextAdherence "high"; SFX — стандартні з бібліотеки
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
  positiveGlobal = ensureIncluded(positiveGlobal, REQUIRED_POSITIVE_STYLES);
  // "instrumental" не може бути серед негативних.
  const negativeGlobal = ensureIncluded(
    sanitizer.styles(draft.compositionPlan.negativeGlobalStyles).filter((s) => !/instrumental/i.test(s)),
    REQUIRED_NEGATIVE_STYLES,
  );

  const chunks: MusicChunk[] = layout.chunks.map((sk, i) => {
    const key = sk.sceneIds.join(",");
    const match =
      draftChunks.find((d) => d.sceneIds.join(",") === key) ??
      (draftChunks.length === layout.chunks.length ? draftChunks[i] : undefined) ??
      draftChunks.find((d) => d.sceneIds.some((id) => sk.sceneIds.includes(id)));
    const positive = sanitizer.styles(match?.positiveStyles ?? []);
    return {
      label: sk.label,
      sceneIds: sk.sceneIds,
      durationMs: sk.durationMs,
      positiveStyles: positive.length > 0 ? positive : energyStyles(sk.energy),
      negativeStyles: sanitizer.styles(match?.negativeStyles ?? []).filter((s) => !/instrumental/i.test(s)),
      contextAdherence: "high",
    };
  });

  let promptFallback = sanitizer.text(draft.promptFallback);
  if (!promptFallback) {
    promptFallback = sanitizer.text(
      [brief.genre, ...brief.mood, `${brief.bpm} BPM`, ...brief.instrumentation].join(", "),
    );
  }
  if (!/instrumental/i.test(promptFallback))
    promptFallback = `${promptFallback}, instrumental`.replace(/^, /, "");

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
    compositionPlan: { positiveGlobalStyles: positiveGlobal, negativeGlobalStyles: negativeGlobal, chunks },
    promptFallback,
    sfx,
  });
}

/**
 * План для `music_v2_5`: глобальні стилі додаються в кожен чанк (у v2-плані глобальних
 * стилів немає, а "instrumental" має діяти на весь трек); текст чанка — лише назва секції.
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
      text: `[${c.label.replace(/[[\]{}]/g, "").slice(0, 100) || "section"}]`,
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
