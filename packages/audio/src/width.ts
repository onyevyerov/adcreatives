import { Biquad } from "./dsp.ts";
import { createStereo, dbToGain, pcmLength, type StereoPcm } from "./pcm.ts";
import { correlation } from "./stereo.ts";

/**
 * Ширина стерео музики (A11): ElevenLabs віддає трек майже моно (кореляція L/R ≈ 0.99).
 * Зведення викликає `widenMusic` після нормалізації музики, до автоматизації частин.
 * M/S: mid не змінюється (моно-сума та сама), side вище `WIDTH_HPF_HZ` підсилюється, side нижче —
 * прибирається (бас і бочка в центрі). Ширину беремо лише з того, що в треку вже є: моно лишається моно.
 */

/** Підсилення side вище `WIDTH_HPF_HZ`, дБ. */
export const WIDTH_SIDE_DB = 4;
/** Зріз side: нижче — моно, Гц. */
export const WIDTH_HPF_HZ = 300;
/** Межа кореляції L/R: ширший трек не чіпаємо, і після обробки кореляція не нижча за неї. */
export const WIDTH_MIN_CORRELATION = 0.6;
/** Кроки бісекції підсилення side, коли +4 дБ дають кореляцію нижче межі. */
const GAIN_SEARCH_STEPS = 40;
/** Запас над межею на округлення виходу у Float32. */
const CORRELATION_MARGIN = 1e-3;

/** Копія без змін. */
function copyOf(pcm: StereoPcm): StereoPcm {
  const out = createStereo(pcmLength(pcm), pcm.sampleRate);
  out.left.set(pcm.left);
  out.right.set(pcm.right);
  return out;
}

/**
 * Розширення стерео музики. `S = (L − R)/2` → верх side (`S − LPF(S)`, той самий LPF 12 дБ/окт
 * уперед-назад — нульова фаза, як у `monoFold`) × `WIDTH_SIDE_DB`; `L = M + S'`, `R = M − S'`.
 * Трек з кореляцією нижче `WIDTH_MIN_CORRELATION` — без змін; якщо +4 дБ опускають кореляцію нижче
 * межі, підсилення side зменшується (бісекцією за енергіями) до виконання умови. Нова копія.
 */
export function widenMusic(pcm: StereoPcm): StereoPcm {
  const n = pcmLength(pcm);
  if (n === 0 || correlation(pcm) < WIDTH_MIN_CORRELATION) return copyOf(pcm);
  const sr = pcm.sampleRate;
  const mid = new Float64Array(n);
  const side = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const l = pcm.left[i] as number;
    const r = pcm.right[i] as number;
    mid[i] = (l + r) / 2;
    side[i] = (l - r) / 2;
  }
  // Низ side нульовою фазою: той самий біквад уперед, потім назад; верх — доповнення до S.
  const low = Float64Array.from(side);
  const fwd = new Biquad().setLowpass(WIDTH_HPF_HZ, sr);
  for (let i = 0; i < n; i++) low[i] = fwd.process(low[i] as number);
  const bwd = new Biquad().setLowpass(WIDTH_HPF_HZ, sr);
  for (let i = n - 1; i >= 0; i--) low[i] = bwd.process(low[i] as number);
  let mm = 0;
  let ss = 0;
  let ms = 0;
  for (let i = 0; i < n; i++) {
    const m = mid[i] as number;
    const s = (side[i] as number) - (low[i] as number);
    side[i] = s;
    mm += m * m;
    ss += s * s;
    ms += m * s;
  }
  // Кореляція L/R при підсиленні g: L·R = mm − g²ss, |L|² і |R|² = mm + g²ss ± 2g·ms.
  const corrAt = (g: number) => {
    const lr = mm - g * g * ss;
    const ll = mm + g * g * ss + 2 * g * ms;
    const rr = mm + g * g * ss - 2 * g * ms;
    return ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1;
  };
  const target = WIDTH_MIN_CORRELATION + CORRELATION_MARGIN;
  let gain = dbToGain(WIDTH_SIDE_DB);
  if (corrAt(gain) < target) {
    // g = 0 — чистий mid (кореляція 1); шукаємо найбільше g з кореляцією не нижче межі.
    let lo = 0;
    let hi = gain;
    for (let k = 0; k < GAIN_SEARCH_STEPS; k++) {
      const g = (lo + hi) / 2;
      if (corrAt(g) >= target) lo = g;
      else hi = g;
    }
    gain = lo;
  }
  const out = createStereo(n, sr);
  for (let i = 0; i < n; i++) {
    const m = mid[i] as number;
    const s = (side[i] as number) * gain;
    out.left[i] = m + s;
    out.right[i] = m - s;
  }
  return out;
}
