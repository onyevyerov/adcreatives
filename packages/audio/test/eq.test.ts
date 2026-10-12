import { describe, expect, it } from "vitest";
import { Biquad } from "../src/dsp.ts";
import { EVENT_BUS_EQ, eqChannel, eqStereo } from "../src/eq.ts";
import { createStereo, gainToDb, rmsOf, SAMPLE_RATE, secToSamples } from "../src/pcm.ts";

/** Синус `hz` довжиною 1 с (обидва канали). */
function sine(hz: number) {
  const pcm = createStereo(SAMPLE_RATE);
  for (let i = 0; i < pcm.left.length; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
    pcm.left[i] = v;
    pcm.right[i] = v;
  }
  return pcm;
}

/** Підсилення шини на частоті `hz`, дБ (після перехідного процесу 0.2 с). */
function responseDb(hz: number): number {
  const input = sine(hz);
  const out = eqStereo(input);
  const from = secToSamples(0.2);
  return gainToDb(rmsOf(out, from) / rmsOf(input, from));
}

describe("EQ шини подій", () => {
  it("HPF 80 Гц і LPF 9 кГц", () => {
    expect(EVENT_BUS_EQ).toEqual({ highpassHz: 80, lowpassHz: 9000 });
  });

  it("середина без змін, низ і верх зрізані; на зрізах — ≈ −3 дБ", () => {
    for (const hz of [300, 1000, 3000]) expect(Math.abs(responseDb(hz)), `${hz} Гц`).toBeLessThan(0.5);
    expect(responseDb(80)).toBeCloseTo(-3, 0);
    expect(responseDb(9000)).toBeCloseTo(-3, 0);
    expect(responseDb(30)).toBeLessThan(-15);
    expect(responseDb(18_000)).toBeLessThan(-12);
  });

  it("вхід не змінюється; канали обробляються незалежно; та сама довжина", () => {
    const input = sine(40);
    input.right.fill(0);
    const before = Float32Array.from(input.left);
    const out = eqStereo(input);
    expect(Buffer.from(input.left.buffer).equals(Buffer.from(before.buffer))).toBe(true);
    expect(out.left.length).toBe(input.left.length);
    expect(out.right.every((v) => v === 0)).toBe(true);
    expect(Buffer.from(eqChannel(input.left, SAMPLE_RATE).buffer).equals(Buffer.from(out.left.buffer))).toBe(
      true,
    );
  });

  it("Biquad.setHighpass: DC → 0, Найквіст — без змін", () => {
    const hp = new Biquad().setHighpass(100, SAMPLE_RATE);
    let y = 0;
    for (let i = 0; i < SAMPLE_RATE; i++) y = hp.process(1);
    expect(Math.abs(y)).toBeLessThan(1e-6);
    const hp2 = new Biquad().setHighpass(100, SAMPLE_RATE);
    for (let i = 0; i < 1000; i++) y = hp2.process(i % 2 === 0 ? 1 : -1);
    expect(Math.abs(y)).toBeCloseTo(1, 3);
  });
});
