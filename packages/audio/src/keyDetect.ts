import type { MusicTrackCheck } from "@adc/shared";
import type { StereoPcm } from "./pcm.ts";

/**
 * Тональність треку за звуком (A5): зведення строїть тональні події в тональність, яку
 * реально чути, а не лише ту, що в плані (генератор може її не дотримати).
 */

export interface KeyEstimate {
  /** Висотний клас тоніки: C = 0 … B = 11. */
  root: number;
  minor: boolean;
  /** Відрив найкращого збігу від другого, нормований (0..1). */
  confidence: number;
}

/** Тональність треку; null — не визначено. Крок 0 — завжди null (реалізація — A5). */
export function detectKey(_pcm: StereoPcm): KeyEstimate | null {
  return null;
}

/**
 * Тональність для звуків подій: ключ плану або визначений за треком. Крок 0 — завжди ключ
 * плану (реалізація — A5).
 */
export function resolveEventKey(_check: MusicTrackCheck | null, planKey: string | null): string | null {
  return planKey;
}
