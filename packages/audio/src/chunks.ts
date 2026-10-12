import { computeTimeline, framesToMs, type Storyboard } from "@adc/shared";
import { MAX_CHUNK_MS, MIN_CHUNK_MS, TRACK_TAIL_MS } from "./constants.ts";

/**
 * Каркас композиції, порахований кодом (без LLM): один чанк на весь трек.
 * Генератор однаково ігнорує зміну аранжування між чанками, а на межах чанків будує
 * аранжування наново (провали, брейки) — тому трек просимо одним шматком, а арку робить зведення.
 * Трек довший за відео на `TRACK_TAIL_MS` (8 с): запас, щоб зсунути вікно відео з провалу.
 */
export interface ChunkSkeleton {
  label: string;
  sceneIds: string[];
  /** Початок чанка в треку, мс. */
  startMs: number;
  durationMs: number;
  /** Середня енергія сцен (зважена за тривалістю), 0..1. */
  energy: number;
}

export interface ChunkLayout {
  /** Тривалість відео, мс. */
  videoMs: number;
  /** Тривалість треку = відео + 8000 мс (у межах 3–120 с). */
  trackMs: number;
  /** Рівно один чанк на весь трек. */
  chunks: ChunkSkeleton[];
}

/** Назва чанка — purpose сцен без повторів («hook+offer+cta»). */
function labelOf(purposes: string[]): string {
  const uniq = [...new Set(purposes)];
  return uniq.join("+").slice(0, 100) || "section";
}

/** Обмежує тривалість чанка межами API. */
export function clampChunkMs(ms: number): number {
  return Math.min(MAX_CHUNK_MS, Math.max(MIN_CHUNK_MS, Math.round(ms)));
}

export function computeChunkLayout(storyboard: Pick<Storyboard, "fps" | "scenes">): ChunkLayout {
  const timeline = computeTimeline(storyboard);
  const fps = timeline.fps;
  const videoMs = framesToMs(timeline.totalFrames, fps);
  const trackMs = clampChunkMs(videoMs + TRACK_TAIL_MS);

  // Енергія — середня за сценами, зважена тривалістю сцени на таймлайні.
  let energyMs = 0;
  let totalMs = 0;
  timeline.scenes.forEach((ts, i) => {
    const ms = framesToMs(ts.durationInFrames, fps);
    energyMs += (storyboard.scenes[i]?.musicEnergy ?? 0.5) * ms;
    totalMs += ms;
  });
  const energy = totalMs > 0 ? Math.round((energyMs / totalMs) * 100) / 100 : 0.5;

  const chunk: ChunkSkeleton = {
    label: labelOf(storyboard.scenes.map((s) => s.purpose ?? "section")),
    sceneIds: timeline.scenes.map((ts) => ts.id),
    startMs: 0,
    durationMs: trackMs,
    energy,
  };
  return { videoMs, trackMs, chunks: [chunk] };
}
