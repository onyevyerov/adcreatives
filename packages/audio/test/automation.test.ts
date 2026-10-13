import type { MusicMix, Scene, Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { applyMixAutomation, ENDING_FADE_SEC, MIX_SETTINGS, mixSections } from "../src/automation.ts";
import { renderSoundtrack } from "../src/mixer.ts";
import { frameToSample, gainToDb, pcmLength, rmsOf, SAMPLE_RATE, secToSamples } from "../src/pcm.ts";
import { fakeLibrary } from "./fakeSfx.ts";
import { steadyBed } from "./signals.ts";

/** Автоматизація частин треку (перенесено з `mixer.test.ts`) і фінал на повному рівні з антикліком (A7). */

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

  it("breakdown тихіший за full щонайменше на 6 дБ RMS, filtered — на 2.5–4 дБ", () => {
    const sb = storyboard({ mixes: ["filtered", "full", "breakdown"], events: { s1: [], s2: [], s3: [] } });
    const quiet = { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null })) };
    const out = renderSoundtrack({ music: steadyBed(16), storyboard: quiet, key: null, samples: LIB });
    expect(out.sounds).toHaveLength(0);
    // Вікна поза рампами (доля = 15 кадрів перед межею) і поза антикліком у кінці.
    const filtered = rmsOf(out.pcm, f2s(10), f2s(115));
    const full = rmsOf(out.pcm, f2s(150), f2s(265));
    const breakdown = rmsOf(out.pcm, f2s(300), f2s(415));
    expect(gainToDb(full) - gainToDb(breakdown)).toBeGreaterThanOrEqual(6);
    expect(gainToDb(full) - gainToDb(filtered)).toBeGreaterThanOrEqual(2.5);
    expect(gainToDb(full) - gainToDb(filtered)).toBeLessThanOrEqual(4);
    // Рампа в одну долю: за долю до межі ще звучить попередній стан, на межі — новий.
    const beforeRamp = rmsOf(out.pcm, f2s(250), f2s(268));
    const atBoundary = rmsOf(out.pcm, f2s(286), f2s(300));
    expect(Math.abs(gainToDb(beforeRamp) - gainToDb(full))).toBeLessThan(1);
    expect(Math.abs(gainToDb(atBoundary) - gainToDb(breakdown))).toBeLessThan(1.5);
    // Фінал без згасання: 100 мс перед антикліком — на рівні частини (breakdown), а не в fade-out.
    const fadeStart = pcmLength(out.pcm) - secToSamples(ENDING_FADE_SEC);
    const beforeFade = rmsOf(out.pcm, fadeStart - secToSamples(0.1), fadeStart);
    expect(Math.abs(gainToDb(beforeFade) - gainToDb(breakdown))).toBeLessThan(1.5);
  });
});

describe("applyMixAutomation: хук і фінал", () => {
  const OPTS = { fps: FPS, bpm: 120 };
  const bed = steadyBed(4);
  const n = pcmLength(bed);
  const sec = SAMPLE_RATE;

  it("filtered м'якший: на 2.5–4 дБ тихіший за full, зріз вище 1 кГц", () => {
    expect(MIX_SETTINGS.filtered.cutoffHz).toBeGreaterThanOrEqual(1000);
    expect(MIX_SETTINGS.breakdown).toEqual({ cutoffHz: 400, gainDb: -10 });
    const full = applyMixAutomation(bed, [{ mix: "full", fromFrame: 0 }], OPTS);
    const filtered = applyMixAutomation(bed, [{ mix: "filtered", fromFrame: 0 }], OPTS);
    const diff = gainToDb(rmsOf(full, 0, 2 * sec)) - gainToDb(rmsOf(filtered, 0, 2 * sec));
    expect(diff).toBeGreaterThanOrEqual(2.5);
    expect(diff).toBeLessThanOrEqual(4);
  });

  it("фінал: повний рівень до останніх 250 мс, далі raised cosine до нуля", () => {
    const out = applyMixAutomation(bed, [{ mix: "full", fromFrame: 0 }], OPTS);
    const fade = secToSamples(ENDING_FADE_SEC);
    const fadeStart = n - fade;
    // До антикліку — сухий трек (full обходить фільтр), побайтно.
    expect(Array.from(out.left.subarray(0, fadeStart))).toEqual(Array.from(bed.left.subarray(0, fadeStart)));
    // Остання 100 мс: RMS ≥ RMS попередньої секунди × RMS огинаючої антикліку − 3 дБ.
    const last = secToSamples(0.1);
    let env = 0;
    for (let i = n - last; i < n; i++) env += (0.5 * (1 + Math.cos((Math.PI * (i - fadeStart)) / fade))) ** 2;
    const envDb = gainToDb(Math.sqrt(env / last));
    const prevSec = gainToDb(rmsOf(out, n - last - sec, n - last));
    expect(gainToDb(rmsOf(out, n - last, n))).toBeGreaterThanOrEqual(prevSec + envDb - 3);
    // 100 мс перед антикліком — на рівні попередньої секунди (fade-out у секунду так не може).
    const beforeFade = gainToDb(rmsOf(out, fadeStart - last, fadeStart));
    expect(
      Math.abs(beforeFade - gainToDb(rmsOf(out, fadeStart - last - sec, fadeStart - last))),
    ).toBeLessThan(0.5);
    // Кінець — тиша, без кліку.
    expect(Math.abs(out.left[n - 1] ?? 1)).toBeLessThan(1e-3);
    expect(Math.abs(out.right[n - 1] ?? 1)).toBeLessThan(1e-3);
  });
});
