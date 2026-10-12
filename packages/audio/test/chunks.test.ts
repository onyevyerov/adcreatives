import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { clampChunkMs, computeChunkLayout } from "../src/chunks.ts";

const sb = (scenes: Array<[number, number, string?, number?]>) => ({
  fps: 30 as const,
  scenes: scenes.map(([durationFrames, transitionFrames, purpose, musicEnergy], i) => ({
    ...(fixtureStoryboard.scenes[0] as (typeof fixtureStoryboard.scenes)[number]),
    id: `s${i + 1}`,
    durationFrames,
    transitionFrames,
    purpose: (purpose ?? "benefit") as "benefit",
    musicEnergy: musicEnergy ?? 0.5,
  })),
});

describe("computeChunkLayout", () => {
  it("один чанк на весь трек; трек = відео + 8 с запасу", () => {
    const layout = computeChunkLayout(fixtureStoryboard);
    expect(layout.videoMs).toBe(15_000);
    expect(layout.trackMs).toBe(23_000);
    expect(layout.chunks).toHaveLength(1);
    expect(layout.chunks[0]).toMatchObject({
      label: "hook+offer+cta",
      sceneIds: ["s1", "s2", "s3"],
      startMs: 0,
      durationMs: 23_000,
    });
  });

  it("короткі сцени більше не ділять трек: усі сцени — в одному чанку, без повторів назв", () => {
    const layout = computeChunkLayout(
      sb([
        [45, 0, "hook"],
        [45, 0, "benefit"],
        [45, 0, "benefit"],
        [300, 0, "cta"],
      ]),
    );
    expect(layout.chunks).toHaveLength(1);
    expect(layout.chunks[0]?.sceneIds).toEqual(["s1", "s2", "s3", "s4"]);
    expect(layout.chunks[0]?.label).toBe("hook+benefit+cta");
  });

  it("переходи враховано: відео за таймлайном, трек = відео + 8 с", () => {
    const layout = computeChunkLayout(
      sb([
        [150, 0],
        [150, 30],
        [150, 30],
      ]),
    );
    // 450 кадрів − 2 переходи по 30 = 390 кадрів = 13 с.
    expect(layout.videoMs).toBe(13_000);
    expect(layout.trackMs).toBe(21_000);
    expect(layout.chunks[0]?.durationMs).toBe(21_000);
  });

  it("енергія — середня за сценами, зважена тривалістю", () => {
    const layout = computeChunkLayout(
      sb([
        [90, 0, "hook", 0.2],
        [270, 0, "cta", 1],
      ]),
    );
    // (0.2 × 3 с + 1 × 9 с) / 12 с = 0.8
    expect(layout.chunks[0]?.energy).toBe(0.8);
  });

  it("межі API: трек у 3 000–120 000 мс", () => {
    const long = computeChunkLayout(sb([[3_500, 0]]));
    expect(long.videoMs).toBe(116_667);
    expect(long.trackMs).toBe(120_000);
    expect(long.chunks[0]?.durationMs).toBe(120_000);
    expect(clampChunkMs(1_200)).toBe(3_000);
    expect(clampChunkMs(500_000)).toBe(120_000);
    expect(clampChunkMs(4_500.4)).toBe(4_500);
  });
});
