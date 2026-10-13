import { describe, expect, it } from "vitest";
import { BEATS_PER_BAR, MIN_BAR_CONFIDENCE } from "../src/bars.ts";
import { alignToBeatGrid, beatShiftSamples, lowBandOnsets } from "../src/beat.ts";
import { SAMPLE_RATE } from "../src/pcm.ts";
import { kickTimes, metronome, steadyBed } from "./signals.ts";
import { barGroove, firstDownbeatSec } from "./trackSignals.ts";

const FRAME_SEC = 1 / 30;

/** Відстань від часу до найближчої долі сітки (k · period), с. */
const gridError = (t: number, period: number) => {
  const r = ((t % period) + period) % period;
  return Math.min(r, period - r);
};

describe("beat alignment", () => {
  it.each([
    { bpm: 120, offsetSec: 0.07, busy: false },
    { bpm: 120, offsetSec: 0.07, busy: true },
    { bpm: 90, offsetSec: 0.07, busy: true },
    { bpm: 100, offsetSec: 0.07, busy: true },
    { bpm: 150, offsetSec: 0.07, busy: true },
    { bpm: 60, offsetSec: 0.07, busy: true },
  ])("метроном $bpm BPM зі зсувом 70 мс (busy=$busy) → онсети на сітці ±1 кадр", (c) => {
    const opts = { ...c, durationSec: 12, pad: true };
    const { pcm, alignment } = alignToBeatGrid(metronome(opts), c.bpm);
    const period = 60 / c.bpm;
    expect(alignment.confidence).toBeGreaterThan(0.5);
    // Справжні бочки після зсуву (з відомої істини, а не з детектора).
    const shiftSec = alignment.shiftSamples / SAMPLE_RATE;
    for (const t of kickTimes(opts)) {
      const after = t - shiftSec;
      if (after < 0) continue;
      expect(gridError(after, period)).toBeLessThanOrEqual(FRAME_SEC);
    }
    // І те, що чує детектор у вирівняному треку, — теж на сітці.
    const onsets = lowBandOnsets(pcm);
    expect(onsets.length).toBeGreaterThanOrEqual(Math.floor(12 / period) - 2);
    for (const o of onsets) expect(gridError(o.timeSec, period)).toBeLessThanOrEqual(FRAME_SEC);
  });

  it("метроном, що відстає на півдолі, теж стає на сітку", () => {
    const opts = { bpm: 120, offsetSec: 0.31, durationSec: 10, busy: true };
    const { alignment } = alignToBeatGrid(metronome(opts), 120);
    const shiftSec = alignment.shiftSamples / SAMPLE_RATE;
    for (const t of kickTimes(opts)) expect(gridError(t - shiftSec, 0.5)).toBeLessThanOrEqual(FRAME_SEC);
  });

  it("зсув: обрізаємо початок, а коротку тишу додаємо, лише коли до долі ≤ 150 мс", () => {
    expect(beatShiftSamples(0.07, 0.5, SAMPLE_RATE)).toBe(Math.round(0.07 * SAMPLE_RATE));
    expect(beatShiftSamples(0.45, 0.5, SAMPLE_RATE)).toBe(-Math.round(0.05 * SAMPLE_RATE));
    expect(beatShiftSamples(0.3, 0.5, SAMPLE_RATE)).toBe(Math.round(0.3 * SAMPLE_RATE));
  });

  it("трек без долі не зсувається", () => {
    const bed = steadyBed(6);
    const { pcm, alignment } = alignToBeatGrid(bed, 120);
    expect(alignment.shiftSamples).toBe(0);
    expect(pcm).toBe(bed);
    expect(alignment.barOffsetSec).toBeNull();
    expect(alignment.barConfidence).toBeNull();
  });
});

describe("вирівнювання такту (A6)", () => {
  /** Справжні downbeat «треку такту» (з відомої істини). */
  const downbeats = (o: Parameters<typeof barGroove>[0]) => {
    const bar = (BEATS_PER_BAR * 60) / o.bpm;
    const out: number[] = [];
    for (let t = firstDownbeatSec(o); t < o.durationSec; t += bar) out.push(t);
    return out;
  };

  it.each([
    { bpm: 120, leadBeats: 2 },
    { bpm: 120, leadBeats: 1 },
    { bpm: 90, leadBeats: 3 },
    { bpm: 150, leadBeats: 2 },
  ])("трек зі зсувом на $leadBeats долі ($bpm BPM) → на кадр 0 стає downbeat, обрізання ≤ 1 такт", (c) => {
    const opts = { ...c, offsetSec: 0.07, durationSec: 16, busy: true };
    const { alignment } = alignToBeatGrid(barGroove(opts), c.bpm);
    const bar = BEATS_PER_BAR * alignment.periodSec;
    expect(alignment.barConfidence).toBeGreaterThanOrEqual(MIN_BAR_CONFIDENCE);
    expect(Math.abs((alignment.barOffsetSec ?? 0) - firstDownbeatSec(opts))).toBeLessThanOrEqual(FRAME_SEC);
    const shiftSec = alignment.shiftSamples / SAMPLE_RATE;
    expect(shiftSec).toBeGreaterThan(0);
    expect(shiftSec).toBeLessThan(bar);
    // Перший downbeat — на кадрі 0, решта — на сітці тактів.
    const after = downbeats(opts).map((t) => t - shiftSec);
    expect(Math.abs(after[0] ?? 1)).toBeLessThanOrEqual(FRAME_SEC);
    for (const t of after) expect(gridError(t, bar)).toBeLessThanOrEqual(FRAME_SEC);
  });

  it("downbeat за ≤ 150 мс до кінця такту → тиша на початку, а не обрізання майже такту", () => {
    // Перший downbeat на 1.95 с, такт 2 с: додаємо ~50 мс тиші, downbeat стає на 2.0 с.
    const opts = { bpm: 120, offsetSec: 0.45, durationSec: 16, leadBeats: 3 };
    const { alignment } = alignToBeatGrid(barGroove(opts), 120);
    expect(alignment.barConfidence).toBeGreaterThanOrEqual(MIN_BAR_CONFIDENCE);
    expect(alignment.shiftSamples).toBeLessThan(0);
    expect(-alignment.shiftSamples / SAMPLE_RATE).toBeLessThanOrEqual(0.15);
    const shiftSec = alignment.shiftSamples / SAMPLE_RATE;
    for (const t of downbeats(opts)) expect(gridError(t - shiftSec, 2)).toBeLessThanOrEqual(FRAME_SEC);
  });

  it.each([90, 120, 150])("трек без акцентів (%d BPM) → лише фаза долі, як без A6", (bpm) => {
    const { alignment } = alignToBeatGrid(
      metronome({ bpm, offsetSec: 0.07, durationSec: 16, busy: true, pad: true }),
      bpm,
    );
    expect(alignment.barConfidence).toBeLessThan(MIN_BAR_CONFIDENCE);
    expect(alignment.shiftSamples).toBe(
      beatShiftSamples(alignment.offsetSec, alignment.periodSec, SAMPLE_RATE),
    );
  });
});
