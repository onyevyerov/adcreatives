import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { normalizeStoryboard } from "../src/normalize.ts";

describe("Крок 0 «чат»: українські примітки розкадровки", () => {
  it("normalizeStoryboard зберігає motionNote і musicNote", () => {
    const scenes = fixtureStoryboard.scenes.map((s, i) => ({
      ...s,
      motionNote: `Сцена ${i + 1}: лого виїжджає.`,
    }));
    const input = { ...fixtureStoryboard, scenes, musicNote: "Сучасний tech house, ~120 BPM" };
    const { storyboard } = normalizeStoryboard(input, { assetIds: ["a01", "a02"] });
    expect(storyboard.musicNote).toBe("Сучасний tech house, ~120 BPM");
    expect(storyboard.scenes.map((s) => s.motionNote)).toEqual(scenes.map((s) => s.motionNote));
  });

  it("стара розкадровка без приміток лишається без них", () => {
    const { storyboard } = normalizeStoryboard(fixtureStoryboard, { assetIds: ["a01", "a02"] });
    expect(storyboard).not.toHaveProperty("musicNote");
    expect(storyboard.scenes[0]).not.toHaveProperty("motionNote");
  });
});
