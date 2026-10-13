import { Biquad } from "./dsp.ts";
import { createStereo, pcmLength, SAMPLE_RATE, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Спільний реверб зведення: один «простір» для музики й подій, щоб сухі семпли ElevenLabs
 * («dry, no reverb tail») звучали в тій самій кімнаті, що й трек. Детермінований стерео-IR:
 * шум з фіксованим зерном у двох смугах (низ спадає повільно, верх — швидко, як у справжній
 * кімнаті повітря й стіни гасять верх) і LPF на хвості — без металевого шипіння білого шуму.
 * FFT-згортка overlap-add. Посил — стерео: кожен канал у свій IR з перехресним посилом, тож подія
 * зліва лишає хвіст зліва.
 */

/** Час спаду IR до −60 дБ нижче `REVERB_CROSSOVER_HZ`, с. */
export const REVERB_DECAY_SEC = 1.2;
/** Час спаду до −60 дБ вище `REVERB_CROSSOVER_HZ` (демпфування верху), с. */
export const REVERB_HIGH_DECAY_SEC = 0.5;
/** Розділ смуг IR (Лінквіц — Райлі 24 дБ/окт: сума LPF і HPF — рівна АЧХ), Гц. */
export const REVERB_CROSSOVER_HZ = 3000;
/** LPF на хвості IR (48 дБ/окт: енергія вище зрізу ≤ −20 дБ від усієї), Гц. */
export const REVERB_DAMPING_HZ = 6000;
/** Предзатримка (тиша на початку IR), с. */
export const REVERB_PREDELAY_SEC = 0.01;
/** Рівні посилу в реверб: події — 0.25, музика — 0.08 (у треку вже є свій реверб). */
export const REVERB_SEND = { events: 0.25, music: 0.08 } as const;
/** HPF посилу (12 дБ/окт): бас у реверб не йде — хвіст не гуде й не каламутить низ, Гц. */
export const REVERB_SEND_HPF_HZ = 200;
/** Перехресний посил: L → IR_L з домішкою 0.3·R (і навпаки); сума нормується на 1 + 0.3. */
export const REVERB_CROSSFEED = 0.3;

/** Зерна шуму лівого і правого IR (зміна = інший простір = нова `MIX_VERSION`). */
const SEED_LEFT = 0x5eed_0001;
const SEED_RIGHT = 0x5eed_0002;
/** ln(1000): амплітуда −60 дБ за час спаду. */
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

/** Каскад `stages` однакових біквадів Баттерворта (12 дБ/окт кожен; два — Лінквіц — Райлі), на місці. */
function cascade(
  x: Float64Array,
  kind: "lowpass" | "highpass",
  cutoffHz: number,
  sampleRate: number,
  stages: number,
) {
  for (let pass = 0; pass < stages; pass++) {
    const f =
      kind === "lowpass"
        ? new Biquad().setLowpass(cutoffHz, sampleRate)
        : new Biquad().setHighpass(cutoffHz, sampleRate);
    for (let i = 0; i < x.length; i++) x[i] = f.process(x[i] as number);
  }
}

interface DampedNoiseOptions {
  decaySec: number;
  highDecaySec: number;
  crossoverHz: number;
  dampingHz: number;
}

/**
 * Один канал IR: той самий шум у двох смугах — нижче розділу × e^(−t·ln1000/decaySec), вище ×
 * e^(−t·ln1000/highDecaySec); сума, LPF хвоста, одинична енергія, `predelay` тиші попереду.
 */
function dampedNoise(
  seed: number,
  predelay: number,
  length: number,
  sampleRate: number,
  o: DampedNoiseOptions,
) {
  const rand = mulberry32(seed);
  const low = new Float64Array(length);
  const high = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const u = rand() * 2 - 1;
    low[i] = u * Math.exp((-LN_1000 * i) / (o.decaySec * sampleRate));
    high[i] = u * Math.exp((-LN_1000 * i) / (o.highDecaySec * sampleRate));
  }
  cascade(low, "lowpass", o.crossoverHz, sampleRate, 2);
  cascade(high, "highpass", o.crossoverHz, sampleRate, 2);
  for (let i = 0; i < length; i++) low[i] = (low[i] as number) + (high[i] as number);
  cascade(low, "lowpass", o.dampingHz, sampleRate, 4);
  let energy = 0;
  for (let i = 0; i < length; i++) energy += (low[i] as number) ** 2;
  const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  const out = new Float64Array(predelay + length);
  for (let i = 0; i < length; i++) out[predelay + i] = (low[i] as number) * norm;
  return out;
}

/**
 * Детермінований стерео-IR: `predelaySec` тиші, далі двосмуговий шум довжиною `decaySec` — низ
 * спадає до −60 дБ за `decaySec`, верх (вище `REVERB_CROSSOVER_HZ`) — за `highDecaySec`, на хвості
 * LPF `REVERB_DAMPING_HZ`. Канали — різні зерна (декорельовані), кожен з одиничною енергією.
 */
export function reverbImpulse(
  sampleRate = SAMPLE_RATE,
  opts: { decaySec?: number; highDecaySec?: number; predelaySec?: number } = {},
): ImpulseResponse {
  const decaySec = opts.decaySec ?? REVERB_DECAY_SEC;
  const o: DampedNoiseOptions = {
    decaySec,
    highDecaySec: Math.min(decaySec, opts.highDecaySec ?? REVERB_HIGH_DECAY_SEC),
    crossoverHz: REVERB_CROSSOVER_HZ,
    dampingHz: REVERB_DAMPING_HZ,
  };
  const predelay = secToSamples(opts.predelaySec ?? REVERB_PREDELAY_SEC, sampleRate);
  const length = Math.max(1, secToSamples(decaySec, sampleRate));
  return {
    sampleRate,
    left: dampedNoise(SEED_LEFT, predelay, length, sampleRate, o),
    right: dampedNoise(SEED_RIGHT, predelay, length, sampleRate, o),
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

/** Спектри каналів IR окремо: `left` і `right` — дійсні сигнали, спектри комплексні. */
interface IrSpectrum {
  n: number;
  lRe: Float64Array;
  lIm: Float64Array;
  rRe: Float64Array;
  rIm: Float64Array;
}

const spectrumCache = new WeakMap<ImpulseResponse, IrSpectrum>();

/**
 * Спектри лівого і правого IR одним FFT: `Z = FFT(left + i·right)`, далі за спряженою симетрією
 * `L[k] = (Z[k] + Z*[n−k]) / 2`, `R[k] = (Z[k] − Z*[n−k]) / 2i`.
 */
function irSpectrum(ir: ImpulseResponse): IrSpectrum {
  let s = spectrumCache.get(ir);
  if (!s) {
    const len = Math.max(ir.left.length, ir.right.length);
    const n = fftSizeFor(len);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(ir.left);
    im.set(ir.right);
    fft(re, im);
    s = {
      n,
      lRe: new Float64Array(n),
      lIm: new Float64Array(n),
      rRe: new Float64Array(n),
      rIm: new Float64Array(n),
    };
    for (let k = 0; k < n; k++) {
      const m = (n - k) % n;
      const ar = re[k] as number;
      const ai = im[k] as number;
      const br = re[m] as number;
      const bi = im[m] as number;
      s.lRe[k] = (ar + br) / 2;
      s.lIm[k] = (ai - bi) / 2;
      s.rRe[k] = (ai + bi) / 2;
      s.rIm[k] = (br - ar) / 2;
    }
    spectrumCache.set(ir, s);
  }
  return s;
}

/**
 * Згортка стерео-входу зі стерео-IR (FFT, overlap-add), обрізана до довжини входу: `xLeft ∗ IR_L`
 * і `xRight ∗ IR_R` (без `xRight` — моно-вхід в обидва IR). Обидва входи йдуть одним комплексним
 * FFT `xLeft + i·xRight`, спектри розділяються за симетрією, добуток `XL·HL + i·XR·HR` після
 * зворотного FFT дає лівий канал у дійсній частині, правий — в уявній.
 */
export function convolveStereo(
  xLeft: Float64Array,
  ir: ImpulseResponse,
  xRight: Float64Array = xLeft,
): { left: Float64Array; right: Float64Array } {
  const total = Math.min(xLeft.length, xRight.length);
  const left = new Float64Array(total);
  const right = new Float64Array(total);
  const irLen = Math.max(ir.left.length, ir.right.length);
  if (total === 0 || irLen === 0) return { left, right };
  const h = irSpectrum(ir);
  const n = h.n;
  const block = n - irLen + 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const yRe = new Float64Array(n);
  const yIm = new Float64Array(n);
  for (let from = 0; from < total; from += block) {
    const len = Math.min(block, total - from);
    // Тихий блок (повна тиша в обох каналах) нічого не додає.
    let silent = true;
    for (let i = 0; i < len; i++) {
      if (xLeft[from + i] !== 0 || xRight[from + i] !== 0) {
        silent = false;
        break;
      }
    }
    if (silent) continue;
    re.fill(0);
    im.fill(0);
    re.set(xLeft.subarray(from, from + len));
    im.set(xRight.subarray(from, from + len));
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const m = (n - k) % n;
      const zr = re[k] as number;
      const zi = im[k] as number;
      const wr = re[m] as number;
      const wi = im[m] as number;
      // Спектри входів: XL = (Z[k] + Z*[m]) / 2, XR = (Z[k] − Z*[m]) / 2i.
      const xlr = (zr + wr) / 2;
      const xli = (zi - wi) / 2;
      const xrr = (zi + wi) / 2;
      const xri = (wr - zr) / 2;
      const hlr = h.lRe[k] as number;
      const hli = h.lIm[k] as number;
      const hrr = h.rRe[k] as number;
      const hri = h.rIm[k] as number;
      // P = XR·HR; Y = XL·HL + i·P.
      const pr = xrr * hrr - xri * hri;
      const pi = xrr * hri + xri * hrr;
      yRe[k] = xlr * hlr - xli * hli - pi;
      yIm[k] = xlr * hli + xli * hlr + pr;
    }
    fft(yRe, yIm, true);
    const end = Math.min(total, from + len + irLen - 1);
    for (let j = from; j < end; j++) {
      left[j] = (left[j] as number) + (yRe[j - from] as number);
      right[j] = (right[j] as number) + (yIm[j - from] as number);
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

/**
 * Повернення реверба для стерео-посилу: HPF `REVERB_SEND_HPF_HZ` на кожному каналі, перехресний
 * посил `(L + 0.3·R) / 1.3 → IR_L`, `(R + 0.3·L) / 1.3 → IR_R` (моно-посил звучить так само
 * гучно, як без перехресного), довжина посилу.
 */
export function applyReverb(
  send: StereoPcm,
  ir: ImpulseResponse = sharedImpulse(send.sampleRate),
): StereoPcm {
  const n = pcmLength(send);
  const sr = send.sampleRate;
  const out = createStereo(n, sr);
  const hpL = new Biquad().setHighpass(REVERB_SEND_HPF_HZ, sr);
  const hpR = new Biquad().setHighpass(REVERB_SEND_HPF_HZ, sr);
  const inL = new Float64Array(n);
  const inR = new Float64Array(n);
  const norm = 1 / (1 + REVERB_CROSSFEED);
  for (let i = 0; i < n; i++) {
    const l = hpL.process(send.left[i] as number);
    const r = hpR.process(send.right[i] as number);
    inL[i] = (l + REVERB_CROSSFEED * r) * norm;
    inR[i] = (r + REVERB_CROSSFEED * l) * norm;
  }
  const wet = convolveStereo(inL, ir, inR);
  out.left.set(wet.left);
  out.right.set(wet.right);
  return out;
}
