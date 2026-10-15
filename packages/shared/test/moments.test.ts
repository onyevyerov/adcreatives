import { describe, expect, it } from "vitest";
import { joinFrames, momentFrames, momentLegend, type Scene } from "../src/index.ts";

describe("momentFrames", () => {
  it("±2 навколо події", () => {
    expect(momentFrames(10, 90)).toEqual([8, 9, 10, 11, 12]);
  });
  it("обрізає до меж сцени без дублів", () => {
    expect(momentFrames(0, 90)).toEqual([0, 1, 2]);
    expect(momentFrames(89, 90)).toEqual([87, 88, 89]);
    expect(momentFrames(1, 90)).toEqual([0, 1, 2, 3]);
    expect(momentFrames(5, 1)).toEqual([0]);
  });
});

describe("joinFrames", () => {
  it("останні 2 кадри і перші 3 наступної", () => {
    expect(joinFrames(90, 60)).toEqual({ out: [88, 89], in: [0, 1, 2] });
  });
  it("остання сцена — без вхідних кадрів", () => {
    expect(joinFrames(90, null)).toEqual({ out: [88, 89], in: [] });
  });
  it("дуже короткі сцени", () => {
    expect(joinFrames(1, 2)).toEqual({ out: [0], in: [0, 1] });
  });
});

describe("momentLegend", () => {
  const scene = {
    id: "s1",
    durationFrames: 90,
    events: [
      { id: "hit", at: 10, what: "x", sound: null, textIds: [] },
      { id: "end", at: 88, what: "y", sound: null, textIds: [] },
    ],
  } as unknown as Pick<Scene, "id" | "durationFrames" | "events">;

  it("детермінована, рядок на подію і склейку", () => {
    const a = momentLegend(scene, "vertical", 30, true);
    expect(a).toBe(momentLegend(scene, "vertical", 30, true));
    expect(a.split("\n")).toHaveLength(4);
    expect(a).toContain("- hit (at 10): 8 · 0.27s | 9 · 0.30s | 10 · 0.33s");
    expect(a).toContain("- join: 88 · 2.93s | 89 · 2.97s → next scene frames 0 | 1 | 2");
  });
  it("без склейки — без рядка join", () => {
    expect(momentLegend(scene, "square", 30, false)).not.toContain("join");
  });
});
