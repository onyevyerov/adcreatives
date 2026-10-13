import { z } from "zod";
import type { CueDefinition } from "./sfx.ts";

/**
 * Контроль якості семпла SFX після генерації (A2): гучність, атака, моно-сумісність, тон.
 * Хук викликає `ensureCached` (`sfx.ts`); не пройшов — повторна генерація.
 */

export const SfxQc = z.object({
  ok: z.boolean(),
  /** Пік семпла, dBFS; null — не міряно. */
  peakDb: z.number().nullable(),
  /** Onset від початку файлу, мс; null — не міряно. */
  onsetMs: z.number().nullable(),
  /** Кореляція L/R; null — не міряно. */
  correlation: z.number().nullable(),
  /** Впевнена висота тону; null — тону немає або не міряно. */
  pitchHz: z.number().nullable(),
  /** Порушення (порожньо, якщо `ok`). */
  reasons: z.array(z.string()),
  /** Скільки генерацій знадобилось (разом із першою). */
  attempts: z.number().int(),
});
export type SfxQc = z.infer<typeof SfxQc>;

export type SfxQcHook = (
  audio: Buffer,
  cue: string,
  def: CueDefinition,
  signal?: AbortSignal,
) => Promise<SfxQc>;

/** Хук за замовчуванням. Крок 0 — пропускає все без декодування (реалізація — A2). */
export const defaultSfxQc: SfxQcHook = async () => ({
  ok: true,
  peakDb: null,
  onsetMs: null,
  correlation: null,
  pitchHz: null,
  reasons: [],
  attempts: 1,
});
