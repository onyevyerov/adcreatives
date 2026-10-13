import { Biquad } from "./dsp.ts";
import { createStereo, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Стерео-аналіз і моно-сумісність: кореляція L/R (усього сигналу або низу) і згортання в моно
 * (усього сигналу або лише смуги нижче зрізу). Чисті функції: вхід не змінюється.
 */

/** Канал через LPF Баттерворта 12 дБ/окт (один біквад). */
function lowpass(x: Float32Array, cutoffHz: number, sampleRate: number): Float64Array {
  const f = new Biquad().setLowpass(cutoffHz, sampleRate);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = f.process(x[i] as number);
  return out;
}

/**
 * Кореляція L/R (−1..1): 1 — моно, 0 — незалежні канали, −1 — протифаза. З `belowHz` — після
 * LPF 12 дБ/окт на обох каналах. Тиша в обох каналах — 1 (моно), в одному — 0.
 */
export function correlation(pcm: StereoPcm, belowHz?: number): number {
  const sr = pcm.sampleRate;
  const l: ArrayLike<number> = belowHz === undefined ? pcm.left : lowpass(pcm.left, belowHz, sr);
  const r: ArrayLike<number> = belowHz === undefined ? pcm.right : lowpass(pcm.right, belowHz, sr);
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    const a = l[i] as number;
    const b = r[i] as number;
    lr += a * b;
    ll += a * a;
    rr += b * b;
  }
  if (ll === 0 && rr === 0) return 1;
  if (ll === 0 || rr === 0) return 0;
  return Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr)));
}

export interface MonoFoldOptions {
  /** null — увесь сигнал у моно; число — лише смуга нижче цього зрізу, Гц. */
  belowHz: number | null;
}

/**
 * Моно-згортання. `belowHz: null` — `(L+R)/2` в обидва канали. Число — M/S: низ side-сигналу
 * `S = (L−R)/2` (той самий LPF 12 дБ/окт, але вперед-назад — нульова фаза) віднімається, тож
 * `S − LPF(S)` доповнює низ рівно до S: верх лишається як був, низ стає моно, а моно-сума L+R
 * не змінюється ніде. Нова копія.
 */
export function monoFold(pcm: StereoPcm, opts: MonoFoldOptions): StereoPcm {
  const n = pcmLength(pcm);
  const out = createStereo(n, pcm.sampleRate);
  if (opts.belowHz === null) {
    for (let i = 0; i < n; i++) {
      const m = ((pcm.left[i] as number) + (pcm.right[i] as number)) / 2;
      out.left[i] = m;
      out.right[i] = m;
    }
    return out;
  }
  const side = new Float64Array(n);
  for (let i = 0; i < n; i++) side[i] = ((pcm.left[i] as number) - (pcm.right[i] as number)) / 2;
  // Нульова фаза: той самий біквад уперед, потім назад.
  const fwd = new Biquad().setLowpass(opts.belowHz, pcm.sampleRate);
  for (let i = 0; i < n; i++) side[i] = fwd.process(side[i] as number);
  const bwd = new Biquad().setLowpass(opts.belowHz, pcm.sampleRate);
  for (let i = n - 1; i >= 0; i--) side[i] = bwd.process(side[i] as number);
  for (let i = 0; i < n; i++) {
    const l = pcm.left[i] as number;
    const r = pcm.right[i] as number;
    const low = side[i] as number;
    out.left[i] = l - low;
    out.right[i] = r + low;
  }
  return out;
}
