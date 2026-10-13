import { describe, expect, it } from "vitest";
import { measureLoudness, truePeakDb } from "../src/loudness.ts";
import {
  LIMITER_ATTACK_SEC,
  LIMITER_LOOKAHEAD_SEC,
  LIMITER_RELEASE_SEC,
  MASTER_CEILING_DBFS,
  MASTER_LOUDNESS_PASSES,
  MASTER_MAX_GAIN_DB,
  MASTER_TARGET_LUFS,
  MASTER_TRUE_PEAK_DBTP,
  masterize,
} from "../src/master.ts";
import {
  createStereo,
  dbToGain,
  gainToDb,
  peakOf,
  SAMPLE_RATE,
  type StereoPcm,
  secToSamples,
} from "../src/pcm.ts";
import { decodeWav, encodeWav } from "../src/wav.ts";
import { steadyBed } from "./signals.ts";

const SR = SAMPLE_RATE;
const master = (pcm: StereoPcm) => masterize(pcm, { sampleRate: pcm.sampleRate });

/** Копія PCM з підсиленням `gain`. */
function scaled(pcm: StereoPcm, gain: number): StereoPcm {
  const out = createStereo(pcm.left.length, pcm.sampleRate);
  for (let i = 0; i < pcm.left.length; i++) {
    out.left[i] = (pcm.left[i] as number) * gain;
    out.right[i] = (pcm.right[i] as number) * gain;
  }
  return out;
}

/** Синус `hz` з піком `peak` в обох каналах. */
function sine(durationSec: number, hz: number, peak: number): StereoPcm {
  const pcm = createStereo(secToSamples(durationSec, SR), SR);
  for (let i = 0; i < pcm.left.length; i++) {
    const v = peak * Math.sin((2 * Math.PI * hz * i) / SR);
    pcm.left[i] = v;
    pcm.right[i] = v;
  }
  return pcm;
}

/** Підсилення, з яким `x` уже має −14 LUFS. */
const toTarget = (pcm: StereoPcm) => dbToGain(MASTER_TARGET_LUFS - measureLoudness(pcm).integratedLufs);

/**
 * «Трек із піками до −0.5 dBFS»: рівна підкладка плюс кожні 0.5 с короткий удар — клік в один
 * семпл або спалах 11 кГц (міжсемпловий пік вищий за семпловий), пік −0.5 dBFS; підкладка
 * підібрана так, що весь трек — на −14 LUFS (мастер майже не підсилює, піки йдуть у лімітер).
 */
function peakyTrack(durationSec: number): StereoPcm {
  const bed = steadyBed(durationSec, SR);
  let gain = toTarget(bed);
  let pcm = withPeaks(scaled(bed, gain), durationSec);
  for (let k = 0; k < 3; k++) {
    gain *= toTarget(pcm);
    pcm = withPeaks(scaled(bed, gain), durationSec);
  }
  return pcm;
}

function withPeaks(pcm: StereoPcm, durationSec: number): StereoPcm {
  const peak = dbToGain(-0.5);
  for (let k = 1; k < durationSec * 2 - 1; k++) {
    const at = secToSamples(k * 0.5, SR);
    if (k % 2 === 0) {
      pcm.left[at] = peak;
      pcm.right[at] = -peak;
    } else {
      for (let i = 0; i < secToSamples(0.005, SR); i++) {
        const v = peak * Math.sin((2 * Math.PI * 11_025 * (i + 0.5)) / SR);
        pcm.left[at + i] = v;
        pcm.right[at + i] = v;
      }
    }
  }
  return pcm;
}

describe("masterize: гучність", () => {
  it("константи мастера: −14 LUFS, −1 dBTP, ±12 дБ, лімітер 1.5 / 0.5 / 50 мс", () => {
    expect(MASTER_TARGET_LUFS).toBe(-14);
    expect(MASTER_TRUE_PEAK_DBTP).toBe(-1);
    expect(MASTER_CEILING_DBFS).toBe(-1);
    expect(MASTER_MAX_GAIN_DB).toBe(12);
    expect(LIMITER_LOOKAHEAD_SEC).toBe(0.0015);
    expect(LIMITER_ATTACK_SEC).toBe(0.0005);
    expect(LIMITER_RELEASE_SEC).toBe(0.05);
  });

  it("сума будь-якого рівня → −14 LUFS; підсилення = ціль мінус виміряна гучність", () => {
    const bed = steadyBed(8, SR);
    const bedLufs = measureLoudness(bed).integratedLufs;
    for (const db of [-10, -4, 0, 3]) {
      const input = scaled(bed, dbToGain(db));
      const out = master(input);
      expect(out.gainDb, `${db} дБ`).toBeCloseTo(MASTER_TARGET_LUFS - (bedLufs + db), 1);
      expect(Math.abs(out.integratedLufs - MASTER_TARGET_LUFS), `${db} дБ`).toBeLessThan(0.3);
      expect(measureLoudness(out.pcm).integratedLufs).toBe(out.integratedLufs);
      expect(out.truePeakDbtp, `${db} дБ`).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    }
  });

  it("підсилення в межах ±12 дБ: дуже тиха сума не тягнеться до цілі, дуже гучна — теж", () => {
    const bed = steadyBed(8, SR);
    const quiet = scaled(bed, dbToGain(-40));
    const q = master(quiet);
    expect(q.gainDb).toBe(MASTER_MAX_GAIN_DB);
    expect(q.integratedLufs).toBeCloseTo(measureLoudness(quiet).integratedLufs + MASTER_MAX_GAIN_DB, 1);
    const loud = master(scaled(bed, dbToGain(30)));
    expect(loud.gainDb).toBe(-MASTER_MAX_GAIN_DB);
    expect(loud.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
  });

  it("лімітер зняв гучність на піках (часті удари над стелею) → підсилення добирається до цілі", () => {
    // Підкладка + кожні 300 мс удар 3 кГц на 1 мс (+6 dBFS): після підсилення до цілі — над стелею.
    const bed = steadyBed(8, SR);
    const input = scaled(bed, toTarget(bed));
    const burst = secToSamples(0.001, SR);
    for (let at = 0; at + burst < input.left.length; at += secToSamples(0.3, SR)) {
      for (let i = 0; i < burst; i++) {
        const v = 2 * Math.sin((2 * Math.PI * 3000 * (i + 0.5)) / SR);
        input.left[at + i] = (input.left[at + i] as number) + v;
        input.right[at + i] = (input.right[at + i] as number) + v;
      }
    }
    const firstGainDb = MASTER_TARGET_LUFS - measureLoudness(input).integratedLufs;
    expect(gainToDb(peakOf(input)) + firstGainDb).toBeGreaterThan(MASTER_CEILING_DBFS + 2);
    const out = master(input);
    expect(MASTER_LOUDNESS_PASSES).toBe(3);
    // Без добирання лімітер зняв би гучність; з ним — підсилення більше за перше і ціль ±0.5.
    expect(out.gainDb).toBeGreaterThan(firstGainDb + 0.3);
    expect(Math.abs(out.integratedLufs - MASTER_TARGET_LUFS)).toBeLessThan(0.5);
    expect(out.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
  });

  it("тиша → підсилення 0, тиша на виході; коротша за блок 400 мс — теж без NaN і під стелею", () => {
    const silent = master(createStereo(SR, SR));
    expect(silent.gainDb).toBe(0);
    expect(silent.integratedLufs).toBe(-Infinity);
    expect(peakOf(silent.pcm)).toBe(0);
    const short = master(sine(0.2, 1000, 1.5));
    expect(short.gainDb).toBe(0);
    expect(gainToDb(peakOf(short.pcm))).toBeLessThanOrEqual(MASTER_CEILING_DBFS);
    expect(short.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    expect(short.pcm.left.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("masterize: true-peak лімітер", () => {
  it("трек із піками до −0.5 dBFS: жодного семпла вище −1 dBFS, true peak ≤ −1 dBTP, і в WAV теж", () => {
    const input = peakyTrack(6);
    expect(gainToDb(peakOf(input))).toBeCloseTo(-0.5, 1);
    expect(truePeakDb(input)).toBeGreaterThan(-0.5);
    const out = master(input);
    // Трек уже на цілі — підсилення майже 0, тож піки доходять до лімітера вище −1 dBFS.
    expect(Math.abs(out.gainDb)).toBeLessThan(0.5);
    expect(gainToDb(peakOf(input)) + out.gainDb).toBeGreaterThan(-0.6);
    expect(gainToDb(peakOf(out.pcm))).toBeLessThanOrEqual(-1);
    expect(out.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
    expect(truePeakDb(out.pcm)).toBe(out.truePeakDbtp);
    expect(gainToDb(peakOf(decodeWav(encodeWav(out.pcm))))).toBeLessThanOrEqual(-1);
    // Лімітер працює точково: гучність лишається на цілі.
    expect(Math.abs(out.integratedLufs - MASTER_TARGET_LUFS)).toBeLessThan(0.5);
  });

  it("часові параметри: до піку — не раніше lookahead + атака, після — реліз ~50 мс, далі сухий сигнал", () => {
    // Синус 1 кГц на цілі + один клік +6 дБ над стелею на 1 с.
    const bed = sine(3, 1000, 0.3);
    const input = scaled(bed, toTarget(bed));
    const at = secToSamples(1, SR);
    input.left[at] = 1.6;
    input.right[at] = 1.6;
    const out = master(input);
    const makeup = dbToGain(out.gainDb);
    /** Гейн лімітера в семплі `i` (відносно суми з підсиленням). */
    const gainAt = (i: number) => (out.pcm.left[i] as number) / ((input.left[i] as number) * makeup);
    const loudSamples = (from: number, to: number) => {
      const xs: number[] = [];
      for (let i = from; i < to; i++) if (Math.abs(input.left[i] as number) > 0.1) xs.push(gainAt(i));
      return xs;
    };
    const ms = (x: number) => secToSamples(x / 1000, SR);
    // Раніше ніж lookahead + 6 семплів (півядра інтерполятора) до кліку — гейн 1.
    for (const g of loudSamples(at - ms(50), at - ms(1.5) - 8)) expect(g).toBeCloseTo(1, 6);
    // На кліку — до стелі.
    expect(Math.abs(out.pcm.left[at] as number)).toBeLessThanOrEqual(dbToGain(MASTER_CEILING_DBFS));
    // Через 20 мс ще відпускає (реліз не миттєвий), через 400 мс — сухий.
    expect(Math.min(...loudSamples(at + ms(19), at + ms(21)))).toBeLessThan(0.95);
    for (const g of loudSamples(at + ms(400), at + ms(450))) expect(g).toBeCloseTo(1, 3);
  });

  it("детермінований побайтово, вхід не змінює; антиклік 10 мс у кінці", () => {
    const input = peakyTrack(4);
    const before = encodeWav(input);
    const a = master(input);
    const b = master(input);
    expect(encodeWav(a.pcm).equals(encodeWav(b.pcm))).toBe(true);
    expect(a).toEqual(b);
    expect(encodeWav(input).equals(before)).toBe(true);
    const n = a.pcm.left.length;
    expect(Math.abs(a.pcm.left[n - 1] as number)).toBe(0);
    expect(Math.abs(a.pcm.right[n - 1] as number)).toBe(0);
    expect(peakOf(a.pcm, n - secToSamples(0.002, SR), n)).toBeLessThan(peakOf(a.pcm, 0, n) * 0.25);
  });

  it("30 с стерео — швидко (лімітер лінійний за довжиною)", () => {
    const input = peakyTrack(30);
    const t0 = performance.now();
    const out = master(input);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(out.truePeakDbtp).toBeLessThanOrEqual(MASTER_TRUE_PEAK_DBTP);
  });
});
