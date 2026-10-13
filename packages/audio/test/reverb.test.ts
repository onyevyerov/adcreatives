import { describe, expect, it } from "vitest";
import { Biquad } from "../src/dsp.ts";
import { createStereo, gainToDb, SAMPLE_RATE, secToSamples } from "../src/pcm.ts";
import {
  applyReverb,
  convolveStereo,
  fft,
  REVERB_CROSSFEED,
  REVERB_CROSSOVER_HZ,
  REVERB_DAMPING_HZ,
  REVERB_DECAY_SEC,
  REVERB_HIGH_DECAY_SEC,
  REVERB_PREDELAY_SEC,
  REVERB_SEND,
  REVERB_SEND_HPF_HZ,
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

/** Смуга сигналу: каскад з 4 біквадів HPF `lo` і/або LPF `hi` (48 дБ/окт), нова копія. */
function band(x: ArrayLike<number>, lo: number | null, hi: number | null): Float64Array {
  const out = Float64Array.from(x);
  for (let s = 0; s < 4; s++) {
    for (const f of [
      lo === null ? null : new Biquad().setHighpass(lo, SAMPLE_RATE),
      hi === null ? null : new Biquad().setLowpass(hi, SAMPLE_RATE),
    ]) {
      if (f) for (let i = 0; i < out.length; i++) out[i] = f.process(out[i] as number);
    }
  }
  return out;
}

/** Частка енергії сигналу на частотах ≥ `hz` (FFT), дБ. */
function shareAboveDb(x: ArrayLike<number>, hz: number): number {
  let n = 2;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i] as number;
  fft(re, im);
  let total = 0;
  let above = 0;
  for (let k = 0; k <= n / 2; k++) {
    const e = (re[k] as number) ** 2 + (im[k] as number) ** 2;
    total += e;
    if ((k * SAMPLE_RATE) / n >= hz) above += e;
  }
  return 10 * Math.log10(above / total);
}

describe("IR спільного реверба", () => {
  const ir = reverbImpulse();

  it("параметри ТЗ: спад 1.2 с / 0.5 с вище 3 кГц, LPF 6 кГц, предзатримка 10 мс, посил 0.25 / 0.08", () => {
    expect(REVERB_DECAY_SEC).toBe(1.2);
    expect(REVERB_HIGH_DECAY_SEC).toBe(0.5);
    expect(REVERB_CROSSOVER_HZ).toBe(3000);
    expect(REVERB_DAMPING_HZ).toBe(6000);
    expect(REVERB_PREDELAY_SEC).toBe(0.01);
    expect(REVERB_SEND).toEqual({ events: 0.25, music: 0.08 });
    expect(REVERB_SEND_HPF_HZ).toBe(200);
    expect(REVERB_CROSSFEED).toBe(0.3);
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

  it("низ (≤ 1 кГц) спадає експоненційно: −60 дБ за 1.2 с (енергія по 100 мс)", () => {
    const predelay = secToSamples(0.01);
    const w = secToSamples(0.1);
    const low = band(ir.left, null, 1000);
    const db = (t: number) =>
      10 * Math.log10(energy(low, predelay + secToSamples(t), predelay + secToSamples(t) + w));
    // Між вікнами на відстані 0.6 с — спад ≈ 30 дБ (шум дає розкид ±3 дБ).
    expect(db(0.1) - db(0.7)).toBeGreaterThan(27);
    expect(db(0.1) - db(0.7)).toBeLessThan(33);
    expect(db(0) - db(1.1)).toBeGreaterThan(50);
  });

  it("демпфування верху: через 0.4 с смуга 4–5 кГц ≥ 8 дБ тихіша, ніж без нього; низ — як був", () => {
    // Те саме зерно шуму, але верх спадає так само повільно, як низ.
    const flat = reverbImpulse(SAMPLE_RATE, { highDecaySec: REVERB_DECAY_SEC });
    const at = secToSamples(0.01 + 0.4);
    const w = secToSamples(0.1);
    const db = (x: Float64Array) => 10 * Math.log10(energy(x, at, at + w));
    for (const ch of ["left", "right"] as const) {
      expect(db(band(ir[ch], 4000, 5000)) - db(band(flat[ch], 4000, 5000)), ch).toBeLessThan(-8);
      // Одинична енергія підтягує демпфований IR угору на ≈ 1 дБ.
      expect(Math.abs(db(band(ir[ch], null, 1000)) - db(band(flat[ch], null, 1000))), ch).toBeLessThan(2);
    }
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

  it("збігається з прямою згорткою (кілька блоків overlap-add; моно-вхід і стерео-пара входів)", () => {
    const ir = { sampleRate: SAMPLE_RATE, left: noise(300, 2), right: noise(300, 3) };
    const x = noise(5000, 4);
    const y = noise(5000, 6);
    // Тихий блок посередині — пропускається, але хвіст попереднього в нього доходить.
    x.fill(0, 1500, 3000);
    y.fill(0, 1500, 3000);
    // Правий вхід звучить і там, де лівий мовчить: блок не тихий.
    y[2000] = 0.5;
    const cases = [
      { got: convolveStereo(x, ir), left: directConvolve(x, ir.left), right: directConvolve(x, ir.right) },
      { got: convolveStereo(x, ir, y), left: directConvolve(x, ir.left), right: directConvolve(y, ir.right) },
    ];
    for (const c of cases) {
      expect(c.got.left.length).toBe(x.length);
      let err = 0;
      for (let i = 0; i < x.length; i++) {
        err = Math.max(err, Math.abs((c.got.left[i] as number) - (c.left[i] as number)));
        err = Math.max(err, Math.abs((c.got.right[i] as number) - (c.right[i] as number)));
      }
      expect(err).toBeLessThan(1e-9);
    }
  });

  it("моно-імпульс → IR після HPF 200 Гц посилу (зсунутий), довжина входу; тиша → тиша", () => {
    const ir = sharedImpulse();
    expect(sharedImpulse()).toBe(ir);
    const n = secToSamples(2);
    const send = createStereo(n);
    const at = secToSamples(0.5);
    send.left[at] = 1;
    send.right[at] = 1;
    const out = applyReverb(send);
    expect(out.left.length).toBe(n);
    // Перехресний посил нормований: (1 + 0.3) / 1.3 — моно-посил іде в IR без зміни рівня.
    const hp = new Biquad().setHighpass(REVERB_SEND_HPF_HZ, SAMPLE_RATE);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = hp.process(i === at ? 1 : 0);
    const want = convolveStereo(x, ir);
    for (const k of [0, 441, 500, 10_000, 40_000]) {
      expect(out.left[at + k]).toBeCloseTo(want.left[at + k] as number, 6);
      expect(out.right[at + k]).toBeCloseTo(want.right[at + k] as number, 6);
    }
    // До імпульсу — тиша (з точністю до похибки FFT).
    expect(out.left.slice(0, at).every((v) => Math.abs(v) < 1e-9)).toBe(true);
    const silent = applyReverb(createStereo(secToSamples(1)));
    expect(silent.left.every((v) => v === 0) && silent.right.every((v) => v === 0)).toBe(true);
  });

  it("стерео-посил: імпульс зліва → хвіст зліва гучніший ≥ 3 дБ; енергія вище 6 кГц ≤ −20 дБ", () => {
    const send = createStereo(secToSamples(2));
    send.left[secToSamples(0.2)] = 1;
    const out = applyReverb(send);
    const l = energy(Float64Array.from(out.left));
    const r = energy(Float64Array.from(out.right));
    expect(r).toBeGreaterThan(0);
    expect(10 * Math.log10(l / r)).toBeGreaterThanOrEqual(3);
    expect(shareAboveDb(out.left, 6000)).toBeLessThanOrEqual(-20);
    expect(shareAboveDb(out.right, 6000)).toBeLessThanOrEqual(-20);
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
    // Після заповнення хвоста (1.5 с) RMS виходу ≈ RMS входу (HPF 200 Гц знімає з білого шуму ≈ 1 %).
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
