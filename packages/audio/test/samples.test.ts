import { describe, expect, it } from "vitest";
import { FALLBACK_KEY, nearestScaleNote, parseKey, scaleStep } from "../src/key.ts";
import { createStereo, monoOf, peakOf, SAMPLE_RATE, secToSamples } from "../src/pcm.ts";
import {
  analyzeSample,
  ENVELOPE_WINDOW_SEC,
  estimatePitch,
  MAX_SAMPLE_SEC,
  PITCH_CONFIDENCE,
  pitchShifts,
  RISER_TAIL_SEC,
  renderSample,
} from "../src/samples.ts";
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
