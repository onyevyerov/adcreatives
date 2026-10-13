import { gainToDb, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Гучність за ITU-R BS.1770-4 (LUFS) і true peak (dBTP) — без залежностей.
 * K-фільтр (high shelf + RLB high-pass) з аналогового прототипу для будь-якої частоти
 * (як у libebur128), блоки 400 мс з перекриттям 75 %, абсолютний гейт −70 LUFS і
 * відносний −10 LU. True peak — 4× оверсемплінг поліфазним windowed sinc на 48 відводів.
 */

export interface Loudness {
  /** Інтегральна гучність із гейтами; −Infinity — немає жодного блоку над гейтом (тиша або < 400 мс). */
  integratedLufs: number;
  /** Максимум короткочасної гучності (вікно 3 с, крок 100 мс); −Infinity — трек коротший за 3 с. */
  shortTermMaxLufs: number;
  /** Максимум миттєвої гучності (вікно 400 мс, крок 100 мс); −Infinity — трек коротший за 400 мс. */
  momentaryMaxLufs: number;
}

/** Абсолютний і відносний гейти BS.1770-4. */
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
/** Крок блоків (100 мс = 75 % перекриття блоку 400 мс); блок — 4 кроки, short-term — 30. */
const STEP_SEC = 0.1;
const MOMENTARY_STEPS = 4;
const SHORT_TERM_STEPS = 30;

/** Коефіцієнти біквада (a0 = 1). */
interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Два каскади K-фільтра для частоти `sampleRate` (константи прототипу — з libebur128). */
function kWeighting(sampleRate: number): [Coeffs, Coeffs] {
  // 1) High shelf +4 дБ (модель голови).
  let f0 = 1681.974450955533;
  const g = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (g / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Coeffs = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // 2) High-pass RLB (~38 Гц).
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Coeffs = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  return [shelf, highpass];
}

/** Енергія (сума квадратів) K-зваженого каналу по кроках `step` семплів; неповний хвіст відкидається. */
function stepEnergies(channel: Float32Array, stages: readonly Coeffs[], step: number): Float64Array {
  const steps = Math.floor(channel.length / step);
  const out = new Float64Array(steps);
  const z1 = stages.map(() => 0);
  const z2 = stages.map(() => 0);
  for (let i = 0; i < steps * step; i++) {
    let x = channel[i] as number;
    for (let s = 0; s < stages.length; s++) {
      const c = stages[s] as Coeffs;
      // Transposed direct form II, як `Biquad`.
      const y = c.b0 * x + (z1[s] as number);
      z1[s] = c.b1 * x - c.a1 * y + (z2[s] as number);
      z2[s] = c.b2 * x - c.a2 * y;
      x = y;
    }
    const k = Math.floor(i / step);
    out[k] = (out[k] as number) + x * x;
  }
  return out;
}

const lufsOf = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

/**
 * Гучність стерео-PCM за BS.1770-4: обидва канали з вагою 1. Mean square блоку — середнє
 * K-зваженого квадрата по блоку, сума по каналах.
 */
export function measureLoudness(pcm: StereoPcm): Loudness {
  const sr = pcm.sampleRate;
  const step = Math.max(1, Math.round(STEP_SEC * sr));
  const stages = kWeighting(sr);
  const left = stepEnergies(pcm.left, stages, step);
  const right = stepEnergies(pcm.right, stages, step);
  const steps = left.length;
  const energy = new Float64Array(steps);
  for (let i = 0; i < steps; i++) energy[i] = (left[i] as number) + (right[i] as number);

  // Ковзна сума `width` кроків → mean square вікна.
  const windows = (width: number): Float64Array => {
    const count = Math.max(0, steps - width + 1);
    const out = new Float64Array(count);
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      sum += energy[i] as number;
      if (i >= width) sum -= energy[i - width] as number;
      if (i >= width - 1) out[i - width + 1] = sum / (width * step);
    }
    return out;
  };
  const maxLufs = (ms: Float64Array) => {
    let best = -Infinity;
    for (const z of ms) best = Math.max(best, lufsOf(z));
    return best;
  };

  const blocks = windows(MOMENTARY_STEPS);
  const aboveAbsolute = [...blocks].filter((z) => lufsOf(z) > ABSOLUTE_GATE_LUFS);
  let integratedLufs = -Infinity;
  if (aboveAbsolute.length > 0) {
    const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const relative = lufsOf(mean(aboveAbsolute)) + RELATIVE_GATE_LU;
    const gated = aboveAbsolute.filter((z) => lufsOf(z) > relative);
    if (gated.length > 0) integratedLufs = lufsOf(mean(gated));
  }
  return {
    integratedLufs,
    shortTermMaxLufs: maxLufs(windows(SHORT_TERM_STEPS)),
    momentaryMaxLufs: maxLufs(blocks),
  };
}

/** Оверсемплінг і довжина прототипу інтерполятора true peak (12 відводів на фазу). */
const OVERSAMPLE = 4;
const TP_TAPS = 48;

/**
 * Поліфазні фази інтерполятора: windowed sinc (вікно Блекмана) зі зрізом на Найквісті вхідної
 * частоти; кожна фаза нормована до одиничного підсилення на DC.
 */
const TP_PHASES: readonly Float64Array[] = (() => {
  const center = (TP_TAPS - 1) / 2;
  const proto = new Float64Array(TP_TAPS);
  for (let n = 0; n < TP_TAPS; n++) {
    const x = (n - center) / OVERSAMPLE;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (TP_TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (TP_TAPS - 1));
    proto[n] = sinc * w;
  }
  const perPhase = TP_TAPS / OVERSAMPLE;
  return Array.from({ length: OVERSAMPLE }, (_, p) => {
    const taps = new Float64Array(perPhase);
    let sum = 0;
    for (let m = 0; m < perPhase; m++) {
      taps[m] = proto[p + OVERSAMPLE * m] as number;
      sum += taps[m] as number;
    }
    for (let m = 0; m < perPhase; m++) taps[m] = (taps[m] as number) / sum;
    return taps;
  });
})();

function channelTruePeak(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i] as number));
  for (const taps of TP_PHASES) {
    // Межі — нулі до й після сигналу: хвіст інтерполятора теж перевіряється.
    for (let i = 0; i < x.length + taps.length; i++) {
      let y = 0;
      for (let m = 0; m < taps.length; m++) {
        const j = i - m;
        if (j >= 0 && j < x.length) y += (taps[m] as number) * (x[j] as number);
      }
      const a = Math.abs(y);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** True peak обох каналів, dBTP (не нижче семплового піку); тиша — −240. */
export function truePeakDb(pcm: StereoPcm): number {
  if (pcmLength(pcm) === 0) return gainToDb(0);
  return gainToDb(Math.max(channelTruePeak(pcm.left), channelTruePeak(pcm.right)));
}
