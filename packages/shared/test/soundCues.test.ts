import { describe, expect, it } from "vitest";
import { SoundCue } from "../src/schemas/storyboard.ts";
import { GRID_SOUND_CUES, HIT_SOUND_CUES, PITCHED_SOUND_CUES, SOUND_CUE_TRAITS } from "../src/soundCues.ts";

const cues = SoundCue.options;

describe("SOUND_CUE_TRAITS", () => {
  it("покриває кожен SoundCue і нічого зайвого: 30 cue", () => {
    expect(cues).toHaveLength(30);
    expect(Object.keys(SOUND_CUE_TRAITS).sort()).toEqual([...cues].sort());
  });

  it("важкі удари — impact, slam, drop", () => {
    expect([...HIT_SOUND_CUES].sort()).toEqual(["drop", "impact", "slam"]);
  });

  it("похідні набори відповідають таблиці", () => {
    expect([...GRID_SOUND_CUES]).toEqual(cues.filter((c) => SOUND_CUE_TRAITS[c].grid));
    expect([...PITCHED_SOUND_CUES].sort()).toEqual(["ding", "notify", "pop", "shimmer", "success"]);
    expect(cues.filter((c) => !SOUND_CUE_TRAITS[c].grid).sort()).toEqual([
      "click",
      "scan",
      "scribble",
      "slide",
      "tick",
      "typing",
    ]);
  });

  it("інваріанти: stepped ⇒ perScene; anchor onset ⇒ maxPreAnchorSec = 0; hit ⇒ stereo mono", () => {
    for (const cue of cues) {
      const t = SOUND_CUE_TRAITS[cue];
      if (t.pitch === "stepped") expect(t.perScene, cue).toBe(true);
      if (t.anchor === "onset") expect(t.maxPreAnchorSec, cue).toBe(0);
      if (t.hit) expect(t.stereo, cue).toBe("mono");
    }
  });
});
