import { computeTimeline, framesToMs, type Storyboard } from "@adc/shared";
import { MAX_CHUNK_MS, MIN_CHUNK_MS, TRACK_TAIL_MS } from "./constants.ts";

/**
 * Каркас чанків композиції, порахований кодом (без LLM).
 * Межа сцени = кадр початку її послідовності за `computeTimeline` (там же, де стоїть її SFX).
 * Сцени коротші за 3 с зливаються з сусідньою; останній чанк включає хвіст треку (+1 с).
 */
export interface ChunkSkeleton {
  label: string;
  sceneIds: string[];
  /** Початок чанка в треку, мс. */
  startMs: number;
  durationMs: number;
  /** Середня енергія сцен чанка (зважена за тривалістю), 0..1. */
  energy: number;
}

export interface ChunkLayout {
  /** Тривалість відео, мс. */
  videoMs: number;
  /** Тривалість треку = відео + 1000 мс. */
  trackMs: number;
  chunks: ChunkSkeleton[];
}

interface Segment {
  sceneIds: string[];
  purposes: string[];
  startMs: number;
  endMs: number;
  /** Сума energy × мс — для зваженого середнього. */
  energyMs: number;
}

const len = (s: Segment) => s.endMs - s.startMs;

function mergeInto(a: Segment, b: Segment): Segment {
  return {
    sceneIds: [...a.sceneIds, ...b.sceneIds],
    purposes: [...a.purposes, ...b.purposes],
    startMs: Math.min(a.startMs, b.startMs),
    endMs: Math.max(a.endMs, b.endMs),
    energyMs: a.energyMs + b.energyMs,
  };
}

function labelOf(purposes: string[]): string {
  const uniq = [...new Set(purposes)];
  return uniq.join("+").slice(0, 100) || "section";
}

export function computeChunkLayout(storyboard: Pick<Storyboard, "fps" | "scenes">): ChunkLayout {
  const timeline = computeTimeline(storyboard);
  const fps = timeline.fps;
  const videoMs = framesToMs(timeline.totalFrames, fps);
  const trackMs = videoMs + TRACK_TAIL_MS;

  let segments: Segment[] = timeline.scenes.map((ts, i) => {
    const scene = storyboard.scenes[i];
    const next = timeline.scenes[i + 1];
    const startMs = i === 0 ? 0 : framesToMs(ts.from, fps);
    // Останній сегмент тягнеться до кінця треку (включно з хвостом).
    const endMs = next ? framesToMs(next.from, fps) : trackMs;
    const energy = scene?.musicEnergy ?? 0.5;
    return {
      sceneIds: [ts.id],
      purposes: [scene?.purpose ?? "section"],
      startMs,
      endMs,
      energyMs: energy * (endMs - startMs),
    };
  });

  // Зливаємо короткі сегменти (< 3 с) з коротшим сусідом, доки всі не стануть ≥ 3 с.
  while (segments.length > 1) {
    const idx = segments.findIndex((s) => len(s) < MIN_CHUNK_MS);
    if (idx === -1) break;
    const prev = segments[idx - 1];
    const next = segments[idx + 1];
    const withNext = !prev || (next !== undefined && len(next) <= len(prev));
    const merged: Segment[] = [];
    segments.forEach((s, i) => {
      if (withNext && i === idx) merged.push(mergeInto(s, next as Segment));
      else if (withNext && i === idx + 1) return;
      else if (!withNext && i === idx - 1) merged.push(mergeInto(s, segments[idx] as Segment));
      else if (!withNext && i === idx) return;
      else merged.push(s);
    });
    segments = merged;
  }

  // Довгі сегменти (> 120 с) ділимо навпіл — для роликів 15–30 с не трапляється, але межа API жорстка.
  const split: Segment[] = [];
  for (const s of segments) {
    const parts = Math.ceil(len(s) / MAX_CHUNK_MS);
    if (parts <= 1) {
      split.push(s);
      continue;
    }
    const step = Math.ceil(len(s) / parts);
    for (let p = 0; p < parts; p++) {
      const startMs = s.startMs + p * step;
      const endMs = Math.min(s.endMs, startMs + step);
      split.push({ ...s, startMs, endMs, energyMs: (s.energyMs / len(s)) * (endMs - startMs) });
    }
  }

  // Однакові назви (дві сцени benefit) розрізняємо номером чанка.
  const bases = split.map((s) => labelOf(s.purposes));
  const chunks = split.map((s, i) => ({
    label: bases.filter((b) => b === bases[i]).length > 1 ? `${bases[i]} ${i + 1}` : (bases[i] as string),
    sceneIds: s.sceneIds,
    startMs: s.startMs,
    durationMs: len(s),
    energy: Math.round((s.energyMs / Math.max(1, len(s))) * 100) / 100,
  }));
  return { videoMs, trackMs, chunks };
}

/** Обмежує тривалість чанка межами API. */
export function clampChunkMs(ms: number): number {
  return Math.min(MAX_CHUNK_MS, Math.max(MIN_CHUNK_MS, Math.round(ms)));
}
