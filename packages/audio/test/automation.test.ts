import type { MusicMix, Scene, Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MIX_SETTINGS, mixSections } from "../src/automation.ts";
import { renderSoundtrack } from "../src/mixer.ts";
import { frameToSample, gainToDb, rmsOf } from "../src/pcm.ts";
import { fakeLibrary } from "./fakeSfx.ts";
import { steadyBed } from "./signals.ts";

/** Автоматизація частин треку і fade-out останньої секунди (перенесено з `mixer.test.ts`). */

const FPS = 30;
const f2s = (frame: number) => frameToSample(frame, FPS);

/** Фікстура при 120 BPM: s1 [0,150), s2 з 135, s3 з 285; разом 450 кадрів (15 с). */
function storyboard(
  opts: { mixes?: [MusicMix, MusicMix, MusicMix]; events?: Record<string, Scene["events"]> } = {},
): Storyboard {
  const mixes = opts.mixes ?? ["full", "full", "full"];
  return {
    ...fixtureStoryboard,
    scenes: fixtureStoryboard.scenes.map((s): Scene => ({ ...s, events: opts.events?.[s.id] ?? s.events })),
    musicBrief: {
      ...fixtureStoryboard.musicBrief,
      bpm: 120,
      structure: fixtureStoryboard.scenes.map((s, i) => ({
        label: s.id,
        sceneIds: [s.id],
        energy: 0.5,
        mix: mixes[i] ?? "full",
      })),
    },
  };
}

/** Фейкова бібліотека SFX: 10 cue × 3 варіанти. */
const LIB = fakeLibrary();

describe("automation by musicBrief.structure[].mix", () => {
  it("частини зливаються за mix; межа — from сцени", () => {
    expect(mixSections(storyboard({ mixes: ["filtered", "full", "full"] }))).toEqual([
      { mix: "filtered", fromFrame: 0 },
      { mix: "full", fromFrame: 135 },
    ]);
    // Сцени поза structure — full.
    const sb = storyboard();
    expect(mixSections({ ...sb, musicBrief: { ...sb.musicBrief, structure: [] } })).toEqual([
      { mix: "full", fromFrame: 0 },
    ]);
  });

  it("breakdown тихіший за full щонайменше на 6 дБ RMS, filtered — на ~4 дБ і більше", () => {
    const sb = storyboard({ mixes: ["filtered", "full", "breakdown"], events: { s1: [], s2: [], s3: [] } });
    const quiet = { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null })) };
    const out = renderSoundtrack({ music: steadyBed(16), storyboard: quiet, key: null, samples: LIB });
    expect(out.sounds).toHaveLength(0);
    // Вікна поза рампами (доля = 15 кадрів перед межею) і поза fade-out останньої секунди.
    const filtered = rmsOf(out.pcm, f2s(10), f2s(115));
    const full = rmsOf(out.pcm, f2s(150), f2s(265));
    const breakdown = rmsOf(out.pcm, f2s(300), f2s(415));
    expect(gainToDb(full) - gainToDb(breakdown)).toBeGreaterThanOrEqual(6);
    expect(gainToDb(full) - gainToDb(filtered)).toBeGreaterThanOrEqual(MIX_SETTINGS.filtered.gainDb * -1);
    // Рампа в одну долю: за долю до межі ще звучить попередній стан, на межі — новий.
    const beforeRamp = rmsOf(out.pcm, f2s(250), f2s(268));
    const atBoundary = rmsOf(out.pcm, f2s(286), f2s(300));
    expect(Math.abs(gainToDb(beforeRamp) - gainToDb(full))).toBeLessThan(1);
    expect(Math.abs(gainToDb(atBoundary) - gainToDb(breakdown))).toBeLessThan(1.5);
    // Остання секунда — fade-out до тиші.
    expect(rmsOf(out.pcm, f2s(447), f2s(450))).toBeLessThan(breakdown * 0.05);
  });
});
