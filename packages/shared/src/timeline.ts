import type { StillVariant } from "./schemas/qa.ts";
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

/** Cue, які наростають до межі сцени: закінчуються на її початку, а не стартують з нього. */
export const LEADING_SFX_CUES: readonly string[] = ["riser"];

export interface SfxPlacement {
  cue: string;
  sceneId: string;
  /** Глобальний кадр старту. */
  from: number;
  durationInFrames: number;
}

/**
 * Розміщення SFX за `scene.sfxCue` — єдине правило для хоста (B3) і аудіо (B5).
 * SFX стартує на початку послідовності сцени (тобто на початку переходу),
 * cue з `LEADING_SFX_CUES` — так, щоб закінчитись на цій межі. Cue без файлу в бібліотеці пропускаються.
 */
export function computeSfxPlacements(
  storyboard: Pick<Storyboard, "fps"> & {
    scenes: ReadonlyArray<{
      id: string;
      durationFrames: number;
      transitionFrames: number;
      sfxCue?: string | null;
    }>;
  },
  library: ReadonlyArray<{ cue: string; durationMs: number }>,
): SfxPlacement[] {
  const timeline = computeTimeline(storyboard);
  const lib = new Map(library.map((s) => [s.cue, s]));
  const out: SfxPlacement[] = [];
  timeline.scenes.forEach((ts, i) => {
    const cue = storyboard.scenes[i]?.sfxCue;
    const sfx = cue ? lib.get(cue) : undefined;
    if (!cue || !sfx) return;
    const len = Math.max(1, Math.ceil((sfx.durationMs / 1000) * timeline.fps));
    const from = LEADING_SFX_CUES.includes(cue) ? Math.max(0, ts.from - len) : ts.from;
    out.push({
      cue,
      sceneId: ts.id,
      from,
      durationInFrames: Math.max(1, Math.min(len, timeline.totalFrames - from)),
    });
  });
  return out;
}

/** Стіли сцени для check / QA: варіант і частка її тривалості. */
export const STILL_PLAN = [
  { variant: "e", fraction: 0.25 },
  { variant: "a", fraction: 0.5 },
  { variant: "b", fraction: 0.9 },
] as const satisfies ReadonlyArray<{ variant: StillVariant; fraction: number }>;

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
