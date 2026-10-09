import { describe, expect, it } from "vitest";
import { fixtureStoryboard } from "../src/fixtures.ts";
import { BPM_GRID, type SceneEvent } from "../src/schemas/storyboard.ts";
import {
  beatFrames,
  computeEventPlacements,
  computeSfxPlacements,
  computeTimeline,
  eventFrame,
  framesToMs,
  STILL_PLAN,
  snapBpm,
  stillFrames,
  stripFrames,
  TimelineError,
} from "../src/timeline.ts";

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

  it("STILL_PLAN: e/a/b на 25/50/90% сцени", () => {
    expect(STILL_PLAN.map((p) => p.variant)).toEqual(["e", "a", "b"]);
    expect(
      stillFrames(
        90,
        STILL_PLAN.map((p) => p.fraction),
      ),
    ).toEqual([23, 45, 81]);
  });
});

describe("computeSfxPlacements", () => {
  it("SFX at sequence starts, riser ends at the boundary, missing cues skipped", () => {
    const storyboard = {
      fps: 30 as const,
      scenes: [
        { id: "s1", durationFrames: 90, transitionFrames: 0, sfxCue: "whoosh" },
        { id: "s2", durationFrames: 120, transitionFrames: 15, sfxCue: "riser" },
        { id: "s3", durationFrames: 90, transitionFrames: 0, sfxCue: "pop" },
        { id: "s4", durationFrames: 60, transitionFrames: 0, sfxCue: null },
      ],
    };
    const library = [
      { cue: "whoosh", durationMs: 600 },
      { cue: "riser", durationMs: 1500 },
    ];
    expect(computeSfxPlacements(storyboard, library)).toEqual([
      { cue: "whoosh", sceneId: "s1", from: 0, durationInFrames: 18 },
      // s2 стартує з 75 (90 − 15), riser 45 кадрів закінчується на 75.
      { cue: "riser", sceneId: "s2", from: 30, durationInFrames: 45 },
    ]);
  });

  it("clamps to the video end and never starts before frame 0", () => {
    const storyboard = {
      fps: 30 as const,
      scenes: [
        { id: "s1", durationFrames: 20, transitionFrames: 0, sfxCue: "riser" },
        { id: "s2", durationFrames: 10, transitionFrames: 0, sfxCue: "whoosh" },
      ],
    };
    expect(
      computeSfxPlacements(storyboard, [
        { cue: "riser", durationMs: 1500 },
        { cue: "whoosh", durationMs: 1000 },
      ]),
    ).toEqual([
      { cue: "riser", sceneId: "s1", from: 0, durationInFrames: 30 },
      { cue: "whoosh", sceneId: "s2", from: 20, durationInFrames: 10 },
    ]);
  });
});

describe("beatFrames / snapBpm", () => {
  it("beatFrames: ціле число кадрів для кожного темпу з BPM_GRID при 30 fps", () => {
    expect(BPM_GRID.map((bpm) => beatFrames(bpm))).toEqual([30, 25, 24, 20, 18, 15, 12]);
    for (const bpm of BPM_GRID) expect(Number.isInteger(beatFrames(bpm))).toBe(true);
    expect(beatFrames(120, 60)).toBe(30);
  });

  it("snapBpm: найближчий темп з сітки, за рівної відстані — нижчий", () => {
    expect(snapBpm(85)).toBe(90);
    expect(snapBpm(80)).toBe(75);
    expect(snapBpm(124)).toBe(120);
    expect(snapBpm(200)).toBe(150);
    expect(snapBpm(40)).toBe(60);
    expect(snapBpm(110)).toBe(100);
    for (const bpm of BPM_GRID) expect(snapBpm(bpm)).toBe(bpm);
  });
});

describe("computeEventPlacements / eventFrame", () => {
  const scene = (
    id: string,
    durationFrames: number,
    transitionFrames: number,
    extra: { sfxCue?: string | null; events?: SceneEvent[] } = {},
  ) => ({ id, durationFrames, transitionFrames, ...extra });
  const event = (id: string, at: number, sound: SceneEvent["sound"] = null): SceneEvent => ({
    id,
    at,
    what: id,
    sound,
    textIds: [],
  });

  it("глобальний кадр = from сцени + at, з урахуванням переходів; відсортовано", () => {
    const placements = computeEventPlacements({
      fps: 30,
      scenes: [
        scene("s1", 90, 0, {
          events: [event("late", 60, { cue: "pop", accent: "soft" }), event("early", 10)],
        }),
        // s2 стартує з 75 (90 − 15)
        scene("s2", 90, 15, { events: [event("hit", 20, { cue: "impact", accent: "hard" })] }),
      ],
    });
    expect(placements).toEqual([
      { sceneId: "s1", eventId: "early", frame: 10, cue: null, accent: "normal" },
      { sceneId: "s1", eventId: "late", frame: 60, cue: "pop", accent: "soft" },
      { sceneId: "s2", eventId: "hit", frame: 95, cue: "impact", accent: "hard" },
    ]);
  });

  it("legacy sfxCue → подія arrive на from сцени; власна arrive має перевагу", () => {
    const placements = computeEventPlacements({
      fps: 30,
      scenes: [
        scene("s1", 90, 0, { sfxCue: "whoosh" }),
        scene("s2", 90, 15, {
          sfxCue: "pop",
          events: [event("arrive", 5, { cue: "ding", accent: "normal" })],
        }),
        scene("s3", 90, 0, { sfxCue: "custom-1" }),
        scene("s4", 90, 0, { sfxCue: null }),
      ],
    });
    expect(placements.map((p) => [p.sceneId, p.eventId, p.frame, p.cue])).toEqual([
      ["s1", "arrive", 0, "whoosh"],
      ["s2", "arrive", 80, "ding"],
      // кастомний ключ — подія без звуку
      ["s3", "arrive", 165, null],
    ]);
  });

  it("фікстурний storyboard: legacy cue і події сцени s2", () => {
    const placements = computeEventPlacements(fixtureStoryboard);
    const s2 = computeTimeline(fixtureStoryboard).scenes[1];
    expect(placements.filter((p) => p.sceneId === "s2")).toEqual([
      { sceneId: "s2", eventId: "arrive", frame: s2?.from, cue: "pop", accent: "normal" },
      { sceneId: "s2", eventId: "price-hit", frame: (s2?.from ?? 0) + 30, cue: "impact", accent: "hard" },
      { sceneId: "s2", eventId: "badge-in", frame: (s2?.from ?? 0) + 60, cue: null, accent: "normal" },
    ]);
  });

  it("eventFrame: локальний кадр події; чужий id кидає Error", () => {
    const s2 = fixtureStoryboard.scenes[1];
    if (!s2) throw new Error("fixture");
    expect(eventFrame(s2, "price-hit")).toBe(30);
    expect(eventFrame(s2, "badge-in")).toBe(60);
    expect(() => eventFrame(s2, "nope")).toThrow(/nope/);
    const s1 = fixtureStoryboard.scenes[0];
    if (!s1) throw new Error("fixture");
    expect(() => eventFrame(s1, "price-hit")).toThrow(/s1/);
  });
});

describe("stripFrames", () => {
  it("кожні 15 кадрів, без кадру 0, з останнім кадром", () => {
    expect(stripFrames(60)).toEqual([15, 30, 45, 59]);
    expect(stripFrames(150)).toEqual([15, 30, 45, 60, 75, 90, 105, 120, 135, 149]);
  });

  it("останній кадр не дублюється, коли він кратний кроку", () => {
    expect(stripFrames(61)).toEqual([15, 30, 45, 60]);
    expect(stripFrames(31)).toEqual([15, 30]);
  });

  it("власний крок і короткі сцени", () => {
    expect(stripFrames(50, 20)).toEqual([20, 40, 49]);
    expect(stripFrames(10)).toEqual([9]);
    expect(stripFrames(1)).toEqual([0]);
  });
});
