import { TimelineError as SharedTimelineError, computeTimeline as sharedTimeline } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { scriptPayload } from "../../public/static/dev/fixture-events.js";
import {
  computeTimeline,
  formatSeconds,
  type SceneSegment,
  sceneSegments,
  secondMarks,
  segmentIndexAt,
  TimelineError,
  type TimelineInput,
  timelineOf,
  trackLayout,
  tryTimeline,
} from "../../public/static/js/lib/scene-track.js";

type SceneSpec = [id: string, durationFrames: number, transitionFrames: number];
/** fps — літерал 30, як у схемі `Storyboard` (вхід підходить обом реалізаціям). */
const board = (scenes: SceneSpec[]) => ({
  fps: 30 as const,
  scenes: scenes.map(([id, durationFrames, transitionFrames]) => ({ id, durationFrames, transitionFrames })),
});

/** Переходи різної довжини, включно зі склейкою посередині. */
const mixed = board([
  ["s1", 90, 0],
  ["s2", 120, 20],
  ["s3", 60, 0],
  ["s4", 150, 45],
  ["s5", 100, 7],
]);
/** Одна сцена. */
const single = board([["s1", 450, 0]]);
/** Нульові переходи (лише склейки); перша сцена з ненульовим transitionFrames — ігнорується. */
const cuts = board([
  ["a", 150, 12],
  ["b", 150, 0],
  ["c", 200, 0],
]);

describe("computeTimeline — порт @adc/shared", () => {
  it.each([
    ["fixtureStoryboard", fixtureStoryboard],
    ["переходи різної довжини", mixed],
    ["одна сцена", single],
    ["нульові переходи", cuts],
  ])("%s: той самий результат, що й @adc/shared", (_name, input) => {
    expect(computeTimeline(input)).toEqual(sharedTimeline(input));
  });

  it("fixtureStoryboard: 450 кадрів, 15 с, сцени 0/135/285", () => {
    const t = computeTimeline(fixtureStoryboard);
    expect(t).toMatchObject({ fps: 30, totalFrames: 450, durationSeconds: 15 });
    expect(t.scenes.map((s) => [s.from, s.end, s.transitionInFrames, s.transitionOutFrames])).toEqual([
      [0, 150, 0, 15],
      [135, 300, 15, 15],
      [285, 450, 15, 0],
    ]);
  });

  it.each([
    ["без сцен", board([])],
    ["нецілі кадри", board([["s1", 10.5, 0]])],
    ["нульова тривалість", board([["s1", 0, 0]])],
    [
      "від'ємний перехід",
      board([
        ["s1", 60, 0],
        ["s2", 60, -1],
      ]),
    ],
    [
      "перехід не коротший за сусідню сцену",
      board([
        ["s1", 30, 0],
        ["s2", 60, 30],
      ]),
    ],
  ])("%s: помилка, як у @adc/shared", (_name, input) => {
    expect(() => sharedTimeline(input)).toThrow(SharedTimelineError);
    let mine: unknown;
    try {
      computeTimeline(input);
    } catch (err) {
      mine = err;
    }
    expect(mine).toBeInstanceOf(TimelineError);
    expect((mine as Error).name).toBe("TimelineError");
    expect(() => sharedTimeline(input)).toThrow((mine as Error).message);
  });

  it("tryTimeline / timelineOf: null замість винятку", () => {
    expect(tryTimeline(board([]))).toBeNull();
    expect(tryTimeline(null)).toBeNull();
    expect(tryTimeline(single)?.totalFrames).toBe(450);
    expect(timelineOf(scriptPayload)?.durationSeconds).toBe(15);
    expect(timelineOf({ checkpoint: "brand" })).toBeNull();
    expect(timelineOf(null)).toBeNull();
  });
});

describe("trackLayout", () => {
  it("блоки й переходи не перекриваються і покривають увесь ролик", () => {
    for (const input of [fixtureStoryboard as TimelineInput, mixed, single, cuts]) {
      const t = computeTimeline(input);
      const { blocks, transitions, totalFrames } = trackLayout(t);
      const spans = [
        ...blocks.map((b) => [b.startFrame, b.endFrame]),
        ...transitions.map((x) => [x.startFrame, x.endFrame]),
      ].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
      let cursor = 0;
      for (const [a, b] of spans) {
        expect(a).toBe(cursor);
        cursor = b ?? 0;
      }
      expect(cursor).toBe(totalFrames);
      const pct = [...blocks, ...transitions].reduce((acc, s) => acc + s.widthPct, 0);
      expect(pct).toBeCloseTo(100, 9);
    }
  });

  it("переходи — лише там, де transitionFrames > 0", () => {
    const { transitions } = trackLayout(computeTimeline(mixed));
    expect(transitions.map((x) => [x.fromIndex, x.toIndex, x.frames])).toEqual([
      [0, 1, 20],
      [2, 3, 45],
      [3, 4, 7],
    ]);
    expect(trackLayout(computeTimeline(cuts)).transitions).toEqual([]);
    expect(trackLayout(computeTimeline(single)).blocks).toEqual([
      { id: "s1", index: 0, startFrame: 0, endFrame: 450, leftPct: 0, widthPct: 100 },
    ]);
  });

  it("fixtureStoryboard: відсотки блоків і переходів", () => {
    const { blocks, transitions } = trackLayout(computeTimeline(fixtureStoryboard));
    expect(blocks.map((b) => [b.startFrame, b.endFrame])).toEqual([
      [0, 135],
      [150, 285],
      [300, 450],
    ]);
    expect(transitions.map((x) => [x.leftPct, x.widthPct])).toEqual([
      [30, 10 / 3],
      [(285 / 450) * 100, 10 / 3],
    ]);
  });
});

describe("sceneSegments (скраббер B9)", () => {
  const check = (segs: SceneSegment[], total: number) => {
    expect(segs[0]?.startFrame).toBe(0);
    expect(segs.at(-1)?.endFrame).toBe(total);
    segs.slice(1).forEach((s, i) => {
      expect(s.startFrame).toBe(segs[i]?.endFrame);
    });
  };

  it("суцільні відрізки, межа — середина переходу", () => {
    const t = computeTimeline(fixtureStoryboard);
    const segs = sceneSegments(t);
    check(segs, 450);
    expect(segs.map((s) => [s.id, s.startFrame, s.endFrame])).toEqual([
      ["s1", 0, 142.5],
      ["s2", 142.5, 292.5],
      ["s3", 292.5, 450],
    ]);
    expect(segs[2]?.endSeconds).toBe(15);
    expect(segs[2]?.endPct).toBe(100);
    for (const input of [mixed, single, cuts])
      check(sceneSegments(computeTimeline(input)), computeTimeline(input).totalFrames);
  });

  it("склейка — межа на стику", () => {
    expect(sceneSegments(computeTimeline(cuts)).map((s) => s.startFrame)).toEqual([0, 150, 300]);
  });

  it("segmentIndexAt", () => {
    const segs = sceneSegments(computeTimeline(fixtureStoryboard));
    expect(segmentIndexAt(segs, 0)).toBe(0);
    expect(segmentIndexAt(segs, 4.7)).toBe(0);
    expect(segmentIndexAt(segs, 4.8)).toBe(1);
    expect(segmentIndexAt(segs, 14.99)).toBe(2);
    expect(segmentIndexAt(segs, 99)).toBe(2);
    expect(segmentIndexAt([], 1)).toBe(-1);
  });
});

describe("шкала і формат", () => {
  it("secondMarks: щосекунди, підписи кожні 5 с", () => {
    const marks = secondMarks(15);
    expect(marks).toHaveLength(16);
    expect(marks.filter((m) => m.major).map((m) => m.seconds)).toEqual([0, 5, 10, 15]);
    expect(marks.at(-1)?.pct).toBe(100);
    expect(secondMarks(16.5).at(-1)?.seconds).toBe(16);
    expect(secondMarks(0)).toEqual([]);
    expect(secondMarks(Number.NaN)).toEqual([]);
  });

  it("formatSeconds: кома як десятковий роздільник", () => {
    expect(formatSeconds(15)).toBe("15,0");
    expect(formatSeconds(5.5)).toBe("5,5");
    expect(formatSeconds(16.66)).toBe("16,7");
  });
});
