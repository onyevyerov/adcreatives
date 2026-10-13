import { type Logger, type MusicTrackCheck, noopLogger } from "@adc/shared";
import { type MusicalKey, parseKey } from "./key.ts";
import type { StereoPcm } from "./pcm.ts";

/**
 * Тональність треку за звуком (A5): зведення строїть тональні події в тональність, яку
 * реально чути, а не лише ту, що в плані (генератор може її не дотримати).
 *
 * Хрома: FFT (вікно Ганна `KEY_FFT_SIZE`, крок `KEY_HOP`) → амплітуди бінів `KEY_MIN_HZ`…`KEY_MAX_HZ`
 * сумуються у 12 висотних класів (усі октави разом) по всьому треку → кореляція Пірсона з профілями
 * Крумгансла — Кесслер для 24 тональностей.
 */

export interface KeyEstimate {
  /** Висотний клас тоніки: C = 0 … B = 11. */
  root: number;
  minor: boolean;
  /** Відрив найкращого збігу від другого, нормований (0..1). */
  confidence: number;
}

export const KEY_FFT_SIZE = 4096;
export const KEY_HOP = 2048;
/** Смуга хроми, Гц: нижче — бочка й гул, вище — шум і тарілки. */
export const KEY_MIN_HZ = 60;
export const KEY_MAX_HZ = 5000;
/** Мінімальна впевненість, з якою ключ треку перекриває ключ плану. */
export const MIN_KEY_CONFIDENCE = 0.2;

/** Профілі Крумгансла — Кесслер (ваги ступенів від тоніки). */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;

/** Назви висотних класів у форматі, який розуміє `parseKey`. */
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** «A minor», «F# major» — формат `AudioPlan.key`. */
export const formatKey = (key: MusicalKey): string =>
  `${PITCH_NAMES[((key.root % 12) + 12) % 12]} ${key.minor ? "minor" : "major"}`;

/** Ітеративне FFT radix-2 на місці (`re.length` — степінь двійки); `cos`/`sin` — n/2 поворотних множників. */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array): void {
  const n = re.length;
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
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let k = 0; k < half; k++) {
      const wr = cos[k * stride] as number;
      const wi = -(sin[k * stride] as number);
      for (let s = k; s < n; s += len) {
        const t = s + half;
        const xr = (re[t] as number) * wr - (im[t] as number) * wi;
        const xi = (re[t] as number) * wi + (im[t] as number) * wr;
        re[t] = (re[s] as number) - xr;
        im[t] = (im[s] as number) - xi;
        re[s] = (re[s] as number) + xr;
        im[s] = (im[s] as number) + xi;
      }
    }
  }
}

/** Хрома треку: сума амплітуд бінів смуги по висотних класах (C = 0 … B = 11) за всіма вікнами. */
export function chroma(pcm: StereoPcm): Float64Array {
  const sr = pcm.sampleRate;
  const n = pcm.left.length;
  const out = new Float64Array(12);
  // Бін → висотний клас (−1 — поза смугою).
  const bins = KEY_FFT_SIZE / 2;
  const pc = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const hz = (k * sr) / KEY_FFT_SIZE;
    if (hz < KEY_MIN_HZ || hz > KEY_MAX_HZ) continue;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    pc[k] = ((midi % 12) + 12) % 12;
  }
  const hann = new Float64Array(KEY_FFT_SIZE);
  for (let i = 0; i < KEY_FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / KEY_FFT_SIZE);
  const cos = new Float64Array(KEY_FFT_SIZE / 2);
  const sin = new Float64Array(KEY_FFT_SIZE / 2);
  for (let k = 0; k < KEY_FFT_SIZE / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / KEY_FFT_SIZE);
    sin[k] = Math.sin((2 * Math.PI * k) / KEY_FFT_SIZE);
  }
  // Вікно Ганна з моно-суміші від `start` (за кінцем треку — нулі).
  const frame = (start: number, i: number) => {
    const j = start + i;
    return j < n ? (((pcm.left[j] as number) + (pcm.right[j] as number)) / 2) * (hann[i] as number) : 0;
  };
  const re = new Float64Array(KEY_FFT_SIZE);
  const im = new Float64Array(KEY_FFT_SIZE);
  // Короткий трек — одне вікно з доповненням нулями.
  const starts: number[] = [];
  for (let start = 0; start <= Math.max(0, n - KEY_FFT_SIZE); start += KEY_HOP) starts.push(start);
  // Два дійсні вікна за одне комплексне FFT: a — у дійсній частині, b — в уявній;
  // A[k] = (Z[k] + Z*[N−k]) / 2, B[k] = (Z[k] − Z*[N−k]) / 2i.
  for (let w = 0; w < starts.length; w += 2) {
    const a = starts[w] as number;
    const b = starts[w + 1];
    for (let i = 0; i < KEY_FFT_SIZE; i++) {
      re[i] = frame(a, i);
      im[i] = b === undefined ? 0 : frame(b, i);
    }
    fft(re, im, cos, sin);
    for (let k = 1; k < bins; k++) {
      const c = pc[k] as number;
      if (c < 0) continue;
      const zr = re[k] as number;
      const zi = im[k] as number;
      const nr = re[KEY_FFT_SIZE - k] as number;
      const ni = im[KEY_FFT_SIZE - k] as number;
      const magA = Math.sqrt((zr + nr) ** 2 + (zi - ni) ** 2) / 2;
      const magB = Math.sqrt((zr - nr) ** 2 + (zi + ni) ** 2) / 2;
      out[c] = (out[c] as number) + magA + magB;
    }
  }
  return out;
}

/** Кореляція Пірсона хроми з профілем, зсунутим на тоніку `root`. */
function profileCorrelation(c: Float64Array, profile: readonly number[], root: number): number {
  let mc = 0;
  let mp = 0;
  for (let i = 0; i < 12; i++) {
    mc += c[i] as number;
    mp += profile[i] as number;
  }
  mc /= 12;
  mp /= 12;
  let num = 0;
  let dc = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    const x = (c[(i + root) % 12] as number) - mc;
    const y = (profile[i] as number) - mp;
    num += x * y;
    dc += x * x;
    dp += y * y;
  }
  return dc > 0 && dp > 0 ? num / Math.sqrt(dc * dp) : 0;
}

/**
 * Тональність треку; null — не визначено (тиша, порожній трек, рівна хрома).
 * `confidence` = (r₁ − r₂) / r₁ — відрив найкращої кореляції від другої (0..1).
 */
export function detectKey(pcm: StereoPcm): KeyEstimate | null {
  if (pcm.left.length === 0) return null;
  const c = chroma(pcm);
  let total = 0;
  for (const v of c) total += v;
  if (!(total > 1e-6)) return null;
  const scores: Array<{ root: number; minor: boolean; r: number }> = [];
  for (let root = 0; root < 12; root++) {
    scores.push({ root, minor: false, r: profileCorrelation(c, MAJOR_PROFILE, root) });
    scores.push({ root, minor: true, r: profileCorrelation(c, MINOR_PROFILE, root) });
  }
  // За рівного збігу — менша тоніка, мажор раніше (детерміновано).
  scores.sort((a, b) => b.r - a.r || a.root - b.root || Number(a.minor) - Number(b.minor));
  const [best, second] = scores;
  if (!best || !second || best.r <= 0) return null;
  const confidence = Math.min(1, Math.max(0, (best.r - second.r) / best.r));
  return { root: best.root, minor: best.minor, confidence };
}

/**
 * Тональність для звуків подій: ключ треку, якщо він визначений із `confidence ≥ MIN_KEY_CONFIDENCE`
 * і відрізняється від плану (тоді — лог), інакше ключ плану (рядок плану як є, напр. «D dorian»).
 */
export function resolveEventKey(
  check: MusicTrackCheck | null,
  planKey: string | null,
  logger: Logger = noopLogger,
): string | null {
  const detected = check?.keyDetected ?? null;
  if (!detected || detected.confidence < MIN_KEY_CONFIDENCE) return planKey;
  const plan = parseKey(planKey);
  if (plan && plan.root === detected.root && plan.minor === detected.minor) return planKey;
  const trackKey = formatKey(detected);
  logger.info("тональність треку відрізняється від плану", {
    planKey,
    trackKey,
    confidence: detected.confidence,
  });
  return trackKey;
}
