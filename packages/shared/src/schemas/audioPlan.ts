import { z } from "zod";

/**
 * Чанк композиції музики. Межі чанків = межі сцен за `computeTimeline`;
 * сцени коротші за 3 с зливаються з сусідніми. B5 мапить це на формат ElevenLabs.
 */
export const MusicChunk = z.object({
  label: z.string(),
  sceneIds: z.array(z.string()).min(1),
  /** 3 000–120 000 мс (обмеження ElevenLabs), перевіряється кодом. */
  durationMs: z.number().int().min(3000).max(120000),
  positiveStyles: z.array(z.string()),
  negativeStyles: z.array(z.string()),
  contextAdherence: z.enum(["low", "medium", "high"]),
});
export type MusicChunk = z.infer<typeof MusicChunk>;

export const SfxSpec = z.object({
  /** Стандартний cue (whoosh, …) або ключ кастомного (custom-1, …). */
  cue: z.string(),
  /** Промпт для textToSoundEffects. */
  text: z.string(),
  /** 0.5–1.5 с для кастомних. */
  durationSeconds: z.number().min(0.5).max(30),
  custom: z.boolean(),
});
export type SfxSpec = z.infer<typeof SfxSpec>;

/** AudioPlan — LLM-схема стадії `audio-plan` (Sonnet). */
export const AudioPlan = z.object({
  compositionPlan: z.object({
    /** Стилі з музичного брифу + "instrumental". Без назв брендів і артистів. */
    positiveGlobalStyles: z.array(z.string()),
    /** Щонайменше ["vocals", "lyrics"]. */
    negativeGlobalStyles: z.array(z.string()),
    chunks: z.array(MusicChunk).min(1),
  }),
  /** Запасний промпт для music.compose. */
  promptFallback: z.string(),
  /** Стандартні cue + до 3 кастомних. */
  sfx: z.array(SfxSpec),
});
export type AudioPlan = z.infer<typeof AudioPlan>;

/** Метадані згенерованої музики: `audio/<planHash>/music.json`. */
export const MusicMeta = z.object({
  planHash: z.string(),
  durationMs: z.number().int(),
  modelId: z.string(),
  method: z.enum(["composeDetailed", "compose"]),
  /** Промпт, який реально пішов (із заміною, якщо API запропонував). */
  promptUsed: z.string().nullable(),
  briefHash: z.string(),
  createdAt: z.string(),
});
export type MusicMeta = z.infer<typeof MusicMeta>;
