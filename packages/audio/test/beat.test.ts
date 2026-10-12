import { describe, expect, it } from "vitest";
import { alignToBeatGrid, beatShiftSamples, lowBandOnsets } from "../src/beat.ts";
import { SAMPLE_RATE } from "../src/pcm.ts";
import { kickTimes, metronome, steadyBed } from "./signals.ts";

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
  });
});
