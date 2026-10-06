import type { Storyboard } from "./schemas/storyboard.ts";

/**
 * Єдине джерело таймінгів для хост-композиції, аудіо-плану, SFX і вибору кадрів стілів.
 *
 * Модель як у `TransitionSeries`: `durationFrames` — довжина послідовності сцени;
 * перехід перекриває кінець попередньої і початок поточної сцени.
 * Загальна тривалість = сума сцен − сума переходів.
 */

export interface TimelineScene {
  id: string;
  index: number;
  /** Глобальний кадр початку послідовності сцени. */
  from: number;
  durationInFrames: number;
  /** Перехід на вході (0 для першої сцени і для склейки). */
  transitionInFrames: number;
  /** Перехід на виході (= transitionInFrames наступної сцени). */
  transitionOutFrames: number;
  /** Глобальний кадр після кінця послідовності (exclusive). */
  end: number;
}

export interface Timeline {
  fps: number;
  totalFrames: number;
  durationSeconds: number;
  scenes: TimelineScene[];
}

export type TimelineInput = Pick<Storyboard, "fps"> & {
  scenes: ReadonlyArray<{ id: string; durationFrames: number; transitionFrames: number }>;
};

export class TimelineError extends Error {
  override name = "TimelineError";
}

export function computeTimeline(storyboard: TimelineInput): Timeline {
  const { fps, scenes } = storyboard;
  if (scenes.length === 0) throw new TimelineError("розкадровка без сцен");

  const result: TimelineScene[] = [];
  let cursor = 0;
  scenes.forEach((scene, index) => {
    if (!Number.isInteger(scene.durationFrames) || scene.durationFrames <= 0) {
      throw new TimelineError(`сцена ${scene.id}: durationFrames має бути цілим > 0`);
    }
    const transitionIn = index === 0 ? 0 : scene.transitionFrames;
    if (!Number.isInteger(transitionIn) || transitionIn < 0) {
      throw new TimelineError(`сцена ${scene.id}: transitionFrames має бути цілим ≥ 0`);
    }
    const prev = result[index - 1];
    if (prev && transitionIn > 0 && transitionIn >= Math.min(prev.durationInFrames, scene.durationFrames)) {
      throw new TimelineError(
        `сцена ${scene.id}: перехід ${transitionIn} кадрів не коротший за сусідню сцену`,
      );
    }
    const from = cursor - transitionIn;
    if (prev) prev.transitionOutFrames = transitionIn;
    result.push({
      id: scene.id,
      index,
      from,
      durationInFrames: scene.durationFrames,
      transitionInFrames: transitionIn,
      transitionOutFrames: 0,
      end: from + scene.durationFrames,
    });
    cursor = from + scene.durationFrames;
  });

  return { fps, totalFrames: cursor, durationSeconds: cursor / fps, scenes: result };
}

/** Кадри для стілів сцени: частки її тривалості (за замовчуванням 50% і 90%), локальні для сцени. */
export function stillFrames(durationInFrames: number, fractions: readonly number[] = [0.5, 0.9]): number[] {
  return fractions.map((f) => Math.min(durationInFrames - 1, Math.max(0, Math.round(durationInFrames * f))));
}

/** Кадри → мілісекунди. */
export function framesToMs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1000);
}

/** Мілісекунди → кадри (вниз). */
export function msToFrames(ms: number, fps: number): number {
  return Math.floor((ms / 1000) * fps);
}
