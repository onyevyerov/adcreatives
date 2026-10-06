import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { clampChunkMs, computeChunkLayout } from "../src/chunks.ts";

const sb = (scenes: Array<[number, number, string?]>) => ({
  fps: 30 as const,
  scenes: scenes.map(([durationFrames, transitionFrames, purpose], i) => ({
    ...(fixtureStoryboard.scenes[0] as (typeof fixtureStoryboard.scenes)[number]),
    id: `s${i + 1}`,
    durationFrames,
    transitionFrames,
    purpose: (purpose ?? "benefit") as "benefit",
    musicEnergy: 0.5,
  })),
});

describe("computeChunkLayout", () => {
  it("chunk boundaries = scene starts from computeTimeline; last chunk carries the +1 s tail", () => {
    const layout = computeChunkLayout(fixtureStoryboard);
    expect(layout.videoMs).toBe(15_000);
    expect(layout.trackMs).toBe(16_000);
    expect(layout.chunks.map((c) => [c.sceneIds, c.startMs, c.durationMs])).toEqual([
      [["s1"], 0, 4_500],
      [["s2"], 4_500, 5_000],
      [["s3"], 9_500, 6_500],
    ]);
    expect(layout.chunks.map((c) => c.label)).toEqual(["hook", "offer", "cta"]);
    expect(layout.chunks.reduce((a, c) => a + c.durationMs, 0)).toBe(layout.trackMs);
  });

  it("merges scenes shorter than 3 s with the shorter neighbour", () => {
    // s2 = 2 с (60 кадрів): сусіди 5 с і 4 с → зливається з s3.
    const layout = computeChunkLayout(
      sb([
        [150, 0, "hook"],
        [60, 0, "problem"],
        [120, 0, "offer"],
        [120, 0, "cta"],
      ]),
    );
    expect(layout.chunks.map((c) => c.sceneIds)).toEqual([["s1"], ["s2", "s3"], ["s4"]]);
    expect(layout.chunks.map((c) => c.durationMs)).toEqual([5_000, 6_000, 5_000]);
    expect(layout.chunks[1]?.label).toBe("problem+offer");
  });

  it("merges a short first scene forward and a short last scene back; every chunk ≥ 3 s", () => {
    const layout = computeChunkLayout(
      sb([
        [60, 0],
        [200, 0],
        [200, 0],
        [45, 0],
      ]),
    );
    expect(layout.chunks.map((c) => c.sceneIds)).toEqual([
      ["s1", "s2"],
      ["s3", "s4"],
    ]);
    for (const c of layout.chunks) expect(c.durationMs).toBeGreaterThanOrEqual(3_000);
    // Однакові назви чанків розрізняються номером.
    expect(layout.chunks.map((c) => c.label)).toEqual(["benefit 1", "benefit 2"]);
  });

  it("accounts for transitions: boundary is the start of the incoming scene's sequence", () => {
    const layout = computeChunkLayout(
      sb([
        [150, 0],
        [150, 30],
        [150, 30],
      ]),
    );
    // Сцена 2 стартує на кадрі 120 (4 с), сцена 3 — на 240 (8 с); відео 390 кадрів = 13 с.
    expect(layout.chunks.map((c) => c.startMs)).toEqual([0, 4_000, 8_000]);
    expect(layout.videoMs).toBe(13_000);
    expect(layout.chunks.at(-1)?.durationMs).toBe(6_000);
  });

  it("several consecutive short scenes collapse until all chunks are long enough", () => {
    const layout = computeChunkLayout(
      sb([
        [45, 0],
        [45, 0],
        [45, 0],
        [45, 0],
        [300, 0],
      ]),
    );
    for (const c of layout.chunks) expect(c.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(layout.chunks.flatMap((c) => c.sceneIds)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(layout.chunks.reduce((a, c) => a + c.durationMs, 0)).toBe(layout.trackMs);
  });

  it("clampChunkMs keeps durations within 3 000–120 000 ms", () => {
    expect(clampChunkMs(1_200)).toBe(3_000);
    expect(clampChunkMs(500_000)).toBe(120_000);
    expect(clampChunkMs(4_500.4)).toBe(4_500);
  });
});
