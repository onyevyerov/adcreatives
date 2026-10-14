import { describe, expect, it } from "vitest";
import { Biquad } from "../src/dsp.ts";
import { FALLBACK_KEY, nearestScaleNote, parseKey, scaleStep } from "../src/key.ts";
import {
  createStereo,
  gainToDb,
  monoOf,
  peakOf,
  rmsOf,
  SAMPLE_RATE,
  type StereoPcm,
  secToSamples,
} from "../src/pcm.ts";
import {
  analyzeSample,
  ENVELOPE_WINDOW_SEC,
  estimatePitch,
  MAX_SAMPLE_SEC,
  MONO_BELOW_HZ,
  MONO_CUES,
  MONO_MIN_CORRELATION,
  PITCH_CONFIDENCE,
  pitchShifts,
  RISER_TAIL_SEC,
  renderSample,
  WIDE_MIN_CORRELATION,
} from "../src/samples.ts";
import { correlation } from "../src/stereo.ts";
import { FAKE_LEAD_SEC, FAKE_PEAK_SEC, fakeSample } from "./fakeSfx.ts";
import { mulberry32 } from "./signals.ts";

const sec = (samples: number) => samples / SAMPLE_RATE;

function tone(hz: number, durSec: number, sr = SAMPLE_RATE) {
  const pcm = createStereo(Math.round(durSec * sr), sr);
  for (let i = 0; i < pcm.left.length; i++) {
    const x = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr) * Math.exp(-i / sr / 0.2);
    pcm.left[i] = x;
    pcm.right[i] = x;
  }
  return pcm;
}

describe("analyzeSample: onset, пік, якір", () => {
  it("onset-cue: якір — onset після тиші (±1 мс), без тиші на початку", () => {
    for (const cue of ["pop", "impact", "slam", "click", "tick", "ding", "shimmer"] as const) {
      const a = analyzeSample(cue, fakeSample(cue));
      if (!a) throw new Error(cue);
      expect(Math.abs(sec(a.onset) - FAKE_LEAD_SEC), cue).toBeLessThanOrEqual(0.001);
      expect(a.anchor, cue).toBe(a.onset);
      expect(a.from, cue).toBe(a.onset);
      expect(a.cutIn, cue).toBe(false);
    }
  });

  it("whoosh/swoosh/riser: якір — пік огинаючої (там, де його задумано)", () => {
    for (const cue of ["whoosh", "swoosh", "riser"] as const) {
      const a = analyzeSample(cue, fakeSample(cue));
      if (!a) throw new Error(cue);
      // riser — кінець найгучнішого вікна огинаючої (обрив), whoosh/swoosh — його центр.
      expect(a.anchor, cue).toBe(
        cue === "riser" ? a.peak + Math.floor(secToSamples(ENVELOPE_WINDOW_SEC) / 2) : a.peak,
      );
      expect(Math.abs(sec(a.anchor) - FAKE_LEAD_SEC - (FAKE_PEAK_SEC[cue] as number)), cue).toBeLessThan(
        0.015,
      );
      expect(a.from, cue).toBe(a.onset);
    }
    // riser: хвіст після піку відрізано — лишається 30 мс.
    const r = analyzeSample("riser", fakeSample("riser"));
    expect(r && sec(r.to - r.anchor)).toBeCloseTo(RISER_TAIL_SEC, 3);
  });

  it("обмеження довжини: ≤ 2 с від початку; riser — ≤ 2 с до якоря, обрізаний початок з fade-in", () => {
    const long = tone(220, 4);
    const a = analyzeSample("impact", long);
    expect(a && sec(a.to - a.from)).toBeLessThanOrEqual(MAX_SAMPLE_SEC);
    const riser = createStereo(secToSamples(3.5));
    for (let i = 0; i < riser.left.length; i++) {
      const x = Math.min(1, i / secToSamples(3)) ** 2 * Math.sin(i / 7);
      riser.left[i] = i < secToSamples(3) ? x : 0;
      riser.right[i] = riser.left[i] as number;
    }
    const r = analyzeSample("riser", riser);
    if (!r) throw new Error("riser");
    expect(sec(r.anchor - r.from)).toBeCloseTo(2, 2);
    expect(r.cutIn).toBe(true);
    const out = renderSample(riser, r, { semitones: 0, sampleRate: SAMPLE_RATE });
    expect(Math.abs(out.left[0] ?? 1)).toBe(0);
    expect(peakOf({ sampleRate: SAMPLE_RATE, left: out.left, right: out.right })).toBeCloseTo(1, 6);
  });

  it("тиша або порожній семпл → null", () => {
    expect(analyzeSample("pop", createStereo(1000))).toBeNull();
    expect(analyzeSample("pop", createStereo(0))).toBeNull();
  });
});

describe("висота тону", () => {
  it("YIN: тон 466 Гц → 466 Гц упевнено; шум — невпевнено", () => {
    const est = estimatePitch(monoOf(tone(466.16, 0.4)), SAMPLE_RATE, 0);
    expect(est?.hz).toBeGreaterThan(466.16 * 0.998);
    expect(est?.hz).toBeLessThan(466.16 * 1.002);
    expect(est?.confidence).toBeGreaterThanOrEqual(PITCH_CONFIDENCE);
    for (const hz of [110, 880, 1500]) {
      const e = estimatePitch(monoOf(tone(hz, 0.4)), SAMPLE_RATE, 0);
      expect(Math.abs(12 * Math.log2((e?.hz ?? 1) / hz)), String(hz)).toBeLessThan(0.05);
    }
    const rand = mulberry32(5);
    const noise = createStereo(secToSamples(0.4));
    for (let i = 0; i < noise.left.length; i++) {
      noise.left[i] = rand() * 2 - 1;
      noise.right[i] = noise.left[i] as number;
    }
    const n = estimatePitch(monoOf(noise), SAMPLE_RATE, 0);
    expect(n?.confidence ?? 0).toBeLessThan(PITCH_CONFIDENCE);
    expect(PITCH_CONFIDENCE).toBe(0.85);
    // У тональних варіантах висота визначається; у шумових cue — не оцінюється.
    expect(analyzeSample("pop", fakeSample("pop", 1, { pitchHz: 466.16 }))?.pitchHz).toBeCloseTo(466.16, 0);
    expect(analyzeSample("whoosh", fakeSample("whoosh"))?.pitchHz).toBeNull();
  });

  it("пентатоніка: найближча нота і кроки вгору", () => {
    // Bb4 (70) → A4 (69) у ля-мінорній пентатоніці; далі C5, D5, E5, G5, A5.
    expect(nearestScaleNote(FALLBACK_KEY, 70.0)).toBe(69);
    expect(nearestScaleNote(FALLBACK_KEY, 70.6)).toBe(72);
    expect([1, 2, 3, 4, 5].map((n) => scaleStep(FALLBACK_KEY, 69, n))).toEqual([72, 74, 76, 79, 81]);
    const dMajor = parseKey("D major");
    if (!dMajor) throw new Error("key");
    expect(nearestScaleNote(dMajor, 60)).toBe(59);
  });

  it("pitchShifts: pop/ding угору в сцені від першої впевненої ноти, shimmer — лише підтягування", () => {
    const shifts = pitchShifts(
      [
        { cue: "pop", sceneId: "a", pitchHz: 466.16 },
        { cue: "impact", sceneId: "a", pitchHz: null },
        { cue: "ding", sceneId: "a", pitchHz: 466.16 },
        { cue: "pop", sceneId: "a", pitchHz: 466.16 },
        { cue: "shimmer", sceneId: "a", pitchHz: 466.16 },
        { cue: "pop", sceneId: "b", pitchHz: null },
        { cue: "pop", sceneId: "b", pitchHz: null },
      ],
      FALLBACK_KEY,
    );
    const r = shifts.map((s) => Math.round(s * 100) / 100);
    expect(r).toEqual([-1, 0, 2, 4, -1, 0, 3]);
    // Загальний зсув ≤ ±12: далекі ступені складаються на октаву.
    const many = pitchShifts(
      Array.from({ length: 12 }, () => ({ cue: "pop" as const, sceneId: "a", pitchHz: 440 })),
      FALLBACK_KEY,
    );
    for (const s of many) expect(Math.abs(s)).toBeLessThanOrEqual(12);
  });

  it("renderSample: зсув на +12 півтонів удвічі коротшає і підвищує тон на октаву", () => {
    const pcm = tone(440, 0.5);
    const a = analyzeSample("pop", pcm);
    if (!a) throw new Error("pop");
    const up = renderSample(pcm, a, { semitones: 12, sampleRate: SAMPLE_RATE });
    expect(up.left.length).toBe(Math.floor((a.to - a.from) / 2));
    const est = estimatePitch(monoOf({ sampleRate: SAMPLE_RATE, ...up }), SAMPLE_RATE, 0);
    expect(est?.hz).toBeGreaterThan(878);
    expect(est?.hz).toBeLessThan(882);
    // Детерміновано: той самий вхід — ті самі семпли.
    const again = renderSample(pcm, a, { semitones: 12, sampleRate: SAMPLE_RATE });
    expect(Buffer.from(again.left.buffer).equals(Buffer.from(up.left.buffer))).toBe(true);
  });
});

/** Звук події як `StereoPcm` (для вимірювань). */
const asPcm = (sound: { left: Float32Array; right: Float32Array }): StereoPcm => ({
  sampleRate: SAMPLE_RATE,
  left: sound.left,
  right: sound.right,
});

/** Моно-сума (L+R)/2 відносно гучнішого каналу, дБ (RMS). */
function monoLossDb(pcm: StereoPcm): number {
  const mono = monoOf(pcm);
  let m = 0;
  for (const v of mono) m += v * v;
  const ch = Math.max(rmsOf({ ...pcm, right: pcm.left }), rmsOf({ ...pcm, left: pcm.right }));
  return gainToDb(Math.sqrt(m / mono.length) / ch);
}

/** Канал через каскад з 4 біквадів HPF (48 дБ/окт). */
function highpassed(x: Float32Array, hz: number): Float32Array {
  const out = Float32Array.from(x);
  for (let k = 0; k < 4; k++) {
    const f = new Biquad().setHighpass(hz, SAMPLE_RATE);
    for (let i = 0; i < out.length; i++) out[i] = f.process(out[i] as number);
  }
  return out;
}

describe("моно-сумісність звуків подій", () => {
  it("політика ТЗ: impact/slam/drop — повністю моно, решта — моно нижче 150 Гц; поріг кореляції 0.3", () => {
    expect([...MONO_CUES]).toEqual(["impact", "slam", "drop"]);
    expect(MONO_BELOW_HZ).toBe(150);
    expect(MONO_MIN_CORRELATION).toBe(0.3);
    expect(WIDE_MIN_CORRELATION).toBe(-0.2);
  });

  it("протифазний семпл: аналіз бачить кореляцію < 0.3 → після renderSample моно-сума не тихіша за канал > 3 дБ", () => {
    // Як `impact.1` у замірі (кореляція −0.89): правий канал — перевернутий лівий плюс трохи шуму.
    const rand = mulberry32(21);
    const pcm = createStereo(secToSamples(0.5));
    for (let i = 0; i < pcm.left.length; i++) {
      const t = i / SAMPLE_RATE;
      const x = 0.5 * Math.exp(-t / 0.08) * (Math.sin(2 * Math.PI * 90 * t) + 0.5 * (rand() * 2 - 1));
      pcm.left[i] = x;
      pcm.right[i] = -0.85 * x + 0.05 * Math.exp(-t / 0.08) * (rand() * 2 - 1);
    }
    // Без політики моно-сума гасне на десятки дБ.
    expect(monoLossDb(pcm)).toBeLessThan(-15);
    for (const cue of ["pop", "click", "impact", "whoosh"] as const) {
      const a = analyzeSample(cue, pcm);
      if (!a) throw new Error(cue);
      expect(a.correlation, cue).toBeLessThan(-0.8);
      expect(a.monoFolded, cue).toBe(true);
      const out = asPcm(renderSample(pcm, a, { semitones: 0, sampleRate: SAMPLE_RATE }));
      expect(monoLossDb(out), cue).toBeGreaterThanOrEqual(-3);
      expect(peakOf(out), cue).toBeCloseTo(1, 6);
    }
  });

  it("impact/slam — у моно навіть з нормальною кореляцією; pop зі звичайним стерео — лише низ", () => {
    for (const cue of ["impact", "slam"] as const) {
      const pcm = fakeSample(cue);
      const a = analyzeSample(cue, pcm);
      if (!a) throw new Error(cue);
      expect(a.correlation, cue).toBeGreaterThanOrEqual(MONO_MIN_CORRELATION);
      expect(a.monoFolded, cue).toBe(true);
      const out = renderSample(pcm, a, { semitones: 0, sampleRate: SAMPLE_RATE });
      expect(Buffer.from(out.left.buffer).equals(Buffer.from(out.right.buffer)), cue).toBe(true);
    }
    const pop = analyzeSample("pop", fakeSample("pop"));
    expect(pop?.correlation).toBeGreaterThanOrEqual(MONO_MIN_CORRELATION);
    expect(pop?.monoFolded).toBe(false);
  });

  it("whoosh з декорельованим шумом (кореляція ≈ 0): верх лишається стерео, низ стає моно", () => {
    const rand = mulberry32(22);
    const n = secToSamples(0.8);
    const pcm = createStereo(n);
    // Шум кожного каналу свій: широкосмуговий плюс гул нижче 100 Гц.
    const rumble = [new Biquad().setLowpass(80, SAMPLE_RATE), new Biquad().setLowpass(80, SAMPLE_RATE)];
    for (let i = 0; i < n; i++) {
      const env = Math.sin((Math.PI * i) / n) ** 2;
      const [lo, ro] = rumble as [Biquad, Biquad];
      pcm.left[i] = 0.3 * env * (rand() * 2 - 1 + 8 * lo.process(rand() * 2 - 1));
      pcm.right[i] = 0.3 * env * (rand() * 2 - 1 + 8 * ro.process(rand() * 2 - 1));
    }
    const a = analyzeSample("whoosh", pcm);
    if (!a) throw new Error("whoosh");
    expect(Math.abs(a.correlation)).toBeLessThan(0.15);
    expect(a.monoFolded).toBe(false);
    const out = asPcm(renderSample(pcm, a, { semitones: 0, sampleRate: SAMPLE_RATE }));
    // Низ: був декорельований — став моно.
    const src = {
      sampleRate: SAMPLE_RATE,
      left: pcm.left.slice(a.from, a.to),
      right: pcm.right.slice(a.from, a.to),
    };
    expect(Math.abs(correlation(src, 60))).toBeLessThan(0.3);
    expect(correlation(out, 60)).toBeGreaterThan(0.95);
    // Верх (вище 1 кГц): кореляція та сама, що в оригіналі, ≈ 0.
    const hi = (p: StereoPcm) => ({
      sampleRate: SAMPLE_RATE,
      left: highpassed(p.left, 1000),
      right: highpassed(p.right, 1000),
    });
    expect(Math.abs(correlation(hi(out)))).toBeLessThan(0.15);
    expect(correlation(hi(out))).toBeCloseTo(correlation(hi(src)), 2);
  });
});
