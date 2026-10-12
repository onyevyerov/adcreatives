import { createStereo, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";

/** Синтетичні треки для тестів зведення (PCM кодом, без ffmpeg). */

/** mulberry32: детермінований PRNG, [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MetronomeOptions {
  bpm: number;
  /** Час першої бочки, с. */
  offsetSec: number;
  durationSec: number;
  /** Хай-хети на слабких восьмих і бас на долі. */
  busy?: boolean;
  /** Тихий стаціонарний пед (рівномірна енергія для замірів RMS). */
  pad?: boolean;
  sampleRate?: number;
}

/** Часи бочок «треку-метронома». */
export function kickTimes(opts: Pick<MetronomeOptions, "bpm" | "offsetSec" | "durationSec">): number[] {
  const period = 60 / opts.bpm;
  const out: number[] = [];
  for (let t = opts.offsetSec; t < opts.durationSec; t += period) out.push(t);
  return out;
}

/** «Трек-метроном»: бочка на кожну долю зі зсувом `offsetSec`, за бажанням — хети, бас і пед. */
export function metronome(opts: MetronomeOptions): StereoPcm {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const n = Math.round(opts.durationSec * sr);
  const pcm = createStereo(n, sr);
  const add = (i: number, l: number, r = l) => {
    if (i < 0 || i >= n) return;
    pcm.left[i] = (pcm.left[i] ?? 0) + l;
    pcm.right[i] = (pcm.right[i] ?? 0) + r;
  };
  const period = 60 / opts.bpm;
  for (const t0 of kickTimes(opts)) {
    const s0 = Math.round(t0 * sr);
    let phase = 0;
    for (let i = 0; i < Math.round(0.35 * sr); i++) {
      const t = i / sr;
      phase += (2 * Math.PI * (50 + 70 * Math.exp(-t / 0.03))) / sr;
      add(s0 + i, 0.8 * Math.sin(phase) * Math.exp(-t / 0.12) * Math.min(1, t / 0.001));
    }
  }
  if (opts.busy) {
    const rand = mulberry32(7);
    for (const t0 of kickTimes(opts)) {
      // Хет на слабку восьму, бас — на сильну.
      const h0 = Math.round((t0 + period / 2) * sr);
      for (let i = 0; i < Math.round(0.04 * sr); i++)
        add(h0 + i, 0.15 * (rand() * 2 - 1) * Math.exp(-i / sr / 0.01));
      const b0 = Math.round(t0 * sr);
      for (let i = 0; i < Math.round(period * 0.8 * sr); i++) {
        add(b0 + i, 0.2 * Math.sin((2 * Math.PI * 110 * i) / sr) * Math.exp(-i / sr / 0.3));
      }
    }
  }
  if (opts.pad) {
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const v =
        0.08 *
        (Math.sin(2 * Math.PI * 220 * t) +
          Math.sin(2 * Math.PI * 330 * t) +
          Math.sin(2 * Math.PI * 1760 * t));
      add(i, v, v * 0.9);
    }
  }
  return pcm;
}

/** Рівний «трек» без долі: шум + акорд (для автоматизації і чутності подій). */
export function steadyBed(durationSec: number, sampleRate = SAMPLE_RATE): StereoPcm {
  const n = Math.round(durationSec * sampleRate);
  const pcm = createStereo(n, sampleRate);
  const rand = mulberry32(11);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const tone = 0.15 * (Math.sin(2 * Math.PI * 196 * t) + Math.sin(2 * Math.PI * 293.7 * t));
    const hiss = 0.12 * (rand() * 2 - 1);
    pcm.left[i] = tone + hiss;
    pcm.right[i] = tone - hiss * 0.5;
  }
  return pcm;
}
