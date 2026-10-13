import { describe, expect, it } from "vitest";
import { createStereo, rmsOf, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";
import { correlation, monoFold } from "../src/stereo.ts";
import { mulberry32 } from "./signals.ts";

const SR = SAMPLE_RATE;
const tone = (hz: number, i: number) => Math.sin((2 * Math.PI * hz * i) / SR);

/** L = M + S, R = M − S (M і S — функції індексу семпла). */
function midSide(sec: number, mid: (i: number) => number, side: (i: number) => number): StereoPcm {
  const pcm = createStereo(Math.round(sec * SR), SR);
  for (let i = 0; i < pcm.left.length; i++) {
    pcm.left[i] = mid(i) + side(i);
    pcm.right[i] = mid(i) - side(i);
  }
  return pcm;
}

describe("correlation", () => {
  it("ідентичні канали — 1, протифазні — −1, незалежний шум — ≈ 0, тиша — 1", () => {
    const rnd = mulberry32(7);
    const same = midSide(
      1,
      (i) => 0.5 * tone(440, i),
      () => 0,
    );
    const inverted = midSide(
      1,
      () => 0,
      (i) => 0.5 * tone(440, i),
    );
    const noise = createStereo(SR, SR);
    for (let i = 0; i < SR; i++) {
      noise.left[i] = rnd() - 0.5;
      noise.right[i] = rnd() - 0.5;
    }
    expect(correlation(same)).toBeCloseTo(1, 6);
    expect(correlation(inverted)).toBeCloseTo(-1, 6);
    expect(Math.abs(correlation(noise))).toBeLessThan(0.05);
    expect(correlation(createStereo(100, SR))).toBe(1);
  });

  it("belowHz: низ моно, верх у протифазі → уся ≈ 0, низ ≈ 1", () => {
    const pcm = midSide(
      1,
      (i) => 0.5 * tone(50, i),
      (i) => 0.5 * tone(5000, i),
    );
    expect(Math.abs(correlation(pcm))).toBeLessThan(0.05);
    expect(correlation(pcm, 150)).toBeGreaterThan(0.95);
  });
});

describe("monoFold", () => {
  it("belowHz: null — (L+R)/2 в обидва канали; вхід не змінюється", () => {
    const pcm = midSide(
      0.5,
      (i) => 0.3 * tone(220, i),
      (i) => 0.2 * tone(3000, i),
    );
    const before = Float32Array.from(pcm.left);
    const out = monoFold(pcm, { belowHz: null });
    for (let i = 0; i < pcm.left.length; i++) {
      expect(out.left[i]).toBeCloseTo(((pcm.left[i] as number) + (pcm.right[i] as number)) / 2, 6);
      expect(out.right[i]).toBe(out.left[i]);
    }
    expect(pcm.left).toEqual(before);
  });

  it("belowHz: 150 — низ стає моно, верх лишається без змін, моно-сума та сама", () => {
    const sideLow = (i: number) => 0.3 * tone(50, i);
    const sideHigh = (i: number) => 0.3 * tone(5000, i);
    const pcm = midSide(
      2,
      (i) => 0.3 * tone(80, i),
      (i) => sideLow(i) + sideHigh(i),
    );
    expect(correlation(pcm, 150)).toBeLessThan(0.5);
    const out = monoFold(pcm, { belowHz: 150 });
    expect(correlation(out, 150)).toBeGreaterThanOrEqual(0.98);
    // Поза краями (перехідні процеси фільтра) side виходу = верхній side входу.
    const err = createStereo(out.left.length, SR);
    const ref = createStereo(out.left.length, SR);
    for (let i = 0; i < out.left.length; i++) {
      const s = ((out.left[i] as number) - (out.right[i] as number)) / 2;
      err.left[i] = s - sideHigh(i);
      ref.left[i] = sideHigh(i);
      // Моно-сума L+R не змінюється ніде.
      expect((out.left[i] as number) + (out.right[i] as number)).toBeCloseTo(
        (pcm.left[i] as number) + (pcm.right[i] as number),
        5,
      );
    }
    const edge = Math.round(0.2 * SR);
    const n = out.left.length;
    expect(rmsOf(err, edge, n - edge)).toBeLessThan(0.02 * rmsOf(ref, edge, n - edge));
  });
});
