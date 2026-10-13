import { measureLoudness } from "./loudness.ts";
import { createStereo, dbToGain, gainToDb, pcmLength, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Мастер зведення: сума музики, подій і реверба → готовий `soundtrack.wav`.
 * Інтегральна гучність суми (BS.1770-4) підтягується до −14 LUFS одним підсиленням (±12 дБ),
 * далі true-peak лімітер (4× оверсемплінг, lookahead 1.5 мс, атака 0.5 мс, реліз 50 мс,
 * стеля −1 dBTP) і антиклік у кінці. Гучність і true peak результату міряються.
 */

/** Ціль інтегральної гучності мастера, LUFS (норма соцмереж). */
export const MASTER_TARGET_LUFS = -14;
/** Стеля true peak мастера, dBTP. */
export const MASTER_TRUE_PEAK_DBTP = -1;
/** Пікова стеля семплів: та сама −1 (true peak ≥ семплового піку). */
export const MASTER_CEILING_DBFS = MASTER_TRUE_PEAK_DBTP;
/** Межа підсилення суми до цілі, ±дБ: тиша не стає шумом, гучна сума не тисне лімітер. */
export const MASTER_MAX_GAIN_DB = 12;
/** Лімітер: заглядання вперед, атака (лінійна рампа), реліз (експонента до 1). */
export const LIMITER_LOOKAHEAD_SEC = 0.0015;
export const LIMITER_ATTACK_SEC = 0.0005;
export const LIMITER_RELEASE_SEC = 0.05;
/**
 * Запас стелі лімітера, дБ: детектор бачить точки 4× сітки, а не неперервний сигнал, і гейн
 * між ними трохи змінюється; запас тримає виміряний true peak нижче −1 dBTP.
 */
const LIMITER_MARGIN_DB = 0.05;
/** Проходи «підсилення → лімітер»: перший і до двох добирань гучності, яку зняв лімітер. */
export const MASTER_LOUDNESS_PASSES = 3;
/** Недобір гучності після лімітера, який ще не добирається, LU. */
const MASTER_LOUDNESS_TOLERANCE_LU = 0.1;
/** Короткий антиклік мастера в кінці ролика. */
const MASTER_END_FADE_SEC = 0.01;

export interface MasterResult {
  pcm: StereoPcm;
  /** Підсилення суми до лімітера, дБ (ціль LUFS мінус виміряна гучність суми з добиранням, у межах ±12). */
  gainDb: number;
  /** Інтегральна гучність результату, LUFS (−Infinity — тиша). */
  integratedLufs: number;
  /** True peak результату, dBTP. */
  truePeakDbtp: number;
}

/** Оверсемплінг і довжина прототипу інтерполятора детектора (12 відводів на фазу), як у `loudness.ts`. */
const OVERSAMPLE = 4;
const TP_TAPS = 48;

/** Поліфазні фази інтерполятора: windowed sinc (вікно Блекмана), кожна фаза — одиничне підсилення на DC. */
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
/** Затримка інтерполятора в семплах входу: вихід фази на індексі i лежить між семплами i−6 та i−5. */
const TP_DELAY = Math.ceil((TP_TAPS - 1) / 2 / OVERSAMPLE);

/**
 * Детектор true peak по семплах: модуль семпла і міжсемплових точок 4× сітки обох каналів.
 * Точка між семплами k і k+1 записується в обидва — гейн там має бути вже знижений.
 */
function truePeakDetector(pcm: StereoPcm): Float64Array {
  const n = pcmLength(pcm);
  const det = new Float64Array(n);
  if (n === 0) return det;
  const per = TP_TAPS / OVERSAMPLE;
  // Канал із нулями до й після сигналу (як у `truePeakDb`) — внутрішній цикл без перевірок меж.
  const padded = new Float64Array(n + 2 * (per - 1));
  for (const x of [pcm.left, pcm.right]) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i] as number);
      if (a > (det[i] as number)) det[i] = a;
      padded[i + per - 1] = x[i] as number;
    }
    for (let i = 0; i < n + per - 1; i++) {
      let a = 0;
      for (const taps of TP_PHASES) {
        let y = 0;
        for (let m = 0; m < per; m++) y += (taps[m] as number) * (padded[i - m + per - 1] as number);
        a = Math.max(a, Math.abs(y));
      }
      const k = Math.max(0, Math.min(n - 1, i - TP_DELAY));
      const k1 = Math.max(0, Math.min(n - 1, i - TP_DELAY + 1));
      if (a > (det[k] as number)) det[k] = a;
      if (a > (det[k1] as number)) det[k1] = a;
    }
  }
  return det;
}

/**
 * True peak, dBTP — той самий інтерполятор і той самий порядок сум, що `truePeakDb` з `loudness.ts`
 * (значення збігаються побітно), але без перевірок меж у внутрішньому циклі — утричі швидше.
 */
function truePeakOf(pcm: StereoPcm): number {
  let peak = 0;
  for (const d of truePeakDetector(pcm)) if (d > peak) peak = d;
  return gainToDb(peak);
}

/**
 * Гейн лімітера по семплах (≤ 1): потрібне зниження `ceiling / det` → мінімум у вікні lookahead
 * уперед (монотонна черга, O(n)) → реліз (експонента вгору, вниз — миттєво) → ковзне середнє
 * довжини атаки. Середнє вікна атаки бере лише значення, чиє вікно lookahead накриває поточний
 * семпл, тож гейн на піку не вищий за потрібний — без перевищення стелі на детекторі.
 */
function limiterGain(det: Float64Array, ceiling: number, sampleRate: number): Float64Array {
  const n = det.length;
  const look = Math.max(1, secToSamples(LIMITER_LOOKAHEAD_SEC, sampleRate));
  const attack = Math.max(1, Math.min(look + 1, secToSamples(LIMITER_ATTACK_SEC, sampleRate)));
  const release = Math.exp(-1 / (LIMITER_RELEASE_SEC * sampleRate));
  // Індекси зі зсувом `pad`: вікно атаки першого семпла теж визначене (до сигналу — гейн 1).
  const pad = attack - 1;
  const len = n + pad;
  const need = (q: number) => {
    const k = q - pad;
    if (k < 0 || k >= n) return 1;
    const d = det[k] as number;
    return d > ceiling ? ceiling / d : 1;
  };
  const queue = new Int32Array(len + look + 1);
  const queueVal = new Float64Array(len + look + 1);
  let head = 0;
  let tail = 0;
  const env = new Float64Array(len);
  const gain = new Float64Array(n);
  let level = 1;
  let sum = 0;
  for (let q = 0; q < len + look; q++) {
    const v = need(q);
    while (tail > head && (queueVal[tail - 1] as number) >= v) tail--;
    queue[tail] = q;
    queueVal[tail] = v;
    tail++;
    const p = q - look;
    if (p < 0) continue;
    while ((queue[head] as number) < p) head++;
    const hold = queueVal[head] as number;
    level = Math.min(hold, 1 - (1 - level) * release);
    env[p] = level;
    sum += level;
    if (p >= attack) sum -= env[p - attack] as number;
    const k = p - pad;
    if (k >= 0) gain[k] = Math.min(1, sum / attack);
  }
  return gain;
}

/**
 * Сума × підсилення `gainDb` → лімітер (стеля −1 dBTP із запасом) → антиклік у кінці. Нова копія.
 * Детектор лінійний (`det(g·x) = g·det(x)`), тож рахується один раз для суми, а стеля ділиться на
 * підсилення.
 */
function limitedCopy(sum: StereoPcm, det: Float64Array, gainDb: number, sr: number): StereoPcm {
  const total = pcmLength(sum);
  const makeup = dbToGain(gainDb);
  const ceiling = dbToGain(MASTER_TRUE_PEAK_DBTP - LIMITER_MARGIN_DB) / makeup;
  const gain = limiterGain(det, ceiling, sr);
  const endFade = Math.min(total, secToSamples(MASTER_END_FADE_SEC, sr));
  const out = createStereo(total, sr);
  for (let j = 0; j < total; j++) {
    const tail = j >= total - endFade ? (total - 1 - j) / Math.max(1, endFade) : 1;
    const g = makeup * (gain[j] as number) * tail;
    out.left[j] = (sum.left[j] as number) * g;
    out.right[j] = (sum.right[j] as number) * g;
  }
  return out;
}

/**
 * Мастер: підсилення суми до −14 LUFS (±12 дБ) → true-peak лімітер (стеля −1 dBTP) → антиклік
 * у кінці. Лімітер знімає трохи гучності на піках (бочка, удари) — тоді підсилення добирається
 * на недобір і лімітер проходить знову (до `MASTER_LOUDNESS_PASSES` проходів, у межах +12 дБ).
 * Нова копія; той самий вхід → побайтово той самий вихід.
 */
export function masterize(sum: StereoPcm, opts: { sampleRate: number }): MasterResult {
  const sr = opts.sampleRate;
  const measured = measureLoudness(sum).integratedLufs;
  let gainDb = Number.isFinite(measured)
    ? Math.max(-MASTER_MAX_GAIN_DB, Math.min(MASTER_MAX_GAIN_DB, MASTER_TARGET_LUFS - measured))
    : 0;
  const det = truePeakDetector(sum);
  let out = limitedCopy(sum, det, gainDb, sr);
  let integratedLufs = measureLoudness(out).integratedLufs;
  for (let pass = 1; pass < MASTER_LOUDNESS_PASSES && Number.isFinite(integratedLufs); pass++) {
    const shortfall = MASTER_TARGET_LUFS - integratedLufs;
    const next = Math.min(MASTER_MAX_GAIN_DB, gainDb + shortfall);
    if (shortfall <= MASTER_LOUDNESS_TOLERANCE_LU || next <= gainDb) break;
    gainDb = next;
    out = limitedCopy(sum, det, gainDb, sr);
    integratedLufs = measureLoudness(out).integratedLufs;
  }

  let truePeakDbtp = truePeakOf(out);
  // Страховка: якщо детектор недобачив (не очікується), — статичне зниження до стелі.
  if (truePeakDbtp > MASTER_TRUE_PEAK_DBTP) {
    const trim = dbToGain(MASTER_TRUE_PEAK_DBTP - LIMITER_MARGIN_DB - truePeakDbtp);
    for (let j = 0; j < pcmLength(out); j++) {
      out.left[j] = (out.left[j] as number) * trim;
      out.right[j] = (out.right[j] as number) * trim;
    }
    truePeakDbtp = truePeakOf(out);
    integratedLufs = measureLoudness(out).integratedLufs;
  }
  return { pcm: out, gainDb, integratedLufs, truePeakDbtp };
}
