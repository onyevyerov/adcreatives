import { Biquad } from "./dsp.ts";
import { monoOf, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Фаза такту (A6): яка з долей сітки — перша сильна (downbeat). Вирівнювання ставить на кадр 0
 * downbeat, а не будь-яку долю, і вікно відео в треку рахується від нього.
 *
 * Чотири кандидати (downbeat на 0-й…3-й долі від `beatOffsetSec`) оцінюються за профілем такту:
 * онсети низів (бочка, бас) на долях 1 і 3 проти 2 і 4, онсети середини 1–4 кГц (клапи, снейр)
 * на долях 2 і 4 проти 1 і 3, і акцент такту — низи на долі 1 сильніші, ніж на 3. Без акценту
 * долі 1 і 3 нерозрізнимі (візерунок «бочка–клап» повторюється кожні 2 долі), тож впевненість
 * такого треку ≈ 0 і вирівнювання лишається на фазі долі.
 */

/** Долей у такті (4/4). */
export const BEATS_PER_BAR = 4;
/** Нижче цієї впевненості фазу такту не використовуємо — лише фаза долі. */
export const MIN_BAR_CONFIDENCE = 0.2;
/** Зріз низів (бочка, бас) — як у пошуку долі. */
const LOW_BAND_HZ = 150;
/** Смуга клапів і снейра. */
const CLAP_LOW_HZ = 1_000;
const CLAP_HIGH_HZ = 4_000;
/** Вікно і крок енергетичної огинаючої — як у `lowBandOnsets` (час онсету в тій самій шкалі). */
const ENV_WINDOW = 1024;
const ENV_HOP = 256;
/** Онсет «на долі» — не далі за 80 мс (і за чверть долі) від сітки. */
const ON_BEAT_TOLERANCE_SEC = 0.08;
/** Менше повних тактів — профіль ненадійний, фазу не оцінюємо. */
const MIN_BARS = 4;

export interface BarPhase {
  /** Час першого downbeat від початку PCM, с. */
  barOffsetSec: number;
  confidence: number;
}

/** Наростання RMS-огинаючої смуги (каскад біквадів) по кадрах `ENV_HOP`: max(0, env[k] − env[k−1]). */
function bandFlux(mono: Float64Array, filters: readonly Biquad[]): Float64Array {
  const sq = new Float64Array(mono.length + 1);
  for (let i = 0; i < mono.length; i++) {
    let y = mono[i] ?? 0;
    for (const f of filters) y = f.process(y);
    sq[i + 1] = (sq[i] ?? 0) + y * y;
  }
  const frames = Math.max(0, Math.floor((mono.length - ENV_WINDOW) / ENV_HOP) + 1);
  const flux = new Float64Array(frames);
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const a = k * ENV_HOP;
    const env = Math.sqrt(((sq[a + ENV_WINDOW] ?? 0) - (sq[a] ?? 0)) / ENV_WINDOW);
    if (k > 0) flux[k] = Math.max(0, env - prev);
    prev = env;
  }
  return flux;
}

/** Профіль такту: частка сили онсетів на кожній з 4 позицій (сума 1; без онсетів — нулі). */
function share(sums: readonly number[]): number[] {
  const total = sums.reduce((a, x) => a + x, 0);
  return sums.map((x) => (total > 0 ? x / total : 0));
}

/**
 * Фаза такту від сітки долей (`beatOffsetSec`, період `60 / bpm`). Сила онсету на долі — найбільше
 * наростання огинаючої смуги в ±80 мс; сумується по повних тактах окремо для кожної з 4 позицій.
 * Оцінка кандидата c (downbeat на позиції c):
 * `(l1 + l3 − l2 − l4) + (m2 + m4 − m1 − m3) + (l1 − l3)`, де l — частки низів, m — середини
 * на долях такту. `confidence` — відрив найкращого кандидата від другого, поділений на 2
 * (найбільший можливий відрив кандидатів c і c+2: усі низи — на долі 1), у межах 0..1.
 * null — нема сітки (bpm), менше `MIN_BARS` тактів або тиша.
 */
export function estimateBarPhase(pcm: StereoPcm, bpm: number, beatOffsetSec: number): BarPhase | null {
  if (!(bpm > 0) || !Number.isFinite(beatOffsetSec)) return null;
  const sr = pcm.sampleRate;
  const periodSec = 60 / bpm;
  const totalSec = pcmLength(pcm) / sr;
  const tol = Math.min(ON_BEAT_TOLERANCE_SEC, periodSec / 4);
  const beats = Math.max(0, Math.ceil((totalSec - tol - beatOffsetSec) / periodSec));
  const bars = Math.floor(beats / BEATS_PER_BAR);
  if (bars < MIN_BARS) return null;

  const mono = monoOf(pcm);
  const low = bandFlux(mono, [
    new Biquad().setLowpass(LOW_BAND_HZ, sr),
    new Biquad().setLowpass(LOW_BAND_HZ, sr),
  ]);
  const mid = bandFlux(mono, [
    new Biquad().setHighpass(CLAP_LOW_HZ, sr),
    new Biquad().setHighpass(CLAP_LOW_HZ, sr),
    new Biquad().setLowpass(CLAP_HIGH_HZ, sr),
    new Biquad().setLowpass(CLAP_HIGH_HZ, sr),
  ]);
  // Кадр k «чує» онсет у момент (k·HOP + WINDOW − HOP/2) / sr — та сама шкала, що в `lowBandOnsets`.
  const frameOf = (t: number) => (t * sr - ENV_WINDOW + ENV_HOP / 2) / ENV_HOP;
  const peak = (flux: Float64Array, t: number) => {
    let best = 0;
    const last = Math.min(flux.length - 1, Math.floor(frameOf(t + tol)));
    for (let k = Math.max(1, Math.ceil(frameOf(t - tol))); k <= last; k++)
      best = Math.max(best, flux[k] ?? 0);
    return best;
  };
  const lowSums = [0, 0, 0, 0];
  const midSums = [0, 0, 0, 0];
  for (let k = 0; k < bars * BEATS_PER_BAR; k++) {
    const t = beatOffsetSec + k * periodSec;
    const p = k % BEATS_PER_BAR;
    lowSums[p] = (lowSums[p] as number) + peak(low, t);
    midSums[p] = (midSums[p] as number) + peak(mid, t);
  }
  const l = share(lowSums);
  const m = share(midSums);
  if (l.every((x) => x === 0) && m.every((x) => x === 0)) return null;

  const at = (xs: readonly number[], c: number, beat: number) => xs[(c + beat) % BEATS_PER_BAR] as number;
  const scores = [0, 1, 2, 3].map((c) => {
    const kick = at(l, c, 0) + at(l, c, 2) - at(l, c, 1) - at(l, c, 3);
    const clap = at(m, c, 1) + at(m, c, 3) - at(m, c, 0) - at(m, c, 2);
    const accent = at(l, c, 0) - at(l, c, 2);
    return kick + clap + accent;
  });
  // Найкращий кандидат; за рівності — раніший (детерміновано).
  let best = 0;
  for (let c = 1; c < BEATS_PER_BAR; c++) if ((scores[c] as number) > (scores[best] as number)) best = c;
  const second = Math.max(...scores.filter((_, c) => c !== best));
  const confidence = Math.min(1, Math.max(0, ((scores[best] as number) - second) / 2));
  return { barOffsetSec: beatOffsetSec + best * periodSec, confidence };
}
