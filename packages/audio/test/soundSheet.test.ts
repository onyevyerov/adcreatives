import {
  applySfxPlan,
  formatSoundSheet,
  type SceneEvent,
  SOUND_SHEET_MAX_CHARS,
  type SoundAccent,
  type SoundCue,
  SoundSheet,
  type Storyboard,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { renderSoundtrack } from "../src/mixer.ts";
import { buildSoundSheet, MixFacts, mixFacts } from "../src/soundSheet.ts";
import { fakeLibrary } from "./fakeSfx.ts";
import { metronome } from "./signals.ts";

const ev = (id: string, at: number, cue: SoundCue | null, accent: SoundAccent = "normal"): SceneEvent => ({
  id,
  at,
  what: `${cue ?? "silence"} ${id}`,
  sound: cue ? { cue, accent } : null,
  textIds: [],
});

/** Фікстура при 120 BPM (доля = 15 кадрів = 0.5 с): s1 [0,150), s2 з 135, s3 з 285; legacy sfxCue прибрано. */
const draft: Storyboard = {
  ...fixtureStoryboard,
  scenes: fixtureStoryboard.scenes.map((s) => ({
    ...s,
    sfxCue: null,
    events:
      s.id === "s1"
        ? [ev("tick-a", 20, "tick", "soft"), ev("hit", 30, "impact", "hard")]
        : s.id === "s2"
          ? [ev("pop-1", 30, "pop"), ev("quiet", 60, null), ev("gone", 90, "click")]
          : [ev("wh", 30, "whoosh"), ev("broken", 60, "ding")],
  })),
  musicBrief: { ...fixtureStoryboard.musicBrief, bpm: 120 },
};

/** План звукорежисера: s2/gone мовчить, s2/quiet отримує swoosh, s1/hit стає slam. */
const { storyboard: effective } = applySfxPlan(draft, {
  decisions: [
    { sceneId: "s2", eventId: "gone", sound: null, reason: "" },
    { sceneId: "s2", eventId: "quiet", sound: { cue: "swoosh", accent: "soft" }, reason: "" },
    { sceneId: "s1", eventId: "hit", sound: { cue: "slam", accent: "hard" }, reason: "" },
  ],
});

/** Бібліотека без ding (його семпли «не декодувались») і без tick (семплів немає). */
const LIB = (() => {
  const { ding: _ding, tick: _tick, ...rest } = fakeLibrary();
  return rest;
})();
const music = () => metronome({ bpm: 120, offsetSec: 0.07, durationSec: 16, busy: true, pad: true });

function sheetOf(facts: MixFacts) {
  return buildSoundSheet(facts, {
    storyboard: effective,
    draft,
    barOffsetMs: 12,
    integratedLufs: -14,
    truePeakDbtp: -1.2,
  });
}

describe("звукова відомість", () => {
  const soundtrack = renderSoundtrack({
    music: music(),
    storyboard: effective,
    key: "A minor",
    samples: LIB,
  });
  const facts = mixFacts(soundtrack, new Set<SoundCue>(["ding"]));
  const sheet = sheetOf(facts);

  it("валідна за схемою; кожна подія з cue — у відомості, у порядку кадрів", () => {
    expect(SoundSheet.parse(sheet)).toEqual(sheet);
    expect(sheet).toMatchObject({ version: 1, fps: 30, bpm: 120, totalFrames: 450, barOffsetMs: 12 });
    expect(sheet.events.map((e) => `${e.sceneId}/${e.eventId}:${e.cue}:${e.silent}`)).toEqual([
      "s1/tick-a:tick:no_sample",
      "s1/hit:slam:none",
      "s2/pop-1:pop:none",
      "s2/quiet:swoosh:none",
      "s2/gone:click:muted",
      "s3/wh:whoosh:none",
      "s3/broken:ding:decode_failed",
    ]);
    const frames = sheet.events.map((e) => e.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
  });

  it("кадр, мс і зсув до найближчої долі; пік — лише в тих, що звучать; дакінг — на важкому ударі", () => {
    const by = (id: string) => sheet.events.find((e) => e.eventId === id);
    // Кадр 30 = 1 с = рівно доля 2.
    expect(by("hit")).toMatchObject({ frame: 30, ms: 1000, beatIndex: 2, beatOffsetMs: 0, ducked: true });
    // Кадр 20 ≈ 666.7 мс → доля 1 (500 мс), зсув +166.7 мс.
    expect(by("tick-a")).toMatchObject({
      frame: 20,
      ms: 666.7,
      beatIndex: 1,
      beatOffsetMs: 166.7,
      peakDb: null,
    });
    // s2 з кадру 135: pop на 165 (5.5 с) → доля 11.
    expect(by("pop-1")).toMatchObject({ frame: 165, beatIndex: 11, beatOffsetMs: 0, ducked: false });
    expect(by("pop-1")?.peakDb).toEqual(expect.any(Number));
    // Вимкнене планом: cue з чернетки, тиша.
    expect(by("gone")).toMatchObject({
      cue: "click",
      frame: 225,
      peakDb: null,
      ducked: false,
      beatIndex: 15,
    });
    for (const e of sheet.events) {
      // Пік до лімітера: важкий удар може бути > 0 dBFS — тоді його притискає лімітер мастера.
      if (e.silent === "none") expect(e.peakDb).toEqual(expect.any(Number));
      else expect(e.peakDb).toBeNull();
    }
  });

  it("старти сцен проти долей, частини музики по сценах, RMS по секундах і мастер", () => {
    expect(sheet.sceneStarts.map((s) => [s.sceneId, s.frame, s.beatOffsetMs])).toEqual([
      ["s1", 0, 0],
      ["s2", 135, 0],
      ["s3", 285, 0],
    ]);
    expect(sheet.sections).toEqual([
      { sceneId: "s1", mix: "full", fromFrame: 0, toFrame: 150 },
      { sceneId: "s2", mix: "breakdown", fromFrame: 135, toFrame: 300 },
      { sceneId: "s3", mix: "breakdown", fromFrame: 285, toFrame: 450 },
    ]);
    expect(sheet.rmsPerSecondDb).toHaveLength(15);
    expect(sheet.rmsPerSecondDb.every((x) => Number.isFinite(x) && x < 0)).toBe(true);
    expect(sheet.integratedLufs).toBe(-14);
    expect(sheet.truePeakDbtp).toBe(-1.2);
    expect(sheet.beatConfidence).toEqual(expect.any(Number));
  });

  it("onBar: відомий лише при зсуві по такту — доля з k % 4 = 0", () => {
    const onBar = sheetOf({ ...facts, grid: { periodSec: 0.5, onBar: true } });
    // s1 — доля 0, s2 — доля 9, s3 — доля 19.
    expect(onBar.sceneStarts.map((s) => s.onBar)).toEqual([true, false, false]);
    const noBar = sheetOf({ ...facts, grid: { periodSec: 0.5, onBar: false } });
    expect(noBar.sceneStarts.map((s) => s.onBar)).toEqual([null, null, null]);
  });

  it("без сітки долей (ембієнт або без музики) — індекси й зсуви null", () => {
    const bare = renderSoundtrack({ music: null, storyboard: effective, key: null, samples: LIB });
    const s = sheetOf(mixFacts(bare));
    expect(s.beatShiftMs).toBeNull();
    expect(s.beatConfidence).toBeNull();
    expect(s.sceneStarts.every((x) => x.beatOffsetMs === null && x.onBar === null)).toBe(true);
    expect(s.events.every((e) => e.beatIndex === null && e.beatOffsetMs === null)).toBe(true);
    // Без плану (чернетка = ефективна) — нічого не «вимкнено».
    const plain = buildSoundSheet(mixFacts(bare), {
      storyboard: effective,
      draft: null,
      barOffsetMs: null,
      integratedLufs: null,
      truePeakDbtp: null,
    });
    expect(plain.events.some((e) => e.silent === "muted")).toBe(false);
  });

  it("детермінована: той самий мікс → побайтно той самий JSON, і з фактів, що пройшли через кеш (JSON)", () => {
    const again = renderSoundtrack({ music: music(), storyboard: effective, key: "A minor", samples: LIB });
    const a = JSON.stringify(sheet, null, 2);
    expect(JSON.stringify(sheetOf(mixFacts(again, new Set<SoundCue>(["ding"]))), null, 2)).toBe(a);
    const cached = MixFacts.parse(JSON.parse(JSON.stringify(facts)));
    expect(JSON.stringify(sheetOf(cached), null, 2)).toBe(a);
  });

  it("текст для промпта вкладається в ліміт", () => {
    const text = formatSoundSheet(sheet, effective);
    expect(text.length).toBeLessThanOrEqual(SOUND_SHEET_MAX_CHARS);
    expect(text).toContain("s2 | gone | click/normal | 225");
  });
});
