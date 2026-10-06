import { computeTimeline, type Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { checkCopy, normalizeStoryboard } from "../src/normalize.ts";

const ASSETS = ["a01", "a02"];

function sb(scenes: Array<Partial<Storyboard["scenes"][number]>>): Storyboard {
  const base = fixtureStoryboard.scenes[0] as Storyboard["scenes"][number];
  return {
    ...structuredClone(fixtureStoryboard),
    scenes: scenes.map((s, i) => ({ ...structuredClone(base), id: `s${i + 1}`, ...s })),
  };
}

describe("normalizeStoryboard", () => {
  it("фікстура лишається без змін таймінгів", () => {
    const res = normalizeStoryboard(fixtureStoryboard, { assetIds: ASSETS });
    expect(res.totalFrames).toBe(computeTimeline(fixtureStoryboard).totalFrames);
    expect(res.storyboard.scenes.map((s) => s.durationFrames)).toEqual([150, 165, 165]);
  });

  it("закоротке відео масштабується до 450 кадрів, сцена ≥ 45", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 20, transitionFrames: 0, transitionIn: "cut" },
        { durationFrames: 60, transitionFrames: 10, transitionIn: "fade" },
        { durationFrames: 90, transitionFrames: 10, transitionIn: "slide" },
      ]),
      { assetIds: ASSETS },
    );
    expect(res.totalFrames).toBe(450);
    for (const s of res.storyboard.scenes) expect(s.durationFrames).toBeGreaterThanOrEqual(45);
    // пропорції збережено: третя сцена довша за другу
    const [a, b, c] = res.storyboard.scenes.map((s) => s.durationFrames) as [number, number, number];
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("задовге відео стискається до 900", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 400, transitionFrames: 0 },
        { durationFrames: 400, transitionFrames: 20, transitionIn: "fade" },
        { durationFrames: 400, transitionFrames: 20, transitionIn: "fade" },
      ]),
      { assetIds: ASSETS },
    );
    expect(res.totalFrames).toBe(900);
  });

  it("бажана тривалість клієнта (20 с) → рівно 600 кадрів", () => {
    const res = normalizeStoryboard(fixtureStoryboard, { assetIds: ASSETS, durationSeconds: 20 });
    expect(res.totalFrames).toBe(600);
    expect(computeTimeline(res.storyboard).totalFrames).toBe(600);
  });

  it("перехід ≤ третини коротшої сусідньої сцени; cut ⇔ 0", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 300, transitionFrames: 30 },
        { durationFrames: 60, transitionFrames: 50, transitionIn: "wipe" },
        { durationFrames: 200, transitionFrames: 25, transitionIn: "cut" },
        { durationFrames: 200, transitionFrames: 0, transitionIn: "fade" },
      ]),
      { assetIds: ASSETS },
    );
    const [s1, s2, s3, s4] = res.storyboard.scenes as [
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
    ];
    expect(s1.transitionFrames).toBe(0);
    expect(s2.transitionFrames).toBeLessThanOrEqual(
      Math.floor(Math.min(s1.durationFrames, s2.durationFrames) / 3),
    );
    expect(s3.transitionFrames).toBe(0);
    expect(s4.transitionFrames).toBeGreaterThan(0);
  });

  it("викидає неіснуючі assetIds/factIds, emphasis без збігу, дублікати id", () => {
    const res = normalizeStoryboard(
      sb([
        {
          assetIds: ["a01", "zz9"],
          factIds: ["f1", "f9"],
          text: { headline: "Кава", sub: " ", emphasis: ["Кава", "чай"] },
        },
        { id: "s1" },
      ]),
      { assetIds: ASSETS, factIds: ["f1"] },
    );
    const [first, second] = res.storyboard.scenes;
    expect(first?.assetIds).toEqual(["a01"]);
    expect(first?.factIds).toEqual(["f1"]);
    expect(first?.text).toEqual({ headline: "Кава", sub: null, emphasis: ["Кава"] });
    expect(second?.id).toBe("s2");
    expect(res.changes.some((c) => c.includes("zz9"))).toBe(true);
  });

  it("довжина тексту звіряється з copyRules для обраних форматів", () => {
    const long = sb([
      {
        text: {
          headline: "Дуже довгий заголовок, який точно не влізе у три рядки вертикалі",
          sub: null,
          emphasis: [],
        },
      },
    ]);
    const vertical = checkCopy(long, ["vertical"]);
    expect(vertical).toContainEqual(
      expect.objectContaining({ sceneId: "s1", field: "headline", kind: "length", limit: 54 }),
    );
    const res = normalizeStoryboard(long, { assetIds: ASSETS, formats: ["landscape"] });
    expect(res.textIssues).toEqual([]);
  });
});
