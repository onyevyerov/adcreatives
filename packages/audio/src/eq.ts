import { Biquad } from "./dsp.ts";
import { createStereo, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Еквалайзер шини подій: HPF прибирає гул і «бум» нижче бочки, LPF — різкий верх семплів,
 * щоб події лягли в спектр треку, а не поверх нього.
 */

export interface BandEq {
  /** Зріз high-pass, Гц (12 дБ/окт). */
  highpassHz: number;
  /** Зріз low-pass, Гц (12 дБ/окт). */
  lowpassHz: number;
}

/** Шина подій: HPF 80 Гц, LPF 9 кГц. */
export const EVENT_BUS_EQ: BandEq = { highpassHz: 80, lowpassHz: 9000 };

/** Новий канал: `x` через HPF і LPF (стан фільтрів — з нуля, довжина та сама). */
export function eqChannel(x: Float32Array, sampleRate: number, eq: BandEq = EVENT_BUS_EQ): Float32Array {
  const hp = new Biquad().setHighpass(eq.highpassHz, sampleRate);
  const lp = new Biquad().setLowpass(eq.lowpassHz, sampleRate);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = lp.process(hp.process(x[i] as number));
  return out;
}

/** Нова стерео-копія через `eqChannel` (вхід не змінюється). */
export function eqStereo(pcm: StereoPcm, eq: BandEq = EVENT_BUS_EQ): StereoPcm {
  const out = createStereo(pcmLength(pcm), pcm.sampleRate);
  out.left.set(eqChannel(pcm.left, pcm.sampleRate, eq));
  out.right.set(eqChannel(pcm.right, pcm.sampleRate, eq));
  return out;
}
