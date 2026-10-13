import type { SoundCue } from "@adc/shared";
import { hzToMidi, type MusicalKey, nearestScaleNote, pentatonic, scaleStep } from "./key.ts";
import { dbToGain, type StereoPcm, secToSamples } from "./pcm.ts";
import { correlation, monoFold } from "./stereo.ts";

/**
 * Семпли бібліотеки SFX (ElevenLabs, `prompts/elevenlabs/sfx-cues.md`) → звук події для зведення.
 * Чисті функції: огинаюча, onset і пік, якір (точка, що лягає на кадр події за семантикою §2.2),
 * обрізання тиші й хвоста, оцінка висоти тону (YIN), зсув висоти ресемплінгом, моно-сумісність,
 * нормалізація.
 */

/** Декодований варіант cue з бібліотеки; `hash` — хеш запиту SFX (ім'я файлу в кеші). */
export interface SfxSample {
  cue: SoundCue;
  /** Номер варіанта (1, 2, 3…) у `sfx-cues.md`. */
  variant: number;
  hash: string;
  pcm: StereoPcm;
}

/** Бібліотека семплів зведення: cue → варіанти в порядку номерів. Немає cue — події без звуку. */
export type SfxSampleLibrary = Partial<Record<SoundCue, readonly SfxSample[]>>;

/** Огинаюча: RMS у ковзному вікні 10 мс (шумові whoosh на коротшому вікні дають випадковий пік). */
export const ENVELOPE_WINDOW_SEC = 0.01;
/** Onset — перший семпл, де огинаюча ≥ −24 дБ від її піку. */
export const ONSET_THRESHOLD_DB = -24;
/** Кінець звуку — останній семпл огинаючої ≥ −60 дБ від піку (далі тиша). */
const TAIL_THRESHOLD_DB = -60;
/** riser: після піку лишається 30 мс (обрив), з них останні 10 мс — fade. */
export const RISER_TAIL_SEC = 0.03;
/** Довжина звуку події від початку; riser — до якоря. */
export const MAX_SAMPLE_SEC = 2;
/** Скільки звуку може бути до якоря: riser — ціле наростання, whoosh/swoosh — підліт. */
const MAX_PRE_ANCHOR_SEC: Partial<Record<SoundCue, number>> = { riser: 2, whoosh: 1, swoosh: 1 };
/** Антиклік на початку (з onset) і коли початок обрізано всередині звуку; fade-out у кінці. */
const FADE_IN_SEC = 0.0005;
const CUT_FADE_IN_SEC = 0.02;
const END_FADE_SEC = 0.01;

/** Оцінка висоти: ~150 мс після onset (без перших 10 мс транзієнта), 80–2000 Гц. */
export const PITCH_WINDOW_SEC = 0.15;
const PITCH_SKIP_SEC = 0.01;
export const PITCH_MIN_HZ = 80;
export const PITCH_MAX_HZ = 2000;
/** Поріг YIN (нормована різниця) і впевненість = 1 − різниця; нижче — тон не визначено. */
const YIN_THRESHOLD = 0.15;
export const PITCH_CONFIDENCE = 0.85;
/** Підтягування до найближчої ноти пентатоніки — не далі ±6 півтонів; загальний зсув — ±12. */
export const MAX_SNAP_SEMITONES = 6;
export const MAX_SHIFT_SEMITONES = 12;

/** Тональні cue (висота підтягується до тональності); pop/ding ще й ідуть угору в сцені. */
export const PITCHED_CUES: ReadonlySet<SoundCue> = new Set(["pop", "ding", "shimmer"]);
export const STEPPED_CUES: ReadonlySet<SoundCue> = new Set(["pop", "ding"]);

/**
 * Моно-сумісність (телефон грає моно): удари — повністю в моно (протифаза в `impact` гасить удар
 * у сумі); решта — моно лише нижче `MONO_BELOW_HZ`, верх лишає стерео.
 */
export const MONO_CUES: ReadonlySet<SoundCue> = new Set(["impact", "slam"]);
export const MONO_BELOW_HZ = 150;
/** Кореляція L/R фрагмента нижче — семпл повністю в моно, хоч би який cue. */
export const MONO_MIN_CORRELATION = 0.3;
/**
 * Прольоти (whoosh/swoosh/riser) широкі за природою: декорельований шум (кореляція ≈ 0) лишає
 * верх стерео, у моно згортається лише явна протифаза — поріг як у QC семплів (A2).
 */
export const WIDE_CUES: ReadonlySet<SoundCue> = new Set(["whoosh", "swoosh", "riser"]);
export const WIDE_MIN_CORRELATION = -0.2;

/**
 * Якір звуку: riser і whoosh/swoosh — пік огинаючої (riser — кінець найгучнішого вікна, тобто
 * точка обриву; whoosh/swoosh — центр), решта — onset.
 */
export const anchorKind = (cue: SoundCue): "peak" | "onset" =>
  cue === "riser" || cue === "whoosh" || cue === "swoosh" ? "peak" : "onset";

/**
 * Огинаюча: RMS обох каналів у вікні `window` семплів, що закінчується на i (ковзна сума).
 * Тому перший семпл звуку після тиші піднімає її одразу, а пік відстає на пів вікна.
 */
export function envelope(pcm: StereoPcm, window: number): Float64Array {
  const n = pcm.left.length;
  const w = Math.max(1, Math.floor(window));
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const l = pcm.left[i] as number;
    const r = pcm.right[i] as number;
    sum += (l * l + r * r) / 2;
    if (i >= w) {
      const l0 = pcm.left[i - w] as number;
      const r0 = pcm.right[i - w] as number;
      sum -= (l0 * l0 + r0 * r0) / 2;
    }
    out[i] = Math.sqrt(Math.max(0, sum) / w);
  }
  return out;
}

export interface PitchEstimate {
  hz: number;
  /** 1 − нормована різниця YIN у знайденому періоді (1 — ідеально періодичний сигнал). */
  confidence: number;
}

/** Основна частота моно-сигналу на [from, from + PITCH_WINDOW) методом YIN; null — немає даних. */
export function estimatePitch(mono: Float64Array, sampleRate: number, from: number): PitchEstimate | null {
  const tauMin = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
  const tauMax = Math.ceil(sampleRate / PITCH_MIN_HZ);
  const start = Math.max(0, Math.floor(from));
  const len = Math.min(mono.length - start, secToSamples(PITCH_WINDOW_SEC, sampleRate));
  const w = len - tauMax - 1;
  if (w < tauMax) return null;
  let energy = 0;
  for (let j = 0; j < w; j++) energy += (mono[start + j] as number) ** 2;
  if (energy / w < 1e-10) return null;
  const d = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const diff = (mono[start + j] as number) - (mono[start + j + tau] as number);
      s += diff * diff;
    }
    d[tau] = s;
  }
  // Кумулятивна нормована різниця (CMND).
  const cmnd = new Float64Array(tauMax + 2).fill(1);
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += d[tau] as number;
    cmnd[tau] = running > 0 ? ((d[tau] as number) * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if ((cmnd[tau] as number) < YIN_THRESHOLD) {
      while (tau + 1 <= tauMax && (cmnd[tau + 1] as number) < (cmnd[tau] as number)) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    best = tauMin;
    for (let tau = tauMin; tau <= tauMax; tau++)
      if ((cmnd[tau] as number) < (cmnd[best] as number)) best = tau;
  }
  // Параболічне уточнення періоду між сусідніми лагами.
  const a = cmnd[best - 1] as number;
  const b = cmnd[best] as number;
  const c = cmnd[best + 1] as number;
  const denom = a - 2 * b + c;
  const delta = denom > 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom))) : 0;
  return { hz: sampleRate / (best + delta), confidence: Math.max(0, Math.min(1, 1 - b)) };
}

export interface SampleAnalysis {
  /** Фрагмент оригіналу, що лишається: [from, to) у семплах. */
  from: number;
  to: number;
  /** Якір у семплах оригіналу (лягає на кадр події). */
  anchor: number;
  onset: number;
  peak: number;
  /** Початок обрізано всередині звуку (riser/whoosh довші за ліміт) — довший fade-in. */
  cutIn: boolean;
  /** Висота тону для тональних cue; null — не тональний cue або тон не визначено впевнено. */
  pitchHz: number | null;
  /** Кореляція L/R фрагмента [from, to) (−1..1). */
  correlation: number;
  /**
   * Звук іде в моно повністю (`MONO_CUES` або кореляція нижче порогу cue: `MONO_MIN_CORRELATION`,
   * для `WIDE_CUES` — `WIDE_MIN_CORRELATION`), інакше — лише низ.
   */
  monoFolded: boolean;
}

/** Аналіз семпла під cue; null — семпл порожній або тихий. */
export function analyzeSample(cue: SoundCue, pcm: StereoPcm): SampleAnalysis | null {
  const n = pcm.left.length;
  const sr = pcm.sampleRate;
  if (n === 0) return null;
  const win = Math.max(1, secToSamples(ENVELOPE_WINDOW_SEC, sr));
  const env = envelope(pcm, win);
  let peakEnv = 0;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) {
    if ((env[i] as number) > peakEnv) {
      peakEnv = env[i] as number;
      peakIdx = i;
    }
  }
  if (peakEnv < 1e-6) return null;
  // Вікно огинаючої закінчується на i: її пік — центр вікна.
  const peak = Math.max(0, peakIdx - Math.floor(win / 2));
  const onThr = peakEnv * dbToGain(ONSET_THRESHOLD_DB);
  let onset = 0;
  while (onset < n && (env[onset] as number) < onThr) onset++;
  const tailThr = peakEnv * dbToGain(TAIL_THRESHOLD_DB);
  let end = n;
  while (end > onset + 1 && (env[end - 1] as number) < tailThr) end--;

  const kind = anchorKind(cue);
  // riser обривається на піку: найгучніше вікно закінчується саме там, тож якір — кінець вікна;
  // у whoosh/swoosh пік посередині прольоту — центр вікна.
  const anchor = kind === "onset" ? onset : Math.max(onset, cue === "riser" ? peakIdx : peak);
  const maxPre = secToSamples(MAX_PRE_ANCHOR_SEC[cue] ?? 0, sr);
  const from = Math.max(onset, anchor - maxPre);
  const maxLen = secToSamples(MAX_SAMPLE_SEC, sr);
  const to =
    cue === "riser"
      ? Math.min(n, anchor + secToSamples(RISER_TAIL_SEC, sr))
      : Math.max(Math.min(end, from + maxLen), Math.min(n, anchor + 1));

  let pitchHz: number | null = null;
  if (PITCHED_CUES.has(cue)) {
    const mono = new Float64Array(n);
    for (let i = 0; i < n; i++) mono[i] = ((pcm.left[i] as number) + (pcm.right[i] as number)) / 2;
    const skip = secToSamples(PITCH_SKIP_SEC, sr);
    const est = estimatePitch(mono, sr, onset + skip) ?? estimatePitch(mono, sr, onset);
    if (est && est.confidence >= PITCH_CONFIDENCE) pitchHz = est.hz;
  }
  const kept = Math.max(to, from + 1);
  const corr = correlation({
    sampleRate: sr,
    left: pcm.left.subarray(from, kept),
    right: pcm.right.subarray(from, kept),
  });
  const minCorr = WIDE_CUES.has(cue) ? WIDE_MIN_CORRELATION : MONO_MIN_CORRELATION;
  const monoFolded = MONO_CUES.has(cue) || corr < minCorr;
  return { from, to: kept, anchor, onset, peak, cutIn: from > onset, pitchHz, correlation: corr, monoFolded };
}

/** Звук події, готовий до зведення: нормалізований до піку 1, `anchor` — семпл на кадрі події. */
export interface PreparedSound {
  left: Float32Array;
  right: Float32Array;
  anchor: number;
}

/** Кубічна інтерполяція Катмулла — Рома між x[i] і x[i+1] (детерміновано). */
function cubicAt(x: Float32Array, pos: number, from: number, to: number): number {
  const i = Math.floor(pos);
  const t = pos - i;
  const at = (k: number) => (k < from || k >= to ? 0 : (x[k] as number));
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/**
 * Фрагмент семпла → звук події: зсув висоти на `semitones` і переведення в `sampleRate` одним
 * ресемплінгом (коротшає/довшає разом із висотою), моно-згортання (`analysis.monoFolded` — увесь
 * звук, інакше — нижче `MONO_BELOW_HZ`), fade-in/fade-out, нормалізація піку до 1.
 */
export function renderSample(
  pcm: StereoPcm,
  analysis: SampleAnalysis,
  opts: { semitones: number; sampleRate: number },
): PreparedSound {
  const ratio = 2 ** (opts.semitones / 12) * (pcm.sampleRate / opts.sampleRate);
  const { from, to } = analysis;
  const n = Math.max(1, Math.floor((to - from) / ratio));
  const resampled = { sampleRate: opts.sampleRate, left: new Float32Array(n), right: new Float32Array(n) };
  const exact = ratio === 1;
  for (let i = 0; i < n; i++) {
    const pos = from + i * ratio;
    resampled.left[i] = exact ? (pcm.left[from + i] as number) : cubicAt(pcm.left, pos, from, to);
    resampled.right[i] = exact ? (pcm.right[from + i] as number) : cubicAt(pcm.right, pos, from, to);
  }
  const { left, right } = monoFold(resampled, { belowHz: analysis.monoFolded ? null : MONO_BELOW_HZ });
  const sr = opts.sampleRate;
  const fadeIn = Math.min(n, Math.max(1, secToSamples(analysis.cutIn ? CUT_FADE_IN_SEC : FADE_IN_SEC, sr)));
  for (let i = 0; i < fadeIn; i++) {
    const g = i / fadeIn;
    left[i] = (left[i] as number) * g;
    right[i] = (right[i] as number) * g;
  }
  const fadeOut = Math.min(n, Math.max(1, secToSamples(END_FADE_SEC, sr)));
  for (let k = 0; k < fadeOut; k++) {
    const i = n - 1 - k;
    const g = k / fadeOut;
    left[i] = (left[i] as number) * g;
    right[i] = (right[i] as number) * g;
  }
  let peak = 0;
  for (let i = 0; i < n; i++)
    peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  if (peak > 0) {
    for (let i = 0; i < n; i++) {
      left[i] = (left[i] as number) / peak;
      right[i] = (right[i] as number) / peak;
    }
  }
  const anchor = Math.min(n - 1, Math.max(0, Math.round((analysis.anchor - from) / ratio)));
  return { left, right, anchor };
}

/** Загальний зсув — у межах ±12 півтонів: зайве знімаємо октавами (висотний клас лишається). */
function foldShift(semitones: number): number {
  let s = semitones;
  while (s > MAX_SHIFT_SEMITONES) s -= 12;
  while (s < -MAX_SHIFT_SEMITONES) s += 12;
  return s;
}

export interface PitchedPlacement {
  cue: SoundCue;
  sceneId: string;
  /** Висота обраного варіанта; null — не тональний або тон не визначено. */
  pitchHz: number | null;
}

/**
 * Зсуви висоти (півтони) для подій у порядку розміщень.
 * pop/ding: перша впевнена нота сцени підтягується до найближчої ноти пентатоніки `key` (≤ ±6),
 * послідовні pop/ding сцени йдуть від неї вгору по ступенях; без впевненої висоти — лише відносні
 * кроки по інтервалах пентатоніки від власної висоти семпла. shimmer — лише підтягування, без кроків.
 * Решта cue — без зсуву. Загальний зсув — у межах ±12 півтонів.
 */
export function pitchShifts(placements: readonly PitchedPlacement[], key: MusicalKey): number[] {
  const scale = pentatonic(key);
  const degrees = new Map<string, number>();
  const bases = new Map<string, { note: number; degree: number }>();
  return placements.map((p) => {
    if (!PITCHED_CUES.has(p.cue)) return 0;
    const midi = p.pitchHz !== null ? hzToMidi(p.pitchHz) : null;
    const snapped = midi !== null ? nearestScaleNote(key, midi) : null;
    const confident = midi !== null && snapped !== null && Math.abs(snapped - midi) <= MAX_SNAP_SEMITONES;
    if (!STEPPED_CUES.has(p.cue)) return confident ? foldShift((snapped as number) - (midi as number)) : 0;
    const degree = degrees.get(p.sceneId) ?? 0;
    degrees.set(p.sceneId, degree + 1);
    if (confident) {
      let base = bases.get(p.sceneId);
      if (!base) {
        base = { note: snapped as number, degree };
        bases.set(p.sceneId, base);
      }
      return foldShift(scaleStep(key, base.note, degree - base.degree) - (midi as number));
    }
    const step = (scale[degree % scale.length] ?? 0) + 12 * Math.floor(degree / scale.length);
    return foldShift(step);
  });
}
