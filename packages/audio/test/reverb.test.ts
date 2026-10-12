import { describe, expect, it } from "vitest";
import { createStereo, gainToDb, SAMPLE_RATE, secToSamples } from "../src/pcm.ts";
import {
  applyReverb,
  convolveStereo,
  fft,
  REVERB_DECAY_SEC,
  REVERB_PREDELAY_SEC,
  REVERB_SEND,
  reverbImpulse,
  sharedImpulse,
} from "../src/reverb.ts";
import { mulberry32 } from "./signals.ts";

const energy = (x: Float64Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += (x[i] as number) ** 2;
  return s;
};

/** Пряма згортка (еталон для FFT), обрізана до довжини `x`. */
function directConvolve(x: Float64Array, h: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] as number;
    if (xi === 0) continue;
    for (let k = 0; k < h.length && i + k < x.length; k++)
      out[i + k] = (out[i + k] as number) + xi * (h[k] as number);
  }
  return out;
}

const noise = (n: number, seed: number) => {
  const rand = mulberry32(seed);
  return Float64Array.from({ length: n }, () => rand() * 2 - 1);
};

describe("IR спільного реверба", () => {
  const ir = reverbImpulse();

  it("параметри ТЗ: 1.2 с спаду, предзатримка 10 мс, посил 0.25 / 0.08", () => {
    expect(REVERB_DECAY_SEC).toBe(1.2);
    expect(REVERB_PREDELAY_SEC).toBe(0.01);
    expect(REVERB_SEND).toEqual({ events: 0.25, music: 0.08 });
    const predelay = secToSamples(0.01);
    expect(ir.sampleRate).toBe(SAMPLE_RATE);
    expect(ir.left.length).toBe(predelay + secToSamples(1.2));
    expect(ir.right.length).toBe(ir.left.length);
    for (const ch of [ir.left, ir.right]) {
      expect(energy(ch, 0, predelay)).toBe(0);
      expect(Math.abs(ch[predelay] as number)).toBeGreaterThan(0);
    }
  });

  it("детермінований: той самий IR побайтно; канали декорельовані; енергія кожного — 1", () => {
    const again = reverbImpulse();
    expect(Buffer.from(again.left.buffer).equals(Buffer.from(ir.left.buffer))).toBe(true);
    expect(Buffer.from(again.right.buffer).equals(Buffer.from(ir.right.buffer))).toBe(true);
    expect(energy(ir.left)).toBeCloseTo(1, 9);
    expect(energy(ir.right)).toBeCloseTo(1, 9);
    let dot = 0;
    for (let i = 0; i < ir.left.length; i++) dot += (ir.left[i] as number) * (ir.right[i] as number);
    expect(Math.abs(dot)).toBeLessThan(0.1);
  });

  it("експоненційний спад: −60 дБ за 1.2 с (енергія по 100 мс)", () => {
    const predelay = secToSamples(0.01);
    const w = secToSamples(0.1);
    const db = (t: number) =>
      10 * Math.log10(energy(ir.left, predelay + secToSamples(t), predelay + secToSamples(t) + w));
    // Між вікнами на відстані 0.6 с — спад ≈ 30 дБ (шум дає розкид ±3 дБ).
    expect(db(0) - db(0.6)).toBeGreaterThan(27);
    expect(db(0) - db(0.6)).toBeLessThan(33);
    expect(db(0) - db(1.1)).toBeGreaterThan(50);
  });
});

describe("FFT-згортка", () => {
  it("FFT → IFFT повертає сигнал; степінь двійки обов'язкова", () => {
    const re = noise(1024, 1);
    const im = new Float64Array(1024);
    const copy = Float64Array.from(re);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < 1024; i++) expect(re[i]).toBeCloseTo(copy[i] as number, 10);
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow();
  });

  it("збігається з прямою згорткою (кілька блоків overlap-add, стерео з одного моно-входу)", () => {
    const ir = { sampleRate: SAMPLE_RATE, left: noise(300, 2), right: noise(300, 3) };
    const x = noise(5000, 4);
    // Тихий блок посередині — пропускається, але хвіст попереднього в нього доходить.
    x.fill(0, 1500, 3000);
    const got = convolveStereo(x, ir);
    const left = directConvolve(x, ir.left);
    const right = directConvolve(x, ir.right);
    expect(got.left.length).toBe(x.length);
    let err = 0;
    for (let i = 0; i < x.length; i++) {
      err = Math.max(err, Math.abs((got.left[i] as number) - (left[i] as number)));
      err = Math.max(err, Math.abs((got.right[i] as number) - (right[i] as number)));
    }
    expect(err).toBeLessThan(1e-9);
  });

  it("імпульс на вході → IR на виході (зсунутий), довжина входу; тиша → тиша", () => {
    const ir = sharedImpulse();
    expect(sharedImpulse()).toBe(ir);
    const send = createStereo(secToSamples(2));
    const at = secToSamples(0.5);
    send.left[at] = 1;
    send.right[at] = 1;
    const out = applyReverb(send);
    expect(out.left.length).toBe(send.left.length);
    for (const k of [0, 441, 500, 10_000, 40_000]) {
      expect(out.left[at + k]).toBeCloseTo(ir.left[k] as number, 6);
      expect(out.right[at + k]).toBeCloseTo(ir.right[k] as number, 6);
    }
    const silent = applyReverb(createStereo(secToSamples(1)));
    expect(silent.left.every((v) => v === 0) && silent.right.every((v) => v === 0)).toBe(true);
  });

  it("результат побайтно детермінований; стаціонарний шум зберігає RMS (енергія IR = 1)", () => {
    const n = secToSamples(3);
    const send = createStereo(n);
    const src = noise(n, 5);
    for (let i = 0; i < n; i++) {
      send.left[i] = (src[i] as number) * 0.1;
      send.right[i] = (src[i] as number) * 0.1;
    }
    const a = applyReverb(send);
    const b = applyReverb(send);
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
    expect(Buffer.from(a.right.buffer).equals(Buffer.from(b.right.buffer))).toBe(true);
    // Після заповнення хвоста (1.5 с) RMS виходу ≈ RMS входу.
    const from = secToSamples(1.5);
    let inE = 0;
    let outE = 0;
    for (let i = from; i < n; i++) {
      inE += (send.left[i] as number) ** 2;
      outE += (a.left[i] as number) ** 2;
    }
    expect(Math.abs(gainToDb(Math.sqrt(outE / inE)))).toBeLessThan(1);
  });
});
