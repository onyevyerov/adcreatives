import { describe, expect, it } from "vitest";
import { fixtureStoryboard } from "../src/fixtures.ts";
import { computeTimeline, framesToMs, stillFrames, TimelineError } from "../src/timeline.ts";

const sb = (scenes: Array<[number, number]>) => ({
  fps: 30 as const,
  scenes: scenes.map(([durationFrames, transitionFrames], i) => ({
    id: `s${i + 1}`,
    durationFrames,
    transitionFrames,
  })),
});

describe("computeTimeline", () => {
  it("without transitions: scenes are back to back", () => {
    const t = computeTimeline(
      sb([
        [90, 0],
        [120, 0],
        [60, 0],
      ]),
    );
    expect(t.totalFrames).toBe(270);
    expect(t.durationSeconds).toBe(9);
    expect(t.scenes.map((s) => [s.from, s.end])).toEqual([
      [0, 90],
      [90, 210],
      [210, 270],
    ]);
  });

  it("with transitions: total = sum of scenes - sum of transitions", () => {
    const t = computeTimeline(fixtureStoryboard);
    expect(t.totalFrames).toBe(150 + 165 + 165 - 15 - 15);
    expect(t.scenes[1]).toMatchObject({ from: 135, durationInFrames: 165, transitionInFrames: 15, end: 300 });
    expect(t.scenes[0]?.transitionOutFrames).toBe(15);
    expect(t.scenes[2]?.transitionOutFrames).toBe(0);
  });

  it("ignores transition on the first scene", () => {
    const t = computeTimeline(
      sb([
        [90, 20],
        [90, 0],
      ]),
    );
    expect(t.scenes[0]?.from).toBe(0);
    expect(t.totalFrames).toBe(180);
  });

  it("rejects transitions not shorter than neighbour scenes", () => {
    expect(() =>
      computeTimeline(
        sb([
          [30, 0],
          [90, 30],
        ]),
      ),
    ).toThrow(TimelineError);
    expect(() => computeTimeline(sb([]))).toThrow(TimelineError);
    expect(() => computeTimeline(sb([[0, 0]]))).toThrow(TimelineError);
  });

  it("still frames are local and clamped", () => {
    expect(stillFrames(100)).toEqual([50, 90]);
    expect(stillFrames(10, [0, 1])).toEqual([0, 9]);
    expect(framesToMs(45, 30)).toBe(1500);
  });
});
