import type { StereoPcm } from "./pcm.ts";

/**
 * Фаза такту (A6): яка з долей сітки — перша сильна (downbeat). Вирівнювання ставить на кадр 0
 * downbeat, а не будь-яку долю, і вікно відео в треку рахується від нього.
 */

export interface BarPhase {
  /** Час першого downbeat від початку PCM, с. */
  barOffsetSec: number;
  confidence: number;
}

/** Фаза такту від сітки долей (`beatOffsetSec`); null — не визначено. Крок 0 — завжди null (A6). */
export function estimateBarPhase(_pcm: StereoPcm, _bpm: number, _beatOffsetSec: number): BarPhase | null {
  return null;
}
