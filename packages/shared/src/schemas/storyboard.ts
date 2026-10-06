import { z } from "zod";
import { type Format, SceneId } from "./common.ts";

export const ScenePurpose = z.enum([
  "hook",
  "problem",
  "offer",
  "benefit",
  "proof",
  "product",
  "brand",
  "cta",
]);
export type ScenePurpose = z.infer<typeof ScenePurpose>;

export const LayoutIntent = z.enum([
  "hero_image",
  "full_bleed",
  "split",
  "grid",
  "product_focus",
  "typographic",
  "logo_lockup",
]);
export type LayoutIntent = z.infer<typeof LayoutIntent>;

/** Тип переходу на вході в сцену (для першої сцени ігнорується). */
export const TransitionKind = z.enum(["cut", "fade", "slide", "wipe", "zoom"]);
export type TransitionKind = z.infer<typeof TransitionKind>;

export const SceneText = z.object({
  headline: z.string(),
  sub: z.string().nullable(),
  /** Слова/фрази з headline/sub для акценту. */
  emphasis: z.array(z.string()),
});
export type SceneText = z.infer<typeof SceneText>;

export const Scene = z.object({
  id: SceneId,
  purpose: ScenePurpose,
  /** Довжина послідовності сцени в кадрах (з урахуванням перекриття переходом). */
  durationFrames: z.number().int().min(1),
  /**
   * Довжина переходу з попередньої сцени в кадрах; 0 = склейка.
   * Для першої сцени завжди 0.
   */
  transitionFrames: z.number().int().min(0),
  text: SceneText,
  /** Факти з бренд-кіта, на які спирається текст сцени. */
  factIds: z.array(z.string()),
  assetIds: z.array(z.string()),
  layoutIntent: LayoutIntent,
  /** Опис руху людською мовою для codegen. */
  motionIntent: z.string(),
  transitionIn: TransitionKind,
  /** Стандартний cue (whoosh, pop, …) або ключ кастомного SFX з аудіо-плану; null — без SFX. */
  sfxCue: z.string().nullable(),
  /** Енергія музики в цій сцені 0..1. */
  musicEnergy: z.number().min(0).max(1),
});
export type Scene = z.infer<typeof Scene>;

export const MusicBrief = z.object({
  genre: z.string(),
  mood: z.array(z.string()),
  bpm: z.number().int().min(40).max(200),
  instrumentation: z.array(z.string()),
  /** Драматургія треку по частинах ролика. */
  structure: z.array(
    z.object({
      label: z.string(),
      sceneIds: z.array(z.string()),
      energy: z.number().min(0).max(1),
    }),
  ),
});
export type MusicBrief = z.infer<typeof MusicBrief>;

export const CopyRules = z.object({
  maxCharsPerLine: z.object({
    vertical: z.number().int().min(8),
    square: z.number().int().min(8),
    landscape: z.number().int().min(8),
  }),
  maxLines: z.object({
    headline: z.number().int().min(1),
    sub: z.number().int().min(1),
  }),
});
export type CopyRules = z.infer<typeof CopyRules>;

/** Storyboard — LLM-схема стадії `storyboard`; `normalizeStoryboard` доводить таймінги кодом. */
export const Storyboard = z.object({
  concept: z.string(),
  hook: z.string(),
  fps: z.literal(30),
  scenes: z.array(Scene).min(1),
  musicBrief: MusicBrief,
  copyRules: CopyRules,
});
export type Storyboard = z.infer<typeof Storyboard>;

/** Межі тривалості ролика в кадрах (30 fps): 15–30 с. */
export const MIN_TOTAL_FRAMES = 450;
export const MAX_TOTAL_FRAMES = 900;
export const MIN_SCENE_FRAMES = 45;

/** Для перевірки довжин текстів за форматом. */
export function maxCharsFor(rules: CopyRules, format: Format): number {
  return rules.maxCharsPerLine[format];
}
