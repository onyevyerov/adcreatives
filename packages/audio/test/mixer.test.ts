import {
  type MusicMix,
  type Scene,
  type SceneEvent,
  type SoundAccent,
  type SoundCue,
  type Storyboard,
  sha256,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { MIX_SETTINGS, mixSections } from "../src/automation.ts";
import { lowBandOnsets } from "../src/beat.ts";
import { audibilityWindow, MASTER_CEILING_DBFS, renderSoundtrack, soundtrackHash } from "../src/mixer.ts";
import { dbToGain, frameToSample, gainToDb, peakOf, rmsOf, SAMPLE_RATE } from "../src/pcm.ts";
import { FALLBACK_KEY, parseKey, pentatonic, scaleFrequency, synthCue } from "../src/synth.ts";
import { decodeWav } from "../src/wav.ts";
import { metronome, steadyBed } from "./signals.ts";

const FPS = 30;
const f2s = (frame: number) => frameToSample(frame, FPS);

const ev = (id: string, at: number, cue: SoundCue, accent: SoundAccent = "normal"): SceneEvent => ({
  id,
  at,
  what: `${cue} ${id}`,
  sound: { cue, accent },
  textIds: [],
});

/** Фікстура при 120 BPM: s1 [0,150), s2 з 135, s3 з 285; разом 450 кадрів (15 с). */
function storyboard(
  opts: { mixes?: [MusicMix, MusicMix, MusicMix]; events?: Record<string, SceneEvent[]> } = {},
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

/** Події всіх 10 cue з різними акцентами (плюс legacy sfxCue фікстури: whoosh, pop, shimmer). */
const ALL_EVENTS: Record<string, SceneEvent[]> = {
  s1: [
    ev("tick-a", 20, "tick", "soft"),
    ev("click-a", 40, "click"),
    ev("pop-1", 60, "pop"),
    ev("pop-2", 75, "pop", "soft"),
    ev("ding-3", 90, "ding"),
    ev("rise", 134, "riser", "hard"),
  ],
  s2: [
    ...(fixtureStoryboard.scenes[1]?.events ?? []),
    ev("slam", 90, "slam", "hard"),
    ev("sw", 120, "swoosh", "soft"),
  ],
  s3: [ev("wh", 30, "whoosh"), ev("shim", 100, "shimmer", "soft"), ev("imp2", 140, "impact", "soft")],
};

const music = () => metronome({ bpm: 120, offsetSec: 0.07, durationSec: 16, busy: true, pad: true });

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
    const out = renderSoundtrack({ music: steadyBed(16), storyboard: quiet, key: null });
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

describe("event layer", () => {
  const sb = storyboard({ events: ALL_EVENTS });
  const withEvents = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor" });
  const noEvents = renderSoundtrack({
    music: music(),
    storyboard: { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null, events: [] })) },
    key: "A minor",
  });

  it("кожна подія зі звуком розміщена: 10 cue + legacy sfxCue", () => {
    const cues = new Set(withEvents.sounds.map((s) => s.cue));
    expect([...cues].sort()).toEqual(
      ["click", "ding", "impact", "pop", "riser", "shimmer", "slam", "swoosh", "tick", "whoosh"].sort(),
    );
    // badge-in без звуку — не звучить.
    expect(withEvents.sounds.find((s) => s.eventId === "badge-in")).toBeUndefined();
    expect(withEvents.sounds.map((s) => `${s.sceneId}:${s.eventId}`)).toEqual(
      expect.arrayContaining(["s1:arrive", "s2:arrive", "s3:arrive", "s2:price-hit"]),
    );
  });

  it("кожна подія чутна: пік у вікні 100 мс ≥ RMS музики в тому ж вікні + 6 дБ", () => {
    for (const s of withEvents.sounds) {
      const [a, b] = s.window;
      const peak = peakOf(withEvents.stems.events, a, b);
      // Музика без подій (до дакінгу) — суворіша опора, ніж музика після дакінгу.
      const musicRms = Math.max(rmsOf(noEvents.stems.music, a, b), rmsOf(withEvents.stems.music, a, b));
      expect(
        gainToDb(peak) - gainToDb(musicRms),
        `${s.sceneId}:${s.eventId} (${s.cue})`,
      ).toBeGreaterThanOrEqual(6);
    }
  });

  it("семантика кадру: riser закінчується на кадрі, whoosh/swoosh мають пік на кадрі, решта стартує з кадру", () => {
    for (const s of withEvents.sounds) {
      expect(s.at).toBe(f2s(s.frame));
      const sound = synthCue(s.cue, { key: FALLBACK_KEY, degree: 0, beatSec: 0.5, seed: 1 });
      if (s.cue === "riser") expect(s.start + sound.left.length).toBe(s.at);
      else if (s.cue === "whoosh" || s.cue === "swoosh") expect(s.start).toBeLessThan(s.at);
      else expect(s.start).toBe(s.at);
      expect(s.window).toEqual(audibilityWindow(s.cue, s.at));
    }
    // Пік whoosh — рівно на кадрі (у межах кількох мс).
    const wh = withEvents.sounds.find((s) => s.eventId === "wh");
    const sound = synthCue("whoosh", { key: FALLBACK_KEY, degree: 0, beatSec: 0.5, seed: 1 });
    let peakAt = 0;
    for (let i = 0; i < sound.left.length; i++) {
      if (
        Math.abs(sound.left[i] ?? 0) + Math.abs(sound.right[i] ?? 0) >
        Math.abs(sound.left[peakAt] ?? 0) + Math.abs(sound.right[peakAt] ?? 0)
      )
        peakAt = i;
    }
    expect(Math.abs(peakAt - sound.anchor) / SAMPLE_RATE).toBeLessThan(0.03);
    expect(wh?.start).toBe((wh?.at ?? 0) - sound.anchor);
  });

  it("послідовні pop/ding у сцені йдуть угору по пентатоніці тональності", () => {
    const s1 = withEvents.sounds.filter((s) => s.sceneId === "s1" && (s.cue === "pop" || s.cue === "ding"));
    expect(s1.map((s) => s.degree)).toEqual([0, 1, 2]);
    // pop arrive у s2 — новий відлік.
    expect(withEvents.sounds.find((s) => s.sceneId === "s2" && s.eventId === "arrive")?.degree).toBe(0);
    expect(withEvents.sounds.find((s) => s.cue === "impact")?.degree).toBeNull();
  });

  it("accent → гучність: hard > normal > soft за інших рівних", () => {
    const one = (accent: "soft" | "normal" | "hard") =>
      renderSoundtrack({
        music: steadyBed(16),
        storyboard: storyboard({ events: { s1: [ev("p", 60, "pop", accent)], s2: [], s3: [] } }),
        key: null,
      }).sounds.find((s) => s.eventId === "p")?.gain ?? 0;
    expect(gainToDb(one("hard")) - gainToDb(one("normal"))).toBeCloseTo(3, 1);
    expect(gainToDb(one("normal")) - gainToDb(one("soft"))).toBeCloseTo(2, 1);
  });

  it("дакінг: після impact/slam музика просідає на ~d і відновлюється за кілька τ", () => {
    const imp = withEvents.sounds.find((s) => s.eventId === "price-hit");
    if (!imp) throw new Error("немає price-hit");
    const w = Math.round(0.02 * SAMPLE_RATE);
    const ducked = rmsOf(withEvents.stems.music, imp.at + w, imp.at + 2 * w);
    const plain = rmsOf(noEvents.stems.music, imp.at + w, imp.at + 2 * w);
    expect(ducked / plain).toBeLessThan(0.6);
    const later = imp.at + Math.round(0.9 * SAMPLE_RATE);
    expect(
      rmsOf(withEvents.stems.music, later, later + w) / rmsOf(noEvents.stems.music, later, later + w),
    ).toBeGreaterThan(0.97);
  });
});

describe("master", () => {
  const sb = storyboard({ events: ALL_EVENTS });

  it("RMS ≈ −14 dBFS, пік ≤ −1 dBFS у WAV 44.1 кГц / 16 біт / стерео довжини відео", () => {
    const out = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor" });
    expect(out.durationMs).toBe(15_000);
    expect(out.wav.readUInt16LE(22)).toBe(2);
    expect(out.wav.readUInt32LE(24)).toBe(44_100);
    expect(out.wav.readUInt16LE(34)).toBe(16);
    const pcm = decodeWav(out.wav);
    expect(pcm.left.length).toBe(15 * 44_100);
    expect(gainToDb(peakOf(pcm))).toBeLessThanOrEqual(MASTER_CEILING_DBFS);
    expect(Math.abs(gainToDb(rmsOf(pcm)) - -14)).toBeLessThan(1);
    // Долі музики в зведенні — на сітці кадрів (±1 кадр).
    const onsets = lowBandOnsets(out.stems.music).filter((o) => o.timeSec < 13.5);
    for (const o of onsets) {
      const r = o.timeSec % 0.5;
      expect(Math.min(r, 0.5 - r)).toBeLessThanOrEqual(1 / 30);
    }
  });

  it("той самий вхід → побайтно той самий WAV; інший вхід → інший", () => {
    const a = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor" });
    const b = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor" });
    expect(a.wav.equals(b.wav)).toBe(true);
    expect(sha256(a.wav)).toBe(sha256(b.wav));
    const c = renderSoundtrack({ music: music(), storyboard: sb, key: "D major" });
    expect(c.wav.equals(a.wav)).toBe(false);
  });

  it("без музики — лише шар подій, теж у мастері", () => {
    const out = renderSoundtrack({ music: null, storyboard: sb, key: null });
    expect(out.alignment).toBeNull();
    expect(peakOf(out.pcm)).toBeGreaterThan(0);
    expect(gainToDb(peakOf(out.pcm))).toBeLessThanOrEqual(MASTER_CEILING_DBFS);
  });
});

describe("soundtrackHash", () => {
  const sb = storyboard({ events: ALL_EVENTS });
  const base = soundtrackHash({ planHash: "p", key: "A minor", storyboard: sb });

  it("включає planHash, тональність, події, таймлайн і mix частин", () => {
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: structuredClone(sb) })).toBe(base);
    expect(soundtrackHash({ planHash: "q", key: "A minor", storyboard: sb })).not.toBe(base);
    expect(soundtrackHash({ planHash: "p", key: "C major", storyboard: sb })).not.toBe(base);
    const moved = storyboard({ events: { ...ALL_EVENTS, s3: [ev("wh", 31, "whoosh")] } });
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: moved })).not.toBe(base);
    const longer = {
      ...sb,
      scenes: sb.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 180 } : s)),
    };
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: longer })).not.toBe(base);
    const mixes = storyboard({ events: ALL_EVENTS, mixes: ["full", "full", "breakdown"] });
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: mixes })).not.toBe(base);
  });
});

describe("synth", () => {
  it("тональність: розбір і fallback — ля-мінорна пентатоніка", () => {
    expect(parseKey("A minor")).toEqual({ root: 9, minor: true });
    expect(parseKey("F# major")).toEqual({ root: 6, minor: false });
    expect(parseKey("Bb minor")).toEqual({ root: 10, minor: true });
    expect(parseKey("Am")).toEqual({ root: 9, minor: true });
    expect(parseKey("D dorian")).toEqual({ root: 2, minor: true });
    expect(parseKey("E")).toEqual({ root: 4, minor: false });
    expect(parseKey("warm and cozy")).toBeNull();
    expect(parseKey(null)).toBeNull();
    expect(FALLBACK_KEY).toEqual({ root: 9, minor: true });
    expect(pentatonic(FALLBACK_KEY)).toEqual([0, 3, 5, 7, 10]);
    // A5 = 880 Гц; ступені йдуть угору, через октаву.
    expect(scaleFrequency(FALLBACK_KEY, 0, 5)).toBeCloseTo(880, 6);
    const freqs = [0, 1, 2, 3, 4, 5, 6].map((d) => scaleFrequency(FALLBACK_KEY, d, 5));
    for (let i = 1; i < freqs.length; i++) expect(freqs[i] ?? 0).toBeGreaterThan(freqs[i - 1] ?? 0);
    expect(freqs[5]).toBeCloseTo(1760, 6);
  });

  it("детермінований синтез з нормалізованим піком", () => {
    for (const cue of [
      "whoosh",
      "swoosh",
      "riser",
      "impact",
      "slam",
      "pop",
      "ding",
      "tick",
      "click",
      "shimmer",
    ] as const) {
      const a = synthCue(cue, { key: FALLBACK_KEY, degree: 1, beatSec: 0.5, seed: 42 });
      const b = synthCue(cue, { key: FALLBACK_KEY, degree: 1, beatSec: 0.5, seed: 42 });
      expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer)), cue).toBe(true);
      const peak = peakOf({ sampleRate: SAMPLE_RATE, left: a.left, right: a.right });
      expect(peak, cue).toBeCloseTo(1, 5);
      expect(a.left.every(Number.isFinite), cue).toBe(true);
    }
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });
});
