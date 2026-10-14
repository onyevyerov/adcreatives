import {
  type MusicMix,
  type Scene,
  type SceneEvent,
  SOUND_CUE_TRAITS,
  type SoundAccent,
  SoundCue,
  type Storyboard,
  sha256,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { DUCK_RELEASE_BEATS } from "../src/automation.ts";
import { MIN_BAR_CONFIDENCE } from "../src/bars.ts";
import { lowBandOnsets } from "../src/beat.ts";
import { Biquad } from "../src/dsp.ts";
import { FALLBACK_KEY, parseKey, pentatonic, scaleFrequency } from "../src/key.ts";
import { measureLoudness, truePeakDb } from "../src/loudness.ts";
import {
  ACCENT_DB,
  audibilityWindow,
  CUE_LEVEL_DB,
  MASTER_CEILING_DBFS,
  MASTER_RMS_DBFS,
  MASTER_TARGET_LUFS,
  MASTER_TRUE_PEAK_DBTP,
  MAX_CUE_DB,
  MIX_VERSION,
  type PlacedSound,
  renderSoundtrack,
  type Soundtrack,
  sampleHashes,
  soundtrackHash,
} from "../src/mixer.ts";
import {
  createStereo,
  dbToGain,
  frameToSample,
  gainToDb,
  monoOf,
  peakOf,
  rmsOf,
  SAMPLE_RATE,
  type StereoPcm,
  secToSamples,
} from "../src/pcm.ts";
import {
  ENVELOPE_WINDOW_SEC,
  envelope,
  estimatePitch,
  RISER_TAIL_SEC,
  type SfxSampleLibrary,
} from "../src/samples.ts";
import { decodeWav } from "../src/wav.ts";
import { fakeLibrary, fakeSfxSample } from "./fakeSfx.ts";
import { metronome, mulberry32, steadyBed } from "./signals.ts";
import { barGroove } from "./trackSignals.ts";

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

/** Фейкова бібліотека SFX: 10 cue × 3 варіанти. */
const LIB = fakeLibrary();

/** Лише задані події (legacy sfxCue фікстури прибрано). */
const only = (events: Record<string, SceneEvent[]>, mixes?: [MusicMix, MusicMix, MusicMix]): Storyboard => {
  const sb = storyboard({ events: { s1: [], s2: [], s3: [], ...events }, ...(mixes ? { mixes } : {}) });
  return { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null })) };
};

/** Пік огинаючої буфера: центр найгучнішого вікна або (`end`) його кінець — як в аналізі семплів. */
function envelopePeak(pcm: Parameters<typeof envelope>[0], at: "center" | "end" = "center"): number {
  const win = secToSamples(ENVELOPE_WINDOW_SEC);
  const env = envelope(pcm, win);
  let best = 0;
  for (let i = 0; i < env.length; i++) if ((env[i] as number) > (env[best] as number)) best = i;
  return at === "end" ? best : best - Math.floor(win / 2);
}

const music = () => metronome({ bpm: 120, offsetSec: 0.07, durationSec: 16, busy: true, pad: true });

/** Опора рівня події: RMS музики без подій у вікні чутності або в ±200 мс навколо кадру (більше з двох). */
function musicRef(plain: Soundtrack, s: PlacedSound): number {
  const ctx = secToSamples(0.2);
  return Math.max(rmsOf(plain.stems.music, ...s.window), rmsOf(plain.stems.music, s.at - ctx, s.at + ctx));
}

/** Смуга через два однакові біквади поспіль (24 дБ/окт). */
function band(pcm: StereoPcm, make: () => Biquad): StereoPcm {
  const out = createStereo(pcm.left.length, pcm.sampleRate);
  for (const ch of ["left", "right"] as const) {
    const f1 = make();
    const f2 = make();
    for (let i = 0; i < pcm[ch].length; i++) out[ch][i] = f2.process(f1.process(pcm[ch][i] as number));
  }
  return out;
}
/** Низ (бочка, бас) — нижче 120 Гц; верх — вище 1 кГц. */
const lowBand = (pcm: StereoPcm) => band(pcm, () => new Biquad().setLowpass(120, pcm.sampleRate));
const highBand = (pcm: StereoPcm) => band(pcm, () => new Biquad().setHighpass(1000, pcm.sampleRate));

/** Відрізок [a, b) музики обох зведень побайтно однаковий (дакінгу там нема). */
function sameMusic(x: Soundtrack, y: Soundtrack, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    if (x.stems.music.left[i] !== y.stems.music.left[i]) return false;
    if (x.stems.music.right[i] !== y.stems.music.right[i]) return false;
  }
  return true;
}

describe("event layer", () => {
  const sb = storyboard({ events: ALL_EVENTS });
  const withEvents = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor", samples: LIB });
  const noEvents = renderSoundtrack({
    music: music(),
    storyboard: { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null, events: [] })) },
    key: "A minor",
    samples: LIB,
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

  it("рівень події: пік у вікні 100 мс ≈ CUE_LEVEL_DB + ACCENT_DB над RMS музики, не вище +6 дБ", () => {
    expect(CUE_LEVEL_DB).toMatchObject({
      impact: 5,
      slam: 5,
      riser: 2,
      whoosh: 0,
      swoosh: 0,
      pop: -2,
      ding: -2,
      shimmer: -2,
      tick: -4,
      click: -4,
    });
    for (const cue of SoundCue.options) expect(CUE_LEVEL_DB[cue], cue).toBe(SOUND_CUE_TRAITS[cue].levelDb);
    expect(ACCENT_DB).toEqual({ soft: -3, normal: 0, hard: 3 });
    expect(MAX_CUE_DB).toBe(6);
    for (const s of withEvents.sounds) {
      const level = Math.min(MAX_CUE_DB, CUE_LEVEL_DB[s.cue] + ACCENT_DB[s.accent]);
      const over = gainToDb(peakOf(withEvents.stems.events, ...s.window)) - gainToDb(musicRef(noEvents, s));
      const label = `${s.sceneId}:${s.eventId} (${s.cue}, ${s.accent})`;
      // Вгору — лише хвости сусідніх подій у вікні; вниз — пік звуку поза вікном (підтяжка ≤ ×1.5).
      expect(over, label).toBeLessThanOrEqual(level + 0.5);
      expect(over, label).toBeGreaterThanOrEqual(level - 4);
    }
  });

  it("семантика кадру: riser закінчується на кадрі, whoosh/swoosh мають пік на кадрі, решта стартує з кадру", () => {
    for (const s of withEvents.sounds) {
      expect(s.at).toBe(f2s(s.frame));
      if (s.cue === "riser" || s.cue === "whoosh" || s.cue === "swoosh") expect(s.start).toBeLessThan(s.at);
      else expect(s.start).toBe(s.at);
      expect(s.window).toEqual(audibilityWindow(s.cue, s.at));
    }
  });

  it("послідовні pop/ding у сцені йдуть угору по пентатоніці тональності", () => {
    const s1 = withEvents.sounds.filter((s) => s.sceneId === "s1" && (s.cue === "pop" || s.cue === "ding"));
    expect(s1.map((s) => s.degree)).toEqual([0, 1, 2]);
    // Ступені — вгору: зсув відносно власної висоти кожного варіанта дає дедалі вищу ноту.
    const heard = s1.map((s) => {
      const variant = LIB[s.cue]?.[s.variant - 1];
      const own = variant ? estimatePitch(monoOf(variant.pcm), SAMPLE_RATE, 0.05 * SAMPLE_RATE)?.hz : null;
      return 12 * Math.log2((own ?? 1) / 440) + s.semitones;
    });
    for (let i = 1; i < heard.length; i++) expect(heard[i] ?? 0).toBeGreaterThan(heard[i - 1] ?? 0);
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
        samples: LIB,
      }).sounds.find((s) => s.eventId === "p")?.gain ?? 0;
    expect(gainToDb(one("hard")) - gainToDb(one("normal"))).toBeCloseTo(3, 1);
    expect(gainToDb(one("normal")) - gainToDb(one("soft"))).toBeCloseTo(3, 1);
  });

  it("дакінг impact/slam: HPF 150 Гц на музиці рівно на одну долю від кадру, верх не чіпається", () => {
    const imp = withEvents.sounds.find((s) => s.eventId === "price-hit");
    if (!imp) throw new Error("немає price-hit");
    const beat = f2s(15); // 120 BPM при 30 fps
    const ms = (x: number) => secToSamples(x / 1000);
    const lowDucked = lowBand(withEvents.stems.music);
    const lowPlain = lowBand(noEvents.stems.music);
    const hold: [number, number] = [imp.at + ms(10), imp.at + Math.round(beat * (1 - DUCK_RELEASE_BEATS))];
    expect(rmsOf(lowDucked, ...hold) / rmsOf(lowPlain, ...hold)).toBeLessThan(0.3);
    // Верх (хети, пед 1760 Гц) лишається: дакінг — не гучність, а «звільнений низ».
    const high =
      rmsOf(highBand(withEvents.stems.music), ...hold) / rmsOf(highBand(noEvents.stems.music), ...hold);
    expect(high).toBeGreaterThan(0.95);
    expect(high).toBeLessThan(1.05);
    // До кадру і після долі — побайтно сухий трек.
    expect(sameMusic(withEvents, noEvents, imp.at - ms(100), imp.at)).toBe(true);
    expect(sameMusic(withEvents, noEvents, imp.at + beat, imp.at + beat + ms(200))).toBe(true);
    expect(sameMusic(withEvents, noEvents, imp.at + beat - ms(20), imp.at + beat)).toBe(false);
  });

  it("дакінг riser: HPF музики відкривається від 300 Гц до 20 Гц і закінчується на кадрі події", () => {
    const rise = withEvents.sounds.find((s) => s.eventId === "rise");
    if (!rise) throw new Error("немає rise");
    const ms = (x: number) => secToSamples(x / 1000);
    expect(rise.at - rise.start).toBeGreaterThan(ms(500));
    const lowDucked = lowBand(withEvents.stems.music);
    const lowPlain = lowBand(noEvents.stems.music);
    const ratio = (a: number, b: number) => rmsOf(lowDucked, a, b) / rmsOf(lowPlain, a, b);
    // Початок riser — низ зрізаний; останні 30 мс — фільтр майже відкритий.
    expect(ratio(rise.start + ms(10), rise.start + ms(200))).toBeLessThan(0.3);
    expect(ratio(rise.at - ms(30), rise.at)).toBeGreaterThan(0.8);
    // Низ відкривається монотонно (по чвертях riser).
    const q = Math.floor((rise.at - rise.start) / 4);
    const quarters = [0, 1, 2, 3].map((k) => ratio(rise.start + k * q, rise.start + (k + 1) * q));
    for (let k = 1; k < 4; k++) expect(quarters[k] ?? 0).toBeGreaterThan(quarters[k - 1] ?? 0);
    // До riser і з кадру події — сухий трек.
    expect(sameMusic(withEvents, noEvents, rise.start - ms(100), rise.start)).toBe(true);
    expect(sameMusic(withEvents, noEvents, rise.at, rise.at + ms(200))).toBe(true);
  });

  it("дакінг drop (важкий удар, як impact/slam): HPF 150 Гц на музиці рівно на одну долю від кадру", () => {
    const render = (events: Record<string, SceneEvent[]>) =>
      renderSoundtrack({ music: music(), storyboard: only(events), key: "A minor", samples: LIB });
    const dropped = render({ s2: [ev("drop", 90, "drop", "hard")] });
    const plain = render({});
    const drop = dropped.sounds.find((s) => s.eventId === "drop");
    if (!drop) throw new Error("немає drop");
    expect(drop.start).toBe(drop.at);
    const beat = f2s(15);
    const ms = (x: number) => secToSamples(x / 1000);
    const hold: [number, number] = [drop.at + ms(10), drop.at + Math.round(beat * (1 - DUCK_RELEASE_BEATS))];
    expect(
      rmsOf(lowBand(dropped.stems.music), ...hold) / rmsOf(lowBand(plain.stems.music), ...hold),
    ).toBeLessThan(0.3);
    expect(sameMusic(dropped, plain, drop.at - ms(100), drop.at)).toBe(true);
    expect(sameMusic(dropped, plain, drop.at + beat, drop.at + beat + ms(200))).toBe(true);
    expect(sameMusic(dropped, plain, drop.at + beat - ms(20), drop.at + beat)).toBe(false);
  });

  it("шина подій: EQ (HPF 80 Гц / LPF 9 кГц) і спільний реверб — хвіст після сухого звуку", () => {
    const out = renderSoundtrack({
      music: null,
      storyboard: only({ s1: [ev("p", 60, "pop")] }),
      key: null,
      samples: LIB,
    });
    const s = out.sounds[0];
    if (!s) throw new Error("pop");
    const reverb = out.stems.reverb;
    expect(reverb.left.length).toBe(out.stems.events.left.length);
    // Предзатримка 10 мс: до кадру + 10 мс реверба немає (лише похибка FFT, < −160 дБ).
    expect(peakOf(reverb, 0, s.at + secToSamples(0.009))).toBeLessThan(1e-8);
    expect(peakOf(reverb, s.at + secToSamples(0.011), s.at + secToSamples(0.05))).toBeGreaterThan(1e-4);
    // Після кінця сухого звуку реверб ще звучить, тихіше за пік звуку.
    let end = out.stems.events.left.length;
    while (end > 0 && out.stems.events.left[end - 1] === 0 && out.stems.events.right[end - 1] === 0) end--;
    const tail = rmsOf(reverb, end + secToSamples(0.05), end + secToSamples(0.15));
    expect(tail).toBeGreaterThan(0);
    expect(gainToDb(tail)).toBeLessThan(gainToDb(peakOf(out.stems.events)) - 20);
    // Мастер = (музика + сухі події + реверб) × підсилення мастера (лімітер тут не працює).
    const j = s.at + secToSamples(0.02);
    const makeup = dbToGain(out.master.gainDb);
    expect(gainToDb(peakOf(out.stems.events) * makeup)).toBeLessThan(MASTER_CEILING_DBFS - 1);
    expect(out.pcm.left[j]).toBeCloseTo(
      ((out.stems.events.left[j] ?? 0) + (reverb.left[j] ?? 0)) * makeup,
      5,
    );
  });
});

describe("рівні: проєкт-фікстура", () => {
  // Фікстура зі своїми подіями (impact hard + legacy whoosh/pop/shimmer), усі частини — full.
  const sb = storyboard();
  const out = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor", samples: LIB });
  const plain = renderSoundtrack({
    music: music(),
    storyboard: { ...sb, scenes: sb.scenes.map((s) => ({ ...s, sfxCue: null, events: [] })) },
    key: "A minor",
    samples: LIB,
  });

  it("музика нормалізована до RMS −14 dBFS до подій (опора рівнів): від рівня входу не залежить", () => {
    const quiet = music();
    for (const ch of [quiet.left, quiet.right])
      for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] ?? 0) * 0.1;
    const fromQuiet = renderSoundtrack({ music: quiet, storyboard: sb, key: "A minor", samples: LIB });
    const first = f2s(15 * 30 - 30); // без останньої секунди (закінчення)
    // Груба опора: ±1 дБ (ширина стерео й автоматизація частин трохи міняють RMS).
    expect(Math.abs(gainToDb(rmsOf(plain.stems.music, 0, first)) - MASTER_RMS_DBFS)).toBeLessThan(1);
    expect(gainToDb(rmsOf(fromQuiet.stems.music, 0, first))).toBeCloseTo(
      gainToDb(rmsOf(out.stems.music, 0, first)),
      3,
    );
    expect(gainToDb(fromQuiet.masterGain) - gainToDb(out.masterGain)).toBeCloseTo(20, 3);
  });

  it("RMS музики в міксі ≥ −16 dBFS у секундах без подій", () => {
    const sec = SAMPLE_RATE;
    const beat = f2s(15);
    const busy = (a: number, b: number) =>
      peakOf(out.stems.events, a, b) > 0 ||
      out.sounds.some((s) => (s.cue === "impact" || s.cue === "slam") && s.at < b && s.at + beat > a);
    const free: number[] = [];
    for (let k = 0; k < 14; k++) if (!busy(k * sec, (k + 1) * sec)) free.push(k);
    expect(free.length).toBeGreaterThanOrEqual(5);
    for (const k of free) {
      expect(gainToDb(rmsOf(out.pcm, k * sec, (k + 1) * sec)), `секунда ${k}`).toBeGreaterThanOrEqual(-16);
    }
  });

  it("пік подій ≤ +6 дБ над RMS музики", () => {
    expect(out.sounds.map((s) => `${s.cue}:${s.accent}`).sort()).toEqual(
      ["impact:hard", "pop:normal", "shimmer:normal", "whoosh:normal"].sort(),
    );
    for (const s of out.sounds) {
      const over = gainToDb(peakOf(out.stems.events, ...s.window)) - gainToDb(musicRef(plain, s));
      // +0.001 дБ — похибка Float32 (ціль рівно +6 дБ для hard impact).
      expect(over, `${s.sceneId}:${s.eventId} (${s.cue}, ${s.accent})`).toBeLessThanOrEqual(
        MAX_CUE_DB + 0.001,
      );
    }
  });
});

describe("master", () => {
  const sb = storyboard({ events: ALL_EVENTS });

  it("фікстура зі steadyBed: −14 ±0.5 LUFS, true peak ≤ −1 dBTP; Soundtrack.master = заміри WAV", () => {
    const out = renderSoundtrack({
      music: steadyBed(16),
      storyboard: fixtureStoryboard,
      key: null,
      samples: LIB,
    });
    expect(out.sounds.length).toBeGreaterThan(0);
    expect(MASTER_TARGET_LUFS).toBe(-14);
    expect(MASTER_TRUE_PEAK_DBTP).toBe(-1);
    expect(Math.abs(out.master.integratedLufs - MASTER_TARGET_LUFS)).toBeLessThanOrEqual(0.5);
    expect(out.master.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    expect(Math.abs(out.master.gainDb)).toBeLessThanOrEqual(12);
    expect(out.master.integratedLufs).toBe(measureLoudness(out.pcm).integratedLufs);
    expect(out.master.truePeakDbtp).toBe(truePeakDb(out.pcm));
    // WAV 16 біт — ті самі заміри з точністю квантування.
    const pcm = decodeWav(out.wav);
    expect(Math.abs(measureLoudness(pcm).integratedLufs - MASTER_TARGET_LUFS)).toBeLessThanOrEqual(0.5);
    expect(truePeakDb(pcm)).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
  });

  it("усі 10 cue на треку-метрономі: −14 ±0.5 LUFS, пік ≤ −1 dBFS у WAV 44.1 кГц / 16 біт / стерео довжини відео", () => {
    const out = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor", samples: LIB });
    expect(out.durationMs).toBe(15_000);
    expect(out.wav.readUInt16LE(22)).toBe(2);
    expect(out.wav.readUInt32LE(24)).toBe(44_100);
    expect(out.wav.readUInt16LE(34)).toBe(16);
    const pcm = decodeWav(out.wav);
    expect(pcm.left.length).toBe(15 * 44_100);
    expect(gainToDb(peakOf(pcm))).toBeLessThanOrEqual(MASTER_CEILING_DBFS);
    expect(out.master.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    expect(Math.abs(measureLoudness(pcm).integratedLufs - MASTER_TARGET_LUFS)).toBeLessThanOrEqual(0.5);
    // Долі музики в зведенні — на сітці кадрів (±1 кадр).
    const onsets = lowBandOnsets(out.stems.music).filter((o) => o.timeSec < 13.5);
    for (const o of onsets) {
      const r = o.timeSec % 0.5;
      expect(Math.min(r, 0.5 - r)).toBeLessThanOrEqual(1 / 30);
    }
  });

  it("той самий вхід → побайтно той самий WAV; інший вхід → інший", () => {
    const a = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor", samples: LIB });
    const b = renderSoundtrack({ music: music(), storyboard: sb, key: "A minor", samples: LIB });
    expect(a.wav.equals(b.wav)).toBe(true);
    expect(sha256(a.wav)).toBe(sha256(b.wav));
    const c = renderSoundtrack({ music: music(), storyboard: sb, key: "D major", samples: LIB });
    expect(c.wav.equals(a.wav)).toBe(false);
  });

  it("без музики — лише шар подій, теж у мастері", () => {
    const out = renderSoundtrack({ music: null, storyboard: sb, key: null, samples: LIB });
    expect(out.alignment).toBeNull();
    expect(peakOf(out.pcm)).toBeGreaterThan(0);
    expect(gainToDb(peakOf(out.pcm))).toBeLessThanOrEqual(MASTER_CEILING_DBFS);
    expect(out.master.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    expect(Number.isFinite(out.master.gainDb)).toBe(true);
  });
});

describe("soundtrackHash", () => {
  const sb = storyboard({ events: ALL_EVENTS });
  const samples = sampleHashes(LIB);
  const base = soundtrackHash({ planHash: "p", key: "A minor", storyboard: sb, samples });

  it("включає planHash, тональність, події, таймлайн і mix частин", () => {
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: structuredClone(sb), samples })).toBe(
      base,
    );
    expect(soundtrackHash({ planHash: "q", key: "A minor", storyboard: sb, samples })).not.toBe(base);
    expect(soundtrackHash({ planHash: "p", key: "C major", storyboard: sb, samples })).not.toBe(base);
    const moved = storyboard({ events: { ...ALL_EVENTS, s3: [ev("wh", 31, "whoosh")] } });
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: moved, samples })).not.toBe(base);
    const longer = {
      ...sb,
      scenes: sb.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 180 } : s)),
    };
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: longer, samples })).not.toBe(base);
    const mixes = storyboard({ events: ALL_EVENTS, mixes: ["full", "full", "breakdown"] });
    expect(soundtrackHash({ planHash: "p", key: "A minor", storyboard: mixes, samples })).not.toBe(base);
  });

  it("MIX_VERSION = 4 входить у хеш: зміна версії інвалідує зведення", () => {
    expect(MIX_VERSION).toBe(4);
    const input = { planHash: "p", key: "A minor", storyboard: sb, samples };
    expect(soundtrackHash(input, MIX_VERSION)).toBe(base);
    expect(soundtrackHash(input, 3)).not.toBe(base);
    expect(soundtrackHash(input, 5)).not.toBe(base);
  });
});

describe("key", () => {
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
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
  });
});

describe("семпли бібліотеки на кадрі події", () => {
  const ms = (x: number) => Math.round((x / SAMPLE_RATE) * 1000 * 10) / 10;
  const one = (cue: SoundCue, frame = 60) =>
    renderSoundtrack({
      music: null,
      storyboard: only({ s1: [ev("x", frame, cue)] }),
      key: null,
      samples: LIB,
    });

  it("pop/impact/click починаються рівно з кадру: тиша на початку семпла обрізана (±1 мс)", () => {
    for (const cue of ["pop", "impact", "click", "ding"] as const) {
      const out = one(cue);
      const s = out.sounds[0];
      if (!s) throw new Error(cue);
      const oneMs = secToSamples(0.001);
      expect(peakOf(out.stems.events, 0, s.at), cue).toBe(0);
      const total = peakOf(out.stems.events);
      expect(peakOf(out.stems.events, s.at, s.at + oneMs) / total, cue).toBeGreaterThan(0.05);
    }
  });

  it("whoosh/swoosh: пік огинаючої — на кадрі (±1 мс)", () => {
    for (const cue of ["whoosh", "swoosh"] as const) {
      const out = one(cue, 90);
      const s = out.sounds[0];
      if (!s) throw new Error(cue);
      expect(Math.abs(ms(envelopePeak(out.stems.events) - s.at)), cue).toBeLessThanOrEqual(1);
      // Звук і до, і після кадру.
      expect(peakOf(out.stems.events, s.at - secToSamples(0.15), s.at - secToSamples(0.05))).toBeGreaterThan(
        0,
      );
      expect(peakOf(out.stems.events, s.at + secToSamples(0.05), s.at + secToSamples(0.15))).toBeGreaterThan(
        0,
      );
    }
  });

  it("swipe (anchor peak): пік огинаючої — на кадрі (±1 мс), вікно чутності ±50 мс", () => {
    const out = one("swipe", 90);
    const s = out.sounds[0];
    if (!s) throw new Error("swipe");
    expect(s.start).toBeLessThan(s.at);
    expect(Math.abs(ms(envelopePeak(out.stems.events) - s.at))).toBeLessThanOrEqual(1);
    expect(s.window).toEqual([s.at - secToSamples(0.05), s.at + secToSamples(0.05)]);
  });

  it("riser: наростає до кадру (найгучніше вікно закінчується на кадрі ±1 мс), після кадру ≤ 30 мс звуку", () => {
    const out = one("riser", 120);
    const s = out.sounds[0];
    if (!s) throw new Error("riser");
    expect(Math.abs(ms(envelopePeak(out.stems.events, "end") - s.at))).toBeLessThanOrEqual(1);
    const tailEnd = s.at + secToSamples(RISER_TAIL_SEC) + 1;
    expect(peakOf(out.stems.events, tailEnd, out.stems.events.left.length)).toBe(0);
    expect(rmsOf(out.stems.events, s.at - secToSamples(0.1), s.at)).toBeGreaterThan(
      4 * rmsOf(out.stems.events, s.at - secToSamples(0.8), s.at - secToSamples(0.7)),
    );
  });

  it("варіанти по колу в порядку розміщень: однакові не йдуть поспіль", () => {
    const out = renderSoundtrack({
      music: null,
      storyboard: only({
        s1: [ev("w1", 20, "whoosh"), ev("p1", 40, "pop"), ev("w2", 80, "whoosh")],
        s2: [ev("w3", 30, "whoosh"), ev("p2", 60, "pop")],
        s3: [ev("w4", 30, "whoosh")],
      }),
      key: null,
      samples: LIB,
    });
    const whooshes = out.sounds.filter((s) => s.cue === "whoosh");
    expect(whooshes.map((s) => s.variant)).toEqual([1, 2, 3, 1]);
    expect(whooshes.map((s) => s.sampleHash)).toEqual([
      "fake:whoosh.1",
      "fake:whoosh.2",
      "fake:whoosh.3",
      "fake:whoosh.1",
    ]);
    expect(out.sounds.filter((s) => s.cue === "pop").map((s) => s.variant)).toEqual([1, 2]);
  });

  it("висота: тон 466 Гц → найближча нота ля-мінорної пентатоніки (A4), послідовні pop — угору", () => {
    const samples: SfxSampleLibrary = { pop: [fakeSfxSample("pop", 1, { pitchHz: 466.16 })] };
    const frames = [30, 60, 90];
    const out = renderSoundtrack({
      music: null,
      storyboard: only({ s1: frames.map((f, i) => ev(`p${i}`, f, "pop")), s2: [ev("q", 30, "pop")] }),
      key: "A minor",
      samples,
    });
    const pops = out.sounds.filter((s) => s.sceneId === "s1");
    expect(pops.map((s) => s.degree)).toEqual([0, 1, 2]);
    const expected = [440, 523.25, 587.33];
    const mono = monoOf(out.stems.events);
    pops.forEach((s, i) => {
      const est = estimatePitch(mono, SAMPLE_RATE, s.at + secToSamples(0.01));
      expect(est?.hz ?? 0, s.eventId).toBeGreaterThan((expected[i] as number) * 0.995);
      expect(est?.hz ?? 0, s.eventId).toBeLessThan((expected[i] as number) * 1.005);
    });
    // Нова сцена — знову від найближчої ноти.
    expect(out.sounds.find((s) => s.sceneId === "s2")?.semitones).toBeCloseTo(pops[0]?.semitones ?? 0, 6);
    // Зсув підтягування — у межах ±6 півтонів, загальний — ±12.
    for (const s of out.sounds) expect(Math.abs(s.semitones)).toBeLessThanOrEqual(12);
    expect(Math.abs(pops[0]?.semitones ?? 99)).toBeLessThanOrEqual(6);
  });

  it("висота не визначена (шумовий pop) → лише кроки вгору по інтервалах пентатоніки від власної висоти", () => {
    const rand = mulberry32(3);
    const pcm = createStereo(secToSamples(0.25));
    for (let i = 0; i < pcm.left.length; i++) {
      const x = (rand() * 2 - 1) * Math.exp(-i / SAMPLE_RATE / 0.05);
      pcm.left[i] = x;
      pcm.right[i] = x;
    }
    const out = renderSoundtrack({
      music: null,
      storyboard: only({ s1: [ev("a", 30, "pop"), ev("b", 60, "pop"), ev("c", 90, "pop")] }),
      key: "A minor",
      samples: { pop: [{ cue: "pop", variant: 1, hash: "noise", pcm }] },
    });
    expect(out.sounds.map((s) => s.semitones)).toEqual([0, 3, 5]);
  });

  it("shimmer лише підтягується до тональності, без кроків", () => {
    const out = renderSoundtrack({
      music: null,
      storyboard: only({ s1: [ev("a", 30, "shimmer"), ev("b", 90, "shimmer")] }),
      key: "A minor",
      samples: { shimmer: [fakeSfxSample("shimmer", 1, { pitchHz: 1300 })] },
    });
    // 1300 Гц ≈ MIDI 87.76 → E6 (88): +0.24 півтона для обох.
    expect(out.sounds.map((s) => Math.round(s.semitones * 100) / 100)).toEqual([0.24, 0.24]);
  });

  it("cue без жодного семпла → його події без звуку, зведення будується", () => {
    const { impact: _drop, ...noImpact } = LIB;
    const sb = only({ s1: [ev("hit", 30, "impact"), ev("p", 60, "pop")] });
    const out = renderSoundtrack({ music: music(), storyboard: sb, key: null, samples: noImpact });
    expect(out.sounds.map((s) => s.cue)).toEqual(["pop"]);
    expect(out.silent.map((p) => `${p.eventId}:${p.cue}`)).toEqual(["hit:impact"]);
    expect(peakOf(out.stems.events, f2s(30), f2s(60))).toBe(0);
    expect(out.wav.length).toBeGreaterThan(44);
    // Порожня бібліотека — лише музика.
    const bare = renderSoundtrack({ music: music(), storyboard: sb, key: null, samples: {} });
    expect(bare.sounds).toHaveLength(0);
    expect(peakOf(bare.stems.events)).toBe(0);
  });

  it("зміна семпла використаного cue змінює soundtrackHash; невикористаного — ні", () => {
    const sb = only({ s1: [ev("p", 60, "pop")] });
    const hashOf = (lib: SfxSampleLibrary) =>
      soundtrackHash({ planHash: "p", key: null, storyboard: sb, samples: sampleHashes(lib) });
    const base = hashOf(LIB);
    expect(hashOf({ ...LIB, pop: [fakeSfxSample("pop", 1, { hashSuffix: "-new" })] })).not.toBe(base);
    expect(hashOf({ ...LIB, pop: [...(LIB.pop ?? [])].reverse() })).not.toBe(base);
    expect(hashOf({ ...LIB, tick: [fakeSfxSample("tick", 1, { hashSuffix: "-new" })] })).toBe(base);
  });
});

describe("вирівнювання музики на такт у зведенні", () => {
  it("трек без запасу на зсув такту → лише фаза долі, кінець ролика не тихий", () => {
    // Downbeat на 1.07 с, а трек довший за відео (15 с) лише на 0.5 с: зсув на такт лишив би тишу.
    const music = barGroove({ bpm: 120, offsetSec: 0.07, leadBeats: 2, durationSec: 15.5, busy: true });
    const s = renderSoundtrack({ music, storyboard: only({}), key: "A minor", samples: LIB });
    expect(s.alignment?.barConfidence ?? 0).toBeGreaterThanOrEqual(MIN_BAR_CONFIDENCE);
    expect((s.alignment?.shiftSamples ?? 0) / SAMPLE_RATE).toBeLessThan(0.5);
    // Остання секунда (до короткого fade закінчення) звучить на рівні решти треку.
    const m = s.stems.music;
    const n = m.left.length;
    const slice = (a: number, b: number) => ({
      ...m,
      left: m.left.subarray(a, b),
      right: m.right.subarray(a, b),
    });
    const tail = rmsOf(slice(n - SAMPLE_RATE, n - SAMPLE_RATE / 2));
    expect(tail).toBeGreaterThan(rmsOf(slice(0, n)) * 0.5);
  });
});
