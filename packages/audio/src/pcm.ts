/**
 * PCM у пам'яті: стерео Float32 (−1..1). Уся обробка звуку зведення — тут, у Node,
 * без фільтрів ffmpeg (у збірці Remotion вони урізані) і без сторонніх бібліотек.
 */

/** Частота дискретизації зведення (і декодування музики). */
export const SAMPLE_RATE = 44_100;

export interface StereoPcm {
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
}

export function createStereo(length: number, sampleRate = SAMPLE_RATE): StereoPcm {
  const n = Math.max(0, Math.floor(length));
  return { sampleRate, left: new Float32Array(n), right: new Float32Array(n) };
}

export const pcmLength = (pcm: StereoPcm) => pcm.left.length;

export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) => 20 * Math.log10(Math.max(gain, 1e-12));

/** Секунди → індекс семпла (округлення до найближчого). */
export const secToSamples = (sec: number, sampleRate = SAMPLE_RATE) => Math.round(sec * sampleRate);

/** Кадр відео → індекс семпла. */
export const frameToSample = (frame: number, fps: number, sampleRate = SAMPLE_RATE) =>
  Math.round((frame * sampleRate) / fps);

const clampRange = (pcm: StereoPcm, start: number, end: number): [number, number] => [
  Math.max(0, Math.floor(start)),
  Math.min(pcmLength(pcm), Math.ceil(end)),
];

/** RMS обох каналів на відрізку [start, end) семплів; 0 для порожнього відрізка. */
export function rmsOf(pcm: StereoPcm, start = 0, end = pcmLength(pcm)): number {
  const [a, b] = clampRange(pcm, start, end);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const l = pcm.left[i] as number;
    const r = pcm.right[i] as number;
    sum += l * l + r * r;
  }
  return Math.sqrt(sum / (2 * (b - a)));
}

/** Пік (максимум модуля) обох каналів на відрізку [start, end). */
export function peakOf(pcm: StereoPcm, start = 0, end = pcmLength(pcm)): number {
  const [a, b] = clampRange(pcm, start, end);
  let peak = 0;
  for (let i = a; i < b; i++) {
    const l = Math.abs(pcm.left[i] as number);
    const r = Math.abs(pcm.right[i] as number);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

/** Копія, обрізана або доповнена тишею в кінці до `length` семплів. */
export function fitLength(pcm: StereoPcm, length: number): StereoPcm {
  const out = createStereo(length, pcm.sampleRate);
  const n = Math.min(length, pcmLength(pcm));
  out.left.set(pcm.left.subarray(0, n));
  out.right.set(pcm.right.subarray(0, n));
  return out;
}

/** Моно-сума (L+R)/2 у Float64 — для аналізу. */
export function monoOf(pcm: StereoPcm): Float64Array {
  const n = pcmLength(pcm);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = ((pcm.left[i] as number) + (pcm.right[i] as number)) / 2;
  return out;
}
