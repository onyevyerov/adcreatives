import { describe, expect, it } from "vitest";
import { measureLoudness, truePeakDb } from "../src/loudness.ts";
import { createStereo, dbToGain, gainToDb, peakOf, type StereoPcm } from "../src/pcm.ts";

/** Синус `hz` з піковою амплітудою `db` dBFS у вибраних каналах. */
function sine(
  hz: number,
  db: number,
  sec: number,
  opts: { sampleRate?: number; channels?: "left" | "both"; phase?: number } = {},
): StereoPcm {
  const sr = opts.sampleRate ?? 48_000;
  const pcm = createStereo(Math.round(sec * sr), sr);
  const a = dbToGain(db);
  for (let i = 0; i < pcm.left.length; i++) {
    const v = a * Math.sin((2 * Math.PI * hz * i) / sr + (opts.phase ?? 0));
    pcm.left[i] = v;
    if (opts.channels === "both") pcm.right[i] = v;
  }
  return pcm;
}

/** Склеювання відрізків одного формату. */
function concat(...parts: StereoPcm[]): StereoPcm {
  const n = parts.reduce((a, p) => a + p.left.length, 0);
  const out = createStereo(n, parts[0]?.sampleRate);
  let at = 0;
  for (const p of parts) {
    out.left.set(p.left, at);
    out.right.set(p.right, at);
    at += p.left.length;
  }
  return out;
}

describe("measureLoudness (ITU-R BS.1770-4)", () => {
  it("калібрування: синус 997 Гц −20 dBFS в одному каналі → −23.0 ±0.3 LUFS (48 і 44.1 кГц)", () => {
    for (const sampleRate of [48_000, 44_100]) {
      const l = measureLoudness(sine(997, -20, 10, { sampleRate }));
      expect(l.integratedLufs).toBeCloseTo(-23, 0);
      expect(Math.abs(l.integratedLufs + 23)).toBeLessThanOrEqual(0.3);
      // Рівний тон: миттєва і короткочасна гучність = інтегральна.
      expect(Math.abs(l.momentaryMaxLufs - l.integratedLufs)).toBeLessThan(0.1);
      expect(Math.abs(l.shortTermMaxLufs - l.integratedLufs)).toBeLessThan(0.1);
    }
  });

  it("EBU Tech 3341: синус 1 кГц −23 dBFS в обох каналах → −23.0 ±0.3 LUFS", () => {
    const l = measureLoudness(sine(1000, -23, 20, { channels: "both" }));
    expect(Math.abs(l.integratedLufs + 23)).toBeLessThanOrEqual(0.3);
  });

  it("тиша не входить у гейт: тон + тиша = тон; сама тиша — −Infinity", () => {
    // Блоки на межах тону частково тихіші, але над гейтом: тон довгий, щоб їхня частка була малою.
    const tone = sine(997, -20, 20, { channels: "both" });
    const silence = createStereo(5 * 48_000, 48_000);
    const alone = measureLoudness(tone).integratedLufs;
    expect(Math.abs(measureLoudness(concat(tone, silence)).integratedLufs - alone)).toBeLessThan(0.1);
    expect(Math.abs(measureLoudness(concat(silence, tone, silence)).integratedLufs - alone)).toBeLessThan(
      0.1,
    );
    expect(measureLoudness(silence).integratedLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(measureLoudness(createStereo(1000, 48_000)).momentaryMaxLufs).toBe(Number.NEGATIVE_INFINITY);
  });

  it("відносний гейт −10 LU: ділянка на 30 дБ тихіша не тягне гучність униз", () => {
    const loud = sine(997, -20, 5, { channels: "both" });
    const quiet = sine(997, -50, 5, { channels: "both" });
    const alone = measureLoudness(loud).integratedLufs;
    expect(Math.abs(measureLoudness(concat(loud, quiet)).integratedLufs - alone)).toBeLessThan(0.2);
  });
});

describe("truePeakDb", () => {
  it("міжсемпловий пік вищий за семпловий: синус fs/4 з фазою 45° (семпли на ±0.707)", () => {
    const pcm = sine(12_000, 0, 1, { channels: "both", phase: Math.PI / 4 });
    const sample = gainToDb(peakOf(pcm));
    const tp = truePeakDb(pcm);
    expect(sample).toBeCloseTo(-3.01, 1);
    expect(tp).toBeGreaterThan(sample + 2);
    expect(Math.abs(tp)).toBeLessThan(0.5);
  });

  it("низький тон: true peak ≈ семпловий пік; тиша — дуже низько", () => {
    const pcm = sine(100, -6, 1, { channels: "both" });
    expect(Math.abs(truePeakDb(pcm) - gainToDb(peakOf(pcm)))).toBeLessThan(0.05);
    expect(truePeakDb(createStereo(4800, 48_000))).toBeLessThan(-200);
  });
});
