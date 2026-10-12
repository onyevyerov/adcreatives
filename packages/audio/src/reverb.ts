import { createStereo, pcmLength, SAMPLE_RATE, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Спільний реверб зведення: один «простір» для музики й подій, щоб сухі семпли ElevenLabs
 * («dry, no reverb tail») звучали в тій самій кімнаті, що й трек. Детермінований стерео-IR
 * (шум з фіксованим зерном × експоненційний спад) і FFT-згортка overlap-add. Вхід — моно-посил,
 * вихід — стерео (лівий і правий IR декорельовані).
 */

/** Час спаду IR до −60 дБ, с. */
export const REVERB_DECAY_SEC = 1.2;
/** Предзатримка (тиша на початку IR), с. */
export const REVERB_PREDELAY_SEC = 0.01;
/** Рівні посилу в реверб: події — 0.25, музика — 0.08 (у треку вже є свій реверб). */
export const REVERB_SEND = { events: 0.25, music: 0.08 } as const;

/** Зерна шуму лівого і правого IR (зміна = інший простір = нова `MIX_VERSION`). */
const SEED_LEFT = 0x5eed_0001;
const SEED_RIGHT = 0x5eed_0002;
/** ln(1000): амплітуда −60 дБ за `REVERB_DECAY_SEC`. */
const LN_1000 = Math.log(1000);

/** Імпульсна характеристика: два канали однакової довжини, кожен з одиничною енергією. */
export interface ImpulseResponse {
  sampleRate: number;
  left: Float64Array;
  right: Float64Array;
}

/** mulberry32: детермінований PRNG, [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decayingNoise(seed: number, predelay: number, length: number, sampleRate: number, decaySec: number) {
  const out = new Float64Array(predelay + length);
  const rand = mulberry32(seed);
  let energy = 0;
  for (let i = 0; i < length; i++) {
    const v = (rand() * 2 - 1) * Math.exp((-LN_1000 * i) / (decaySec * sampleRate));
    out[predelay + i] = v;
    energy += v * v;
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  for (let i = predelay; i < out.length; i++) out[i] = (out[i] as number) * norm;
  return out;
}

/** Детермінований стерео-IR: `predelaySec` тиші, далі шум × e^(−t·ln1000/decaySec) довжиною `decaySec`. */
export function reverbImpulse(
  sampleRate = SAMPLE_RATE,
  opts: { decaySec?: number; predelaySec?: number } = {},
): ImpulseResponse {
  const decaySec = opts.decaySec ?? REVERB_DECAY_SEC;
  const predelay = secToSamples(opts.predelaySec ?? REVERB_PREDELAY_SEC, sampleRate);
  const length = Math.max(1, secToSamples(decaySec, sampleRate));
  return {
    sampleRate,
    left: decayingNoise(SEED_LEFT, predelay, length, sampleRate, decaySec),
    right: decayingNoise(SEED_RIGHT, predelay, length, sampleRate, decaySec),
  };
}

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/** Ітеративне FFT radix-2 на місці (`n` — степінь двійки); `inverse` — з діленням на n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0 || im.length !== n) throw new Error(`fft: довжина ${n} — не степінь двійки`);
  // Бітова перестановка.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step] as number;
        const wi = sign * (sin[k * step] as number);
        const a = start + k;
        const b = a + half;
        const xr = re[b] as number;
        const xi = im[b] as number;
        const tr = wr * xr - wi * xi;
        const ti = wr * xi + wi * xr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

/** Розмір FFT: найменша степінь двійки ≥ 2·довжина IR (блок входу не коротший за IR). */
function fftSizeFor(irLength: number): number {
  let n = 2;
  while (n < 2 * irLength) n <<= 1;
  return n;
}

const spectrumCache = new WeakMap<ImpulseResponse, { n: number; re: Float64Array; im: Float64Array }>();

/** Спектр комплексного IR `left + i·right` (один FFT на обидва канали). */
function irSpectrum(ir: ImpulseResponse) {
  let s = spectrumCache.get(ir);
  if (!s) {
    const len = Math.max(ir.left.length, ir.right.length);
    const n = fftSizeFor(len);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(ir.left);
    im.set(ir.right);
    fft(re, im);
    s = { n, re, im };
    spectrumCache.set(ir, s);
  }
  return s;
}

/**
 * Згортка моно-сигналу `x` зі стерео-IR (FFT, overlap-add), обрізана до довжини `x`.
 * Вхід дійсний, IR — комплексний `left + i·right`: дійсна частина результату — лівий канал,
 * уявна — правий.
 */
export function convolveStereo(
  x: Float64Array,
  ir: ImpulseResponse,
): { left: Float64Array; right: Float64Array } {
  const total = x.length;
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  const irLen = Math.max(ir.left.length, ir.right.length);
  if (total === 0 || irLen === 0) return { left, right };
  const h = irSpectrum(ir);
  const n = h.n;
  const block = n - irLen + 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let from = 0; from < total; from += block) {
    const len = Math.min(block, total - from);
    // Тихий блок (повна тиша) нічого не додає.
    let silent = true;
    for (let i = 0; i < len; i++) {
      if (x[from + i] !== 0) {
        silent = false;
        break;
      }
    }
    if (silent) continue;
    re.fill(0);
    im.fill(0);
    re.set(x.subarray(from, from + len));
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const ar = re[k] as number;
      const ai = im[k] as number;
      const br = h.re[k] as number;
      const bi = h.im[k] as number;
      re[k] = ar * br - ai * bi;
      im[k] = ar * bi + ai * br;
    }
    fft(re, im, true);
    const end = Math.min(total, from + len + irLen - 1);
    for (let j = from; j < end; j++) {
      left[j] = (left[j] as number) + (re[j - from] as number);
      right[j] = (right[j] as number) + (im[j - from] as number);
    }
  }
  return { left, right };
}

const defaultIr = new Map<number, ImpulseResponse>();

/** Спільний IR для частоти дискретизації (детермінований, один на процес). */
export function sharedImpulse(sampleRate = SAMPLE_RATE): ImpulseResponse {
  let ir = defaultIr.get(sampleRate);
  if (!ir) {
    ir = reverbImpulse(sampleRate);
    defaultIr.set(sampleRate, ir);
  }
  return ir;
}

/** Повернення реверба для стерео-посилу: моно-сума (L+R)/2 → стерео-згортка, довжина посилу. */
export function applyReverb(
  send: StereoPcm,
  ir: ImpulseResponse = sharedImpulse(send.sampleRate),
): StereoPcm {
  const n = pcmLength(send);
  const out = createStereo(n, send.sampleRate);
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = ((send.left[i] as number) + (send.right[i] as number)) / 2;
  const wet = convolveStereo(mono, ir);
  out.left.set(wet.left);
  out.right.set(wet.right);
  return out;
}
