import type { Format } from "./schemas/common.ts";
import type { Scene } from "./schemas/storyboard.ts";

export const MOMENT_RADIUS = 2;

/** Локальні кадри навколо події: at−2 … at+2, обрізано до [0, duration−1], без дублів. */
export function momentFrames(at: number, durationFrames: number, radius = MOMENT_RADIUS): number[] {
  const last = Math.max(0, durationFrames - 1);
  const out = new Set<number>();
  for (let f = at - radius; f <= at + radius; f++) out.add(Math.min(last, Math.max(0, f)));
  return [...out].sort((a, b) => a - b);
}

/** Склейка: останні 2 кадри сцени і перші 3 наступної (локальні кадри кожної). */
export function joinFrames(duration: number, nextDuration: number | null): { out: number[]; in: number[] } {
  const last = Math.max(0, duration - 1);
  const out = [...new Set([Math.max(0, last - 1), last])];
  const nextLast = nextDuration === null ? -1 : Math.max(0, nextDuration - 1);
  const inn = nextDuration === null ? [] : [...new Set([0, 1, 2].map((f) => Math.min(f, nextLast)))];
  return { out, in: inn };
}

/**
 * Легенда аркуша моментів для промптів sfx і review: рядок = подія або склейка,
 * клітинка = `кадр · с`. Детермінована.
 */
export function momentLegend(
  scene: Pick<Scene, "id" | "durationFrames" | "events">,
  format: Format,
  fps: number,
  hasJoin: boolean,
): string {
  const cell = (f: number): string => `${f} · ${(f / fps).toFixed(2)}s`;
  const lines = [
    `Moment sheet · scene ${scene.id} · ${format} · one row per event, cell = "frame · seconds":`,
  ];
  for (const ev of scene.events) {
    lines.push(
      `- ${ev.id} (at ${ev.at}): ${momentFrames(ev.at, scene.durationFrames).map(cell).join(" | ")}`,
    );
  }
  if (hasJoin) {
    const out = joinFrames(scene.durationFrames, null).out;
    lines.push(`- join: ${out.map(cell).join(" | ")} → next scene frames 0 | 1 | 2`);
  }
  return lines.join("\n");
}
