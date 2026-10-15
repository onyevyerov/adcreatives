import { describe, expect, it } from "vitest";
import { formatSoundSheet, SOUND_SHEET_MAX_CHARS, SoundSheet, type Storyboard } from "../src/index.ts";

const sheet = (n = 2): SoundSheet =>
  SoundSheet.parse({
    version: 1,
    fps: 30,
    bpm: 120,
    totalFrames: 600,
    beatShiftMs: 12,
    beatConfidence: 0.8,
    barOffsetMs: 0,
    sceneStarts: [
      { sceneId: "s2", frame: 90, beatOffsetMs: 3, onBar: true },
      { sceneId: "s1", frame: 0, beatOffsetMs: 0, onBar: true },
    ],
    sections: [
      { sceneId: "s1", mix: "filtered", fromFrame: 0, toFrame: 90 },
      { sceneId: "s2", mix: "full", fromFrame: 90, toFrame: 600 },
    ],
    events: Array.from({ length: n }, (_, i) => ({
      sceneId: i % 2 ? "s2" : "s1",
      eventId: `e${i}`,
      cue: "pop",
      accent: "normal",
      frame: 100 - i,
      ms: 3000,
      beatIndex: i,
      beatOffsetMs: i % 3 === 0 ? null : 5,
      peakDb: -12,
      ducked: false,
      silent: "none",
    })),
    rmsPerSecondDb: [-30, -20, -18],
    integratedLufs: -14,
    truePeakDbtp: -1,
  });
const storyboard = { scenes: [{ id: "s1" }, { id: "s2" }] } as unknown as Pick<Storyboard, "scenes">;

describe("formatSoundSheet", () => {
  it("детермінований, сцени за порядком розкадровки", () => {
    const text = formatSoundSheet(sheet(), storyboard);
    expect(text).toBe(formatSoundSheet(sheet(), storyboard));
    const starts = text.split("\n").filter((l) => /^s\d \| \d+ \| /.test(l));
    expect(starts[0]?.startsWith("s1")).toBe(true);
    expect(text).toContain("rms per second dBFS: -30 -20 -18");
  });
  it("обрізається до ліміту", () => {
    expect(formatSoundSheet(sheet(500), storyboard).length).toBeLessThanOrEqual(SOUND_SHEET_MAX_CHARS);
  });
  it("типова відомість ролика 30 с вкладається в ліміт без обрізання", () => {
    const text = formatSoundSheet(sheet(24), storyboard);
    expect(text.length).toBeLessThan(SOUND_SHEET_MAX_CHARS);
    expect(text.endsWith("…")).toBe(false);
  });
});
