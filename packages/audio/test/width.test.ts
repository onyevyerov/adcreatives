import { describe, expect, it } from "vitest";
import { Biquad } from "../src/dsp.ts";
import { createStereo, gainToDb, SAMPLE_RATE, type StereoPcm, secToSamples } from "../src/pcm.ts";
import { correlation } from "../src/stereo.ts";
import { WIDTH_HPF_HZ, WIDTH_MIN_CORRELATION, WIDTH_SIDE_DB, widenMusic } from "../src/width.ts";
import { mulberry32 } from "./signals.ts";

/** Трек з mid і side: `L = M + S`, `R = M − S`; бас 60 Гц у mid, шум у mid і side, бас 80 Гц у side. */
function track(opts: { midNoise: number; sideNoise: number; sideBass: number }, sec = 3): StereoPcm {
  const n = secToSamples(sec);
  const pcm = createStereo(n);
  const randM = mulberry32(11);
  const randS = mulberry32(12);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const m = 0.3 * Math.sin(2 * Math.PI * 60 * t) + opts.midNoise * (randM() * 2 - 1);
    const s = opts.sideBass * Math.sin(2 * Math.PI * 80 * t) + opts.sideNoise * (randS() * 2 - 1);
    pcm.left[i] = m + s;
    pcm.right[i] = m - s;
  }
  return pcm;
}

const same = (a: StereoPcm, b: StereoPcm) =>
  Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer)) &&
  Buffer.from(a.right.buffer).equals(Buffer.from(b.right.buffer));

/** Енергія side вище `hz` (каскад з 4 HPF-біквадів). */
function sideEnergyAbove(pcm: StereoPcm, hz: number): number {
  const s = Float64Array.from(pcm.left, (l, i) => (l - (pcm.right[i] as number)) / 2);
  for (let k = 0; k < 4; k++) {
    const f = new Biquad().setHighpass(hz, pcm.sampleRate);
    for (let i = 0; i < s.length; i++) s[i] = f.process(s[i] as number);
  }
  let e = 0;
  for (const v of s) e += v * v;
  return e;
}

describe("widenMusic: ширина стерео музики", () => {
  it("параметри ТЗ: side +4 дБ вище 300 Гц, межа кореляції 0.6", () => {
    expect(WIDTH_SIDE_DB).toBe(4);
    expect(WIDTH_HPF_HZ).toBe(300);
    expect(WIDTH_MIN_CORRELATION).toBe(0.6);
  });

  it("моно-трек лишається моно побайтно (ширини нема звідки взяти); вхід не змінюється", () => {
    const mono = track({ midNoise: 0.1, sideNoise: 0, sideBass: 0 });
    const before = createStereo(mono.left.length);
    before.left.set(mono.left);
    before.right.set(mono.right);
    const out = widenMusic(mono);
    expect(out).not.toBe(mono);
    expect(same(out, mono)).toBe(true);
    expect(same(mono, before)).toBe(true);
    expect(correlation(out)).toBe(1);
  });

  it("трек із side-компонентом ширшає на +4 дБ вгорі, низ стає моно, моно-сума та сама", () => {
    const pcm = track({ midNoise: 0.1, sideNoise: 0.08, sideBass: 0.05 });
    const out = widenMusic(pcm);
    expect(correlation(out)).toBeLessThan(correlation(pcm));
    expect(correlation(out)).toBeGreaterThanOrEqual(WIDTH_MIN_CORRELATION);
    // Side вище 1 кГц — рівно +4 дБ (там LPF 300 Гц уже нічого не лишає).
    expect(gainToDb(Math.sqrt(sideEnergyAbove(out, 1000) / sideEnergyAbove(pcm, 1000)))).toBeCloseTo(4, 1);
    // Side-бас 80 Гц прибрано: низ моно.
    expect(correlation(pcm, 150)).toBeLessThan(0.98);
    expect(correlation(out, 150)).toBeGreaterThanOrEqual(0.98);
    // M не змінюється: L + R як у входу (з точністю до Float32).
    let err = 0;
    for (let i = 0; i < pcm.left.length; i++) {
      const a = (pcm.left[i] as number) + (pcm.right[i] as number);
      const b = (out.left[i] as number) + (out.right[i] as number);
      err = Math.max(err, Math.abs(a - b));
    }
    expect(err).toBeLessThan(1e-6);
  });

  it("+4 дБ опустили б кореляцію нижче 0.6 → side підсилюється менше, кореляція ≈ 0.6", () => {
    // Кореляція входу ≈ 0.7: з повними +4 дБ вийшло б ≈ 0.4.
    const pcm = track({ midNoise: 0.2, sideNoise: 0.18, sideBass: 0 });
    const before = correlation(pcm);
    expect(before).toBeGreaterThan(0.6);
    expect(before).toBeLessThan(0.8);
    const out = widenMusic(pcm);
    const after = correlation(out);
    expect(after).toBeGreaterThanOrEqual(WIDTH_MIN_CORRELATION);
    expect(after).toBeLessThan(0.62);
    expect(sideEnergyAbove(out, 1000)).toBeGreaterThan(sideEnergyAbove(pcm, 1000));
  });

  it("уже широкий трек (кореляція < 0.6) — без змін; результат детермінований побайтно", () => {
    const wide = track({ midNoise: 0.05, sideNoise: 0.2, sideBass: 0 });
    expect(correlation(wide)).toBeLessThan(WIDTH_MIN_CORRELATION);
    expect(same(widenMusic(wide), wide)).toBe(true);
    const pcm = track({ midNoise: 0.1, sideNoise: 0.08, sideBass: 0.05 });
    expect(same(widenMusic(pcm), widenMusic(pcm))).toBe(true);
    expect(widenMusic(createStereo(0)).left.length).toBe(0);
  });
});
