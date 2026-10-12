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
  /** Вільна композиція, яку автор фільму описує в `motionIntent`. */
  "custom",
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

/** Роль тексту в кадрі (крім headline/sub). */
export const OnScreenRole = z.enum([
  "heading",
  "label",
  "item",
  "number",
  "badge",
  "caption",
  "quote",
  "button",
  /** Дрібний надзаголовок над headline або блоком: "КРОК 2", "ЩО ВИ ОТРИМУЄТЕ". */
  "eyebrow",
  /** Стан/серйозність у рядку UI-мока: "Критично", "Готово", "3 години". */
  "status",
]);
export type OnScreenRole = z.infer<typeof OnScreenRole>;

/** Текст у кадрі сцени понад headline/sub: пункт списку, число, мітка, цитата. */
export const OnScreenText = z.object({
  /** Унікальний у межах сцени: t1, t2, … */
  id: z.string().regex(/^t\d{1,2}$/),
  role: OnScreenRole,
  text: z.string().min(1),
  /** Група для структури: колонка, рядок, список ("col:1 тиждень", "row:вартість"). */
  group: z.string().nullable().default(null),
  factIds: z.array(z.string()).default([]),
});
export type OnScreenText = z.infer<typeof OnScreenText>;

export const SoundCue = z.enum([
  "whoosh",
  "swoosh",
  "riser",
  "impact",
  "slam",
  "pop",
  "ding",
  "tick",
  "click",
  "shimmer",
]);
export type SoundCue = z.infer<typeof SoundCue>;

export const SoundAccent = z.enum(["soft", "normal", "hard"]);
export type SoundAccent = z.infer<typeof SoundAccent>;

/** Момент у сцені, який видно в кадрі і (за потреби) чути: удар, поява, зміна. */
export const SceneEvent = z.object({
  /** Унікальний у межах сцени: kebab-case. */
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /** Локальний кадр сцени, коли подію видно (момент удару, появи, зміни). */
  at: z.number().int().min(0),
  /** Що відбувається в кадрі, 1 речення англійською — для codegen і QA. */
  what: z.string(),
  sound: z
    .object({ cue: SoundCue, accent: SoundAccent.default("normal") })
    .nullable()
    .default(null),
  /** Тексти з items, які з'являються або змінюються в цей момент. */
  textIds: z.array(z.string()).default([]),
});
export type SceneEvent = z.infer<typeof SceneEvent>;

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
  /** Інші тексти в кадрі (пункти, числа, мітки); дозволені тексти сцени — `allowedScreenTexts`. */
  items: z.array(OnScreenText).default([]),
  /** Моменти сцени з кадрами і звуком; єдине джерело кадрів для коду сцени і аудіо. */
  events: z.array(SceneEvent).default([]),
  /** Факти з бренд-кіта, на які спирається текст сцени. */
  factIds: z.array(z.string()),
  assetIds: z.array(z.string()),
  layoutIntent: LayoutIntent,
  /** Опис руху людською мовою для codegen. */
  motionIntent: z.string(),
  transitionIn: TransitionKind,
  /**
   * @deprecated Замінено `events[].sound`: `normalize` перетворює на подію "arrive" з at = 0.
   * Стандартний cue (whoosh, pop, …) або ключ кастомного SFX з аудіо-плану; null — без SFX.
   */
  sfxCue: z.string().nullable(),
  /** Енергія музики в цій сцені 0..1. */
  musicEnergy: z.number().min(0).max(1),
});
export type Scene = z.infer<typeof Scene>;

/** Як зведення обробляє музику частини: filtered — приглушена, full — як є, breakdown — майже порожня. */
export const MusicMix = z.enum(["filtered", "full", "breakdown"]);
export type MusicMix = z.infer<typeof MusicMix>;

/** Темпи, за яких доля — ціле число кадрів при 30 fps (1800 / bpm). */
export const BPM_GRID = [60, 72, 75, 90, 100, 120, 150] as const;

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
      mix: MusicMix.default("full"),
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
