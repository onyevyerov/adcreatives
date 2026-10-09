import type { StillVariant } from "./schemas/qa.ts";
import {
  BPM_GRID,
  type Scene,
  type SceneEvent,
  type SoundAccent,
  SoundCue,
  type Storyboard,
} from "./schemas/storyboard.ts";

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

/** Кадрів у долі при заданому темпі: `(60 · fps) / bpm`. Для темпів з `BPM_GRID` при 30 fps — ціле число. */
export function beatFrames(bpm: number, fps = 30): number {
  return (60 * fps) / bpm;
}

/** Найближчий темп з `BPM_GRID` (за рівної відстані — нижчий). */
export function snapBpm(bpm: number): (typeof BPM_GRID)[number] {
  let best: (typeof BPM_GRID)[number] = BPM_GRID[0];
  for (const candidate of BPM_GRID) {
    if (Math.abs(candidate - bpm) < Math.abs(best - bpm)) best = candidate;
  }
  return best;
}

export interface EventPlacement {
  sceneId: string;
  eventId: string;
  /** Глобальний кадр моменту події = `timeline.scenes[i].from + event.at`. */
  frame: number;
  cue: SoundCue | null;
  accent: SoundAccent;
}

/** Id події, у яку `computeEventPlacements` перетворює застарілий `scene.sfxCue`. */
export const LEGACY_ARRIVE_EVENT_ID = "arrive";

const SOUND_CUES: readonly string[] = SoundCue.options;

/**
 * Усі події фільму в глобальних кадрах, відсортовані за кадром (за рівних — у порядку сцен і оголошення).
 * Застарілий `sfxCue` стає подією "arrive" на `from` сцени, якщо сцена не має власної події "arrive";
 * cue, якого немає серед `SoundCue` (кастомний ключ), дає подію без звуку.
 *
 * Семантика `frame` для звуку: момент, коли подію видно. Аудіодвигун сам підводить звук:
 * `riser` закінчується на `frame`, `whoosh`/`swoosh` мають пік на `frame`, решта починаються з `frame`.
 */
export function computeEventPlacements(
  sb: Pick<Storyboard, "fps"> & {
    scenes: ReadonlyArray<
      Pick<Scene, "id" | "durationFrames" | "transitionFrames"> & {
        sfxCue?: string | null;
        events?: ReadonlyArray<Pick<SceneEvent, "id" | "at" | "sound">>;
      }
    >;
  },
): EventPlacement[] {
  const timeline = computeTimeline(sb);
  const out: EventPlacement[] = [];
  timeline.scenes.forEach((ts, i) => {
    const scene = sb.scenes[i];
    if (!scene) return;
    const events = scene.events ?? [];
    if (scene.sfxCue && !events.some((e) => e.id === LEGACY_ARRIVE_EVENT_ID)) {
      out.push({
        sceneId: ts.id,
        eventId: LEGACY_ARRIVE_EVENT_ID,
        frame: ts.from,
        cue: SOUND_CUES.includes(scene.sfxCue) ? (scene.sfxCue as SoundCue) : null,
        accent: "normal",
      });
    }
    for (const e of events) {
      out.push({
        sceneId: ts.id,
        eventId: e.id,
        frame: ts.from + e.at,
        cue: e.sound?.cue ?? null,
        accent: e.sound?.accent ?? "normal",
      });
    }
  });
  return out.sort((a, b) => a.frame - b.frame);
}

/** Локальний кадр події сцени. Кидає `Error`, якщо такого id немає (рендер впаде → check/fix). */
export function eventFrame(scene: Pick<Scene, "id" | "events">, id: string): number {
  const event = scene.events.find((e) => e.id === id);
  if (!event) {
    throw new Error(
      `сцена ${scene.id}: події «${id}» немає (є: ${scene.events.map((e) => e.id).join(", ") || "жодної"})`,
    );
  }
  return event.at;
}

/**
 * Кадри стрічки сцени для QA (локальні): `step`, `2·step`, … (< `duration − 1`) і останній кадр.
 * Кадр 0 не береться (крім сцени з одного кадру — тоді єдиний кадр 0).
 */
export function stripFrames(durationInFrames: number, step = 15): number[] {
  const last = Math.max(0, durationInFrames - 1);
  const out: number[] = [];
  for (let f = step; f < last; f += step) out.push(f);
  out.push(last);
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
