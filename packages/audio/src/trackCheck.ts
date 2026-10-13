import type { MusicTrackCheck } from "@adc/shared";
import { BEATS_PER_BAR, estimateBarPhase, MIN_BAR_CONFIDENCE } from "./bars.ts";
import { estimateBeatPhase, lowBandOnsets, MIN_BEAT_CONFIDENCE, shiftPcm } from "./beat.ts";
import { GAP_DROP_DB, GAP_MIN_MS, MIN_KICKS_PER_BEAT } from "./constants.ts";
import { detectKey } from "./keyDetect.ts";
import { measureLoudness, truePeakDb } from "./loudness.ts";
import { fitLength, gainToDb, pcmLength, rmsOf, type StereoPcm, secToSamples } from "./pcm.ts";
import { correlation } from "./stereo.ts";

/**
 * Перевірка згенерованого треку (A2): чи є бочка на сітці долей і чи нема провалів
 * (брейк, стоп, тихий філ) у вікні відео. Плюс вибір вікна відео в довшому треку
 * (зсув кратний такту від першого downbeat) і обрізання PCM на нього — до зведення, без `stage.ts`.
 */

/** Крок, з яким ковзне вікно шукає провали. */
const GAP_HOP_MS = 50;
/** Ковзне вікно RMS — не коротше за долю: між ударами бочки трек тихішає, це не провал. */
const GAP_WINDOW_MIN_MS = 500;
/** Онсет «на долі» — не далі за 80 мс (і за чверть долі) від сітки. */
const ON_BEAT_TOLERANCE_SEC = 0.08;
/** Межа «низу» для кореляції L/R треку, Гц. */
export const LOW_CORRELATION_HZ = 150;

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Нескінченність (тиша) у JSON не пишеться — null. */
const finite1 = (x: number) => (Number.isFinite(x) ? round1(x) : null);

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** RMS по секундах, дБ (остання неповна секунда — по своїй довжині). */
export function rmsPerSecondDb(pcm: StereoPcm): number[] {
  const n = pcmLength(pcm);
  const step = pcm.sampleRate;
  const out: number[] = [];
  for (let a = 0; a < n; a += step) out.push(round1(gainToDb(rmsOf(pcm, a, Math.min(n, a + step)))));
  return out;
}

/**
 * Провали: ділянки довші за 1 с, тихіші за медіану RMS по секундах більш ніж на 6 дБ.
 * RMS — у ковзному вікні довжиною в долю (не коротше 500 мс) з кроком 50 мс, щоб тиша між
 * ударами не рахувалась провалом; межі провалу — центри першого й останнього тихих вікон
 * (точність — до пів вікна). `dropDb` — наскільки RMS усієї ділянки нижча за медіану.
 */
export function findGaps(pcm: StereoPcm, medianDb: number, periodSec: number): MusicTrackCheck["gaps"] {
  const n = pcmLength(pcm);
  const sr = pcm.sampleRate;
  // Префіксні суми квадратів обох каналів: RMS будь-якого відрізка за O(1).
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const l = pcm.left[i] as number;
    const r = pcm.right[i] as number;
    sq[i + 1] = (sq[i] as number) + l * l + r * r;
  }
  const rmsDb = (a: number, b: number) =>
    b > a ? gainToDb(Math.sqrt(((sq[b] as number) - (sq[a] as number)) / (2 * (b - a)))) : -240;
  // Пів вікна — ціле число семплів (індекси префіксних сум).
  const half = Math.floor(
    Math.max(secToSamples(GAP_WINDOW_MIN_MS / 1000, sr), secToSamples(periodSec, sr)) / 2,
  );
  const hop = Math.max(1, secToSamples(GAP_HOP_MS / 1000, sr));
  const gaps: MusicTrackCheck["gaps"] = [];
  const close = (firstCenter: number, lastCenter: number) => {
    const from = firstCenter;
    const to = Math.min(n, lastCenter);
    if (((to - from) / sr) * 1000 <= GAP_MIN_MS) return;
    gaps.push({
      fromMs: Math.round((from / sr) * 1000),
      toMs: Math.round((to / sr) * 1000),
      dropDb: round1(medianDb - rmsDb(from, to)),
    });
  };
  let first = -1;
  let last = -1;
  for (let c = 0; c < n; c += hop) {
    const low = rmsDb(Math.max(0, c - half), Math.min(n, c + half)) < medianDb - GAP_DROP_DB;
    if (low) {
      if (first < 0) first = c;
      last = c;
    } else if (first >= 0) {
      close(first, last);
      first = -1;
    }
  }
  if (first >= 0) close(first, n);
  return gaps;
}

export interface CheckTrackOptions {
  /** Вікно відео від початку PCM, мс; дефолт — увесь трек. */
  videoMs?: number;
}

/**
 * `MusicTrackCheck` для PCM: онсети в низах (`lowBandOnsets`) → фаза сітки долей;
 * `kickOnsets` — долі треку, на яких є онсет (бочка на сітці); RMS по секундах; провали.
 * `ok` — сітка певна (`MIN_BEAT_CONFIDENCE`, як у зведенні), у перших `videoMs` бочка є
 * на ≥ 0.8 долі і там нема провалів. Плюс замір: тональність (`detectKey`), фаза такту
 * (`estimateBarPhase`, лише при певній сітці долей; від неї — вікно відео), кореляція L/R (уся
 * і нижче 150 Гц), LUFS і true peak — на `ok` не впливають.
 */
export function checkTrack(pcm: StereoPcm, bpm: number, opts: CheckTrackOptions = {}): MusicTrackCheck {
  const totalSec = pcmLength(pcm) / pcm.sampleRate;
  const videoSec = Math.min(totalSec, (opts.videoMs ?? totalSec * 1000) / 1000);
  const periodSec = 60 / bpm;
  const onsets = lowBandOnsets(pcm);
  const phase = estimateBeatPhase(onsets, periodSec);
  const perSecond = rmsPerSecondDb(pcm);
  const gaps = findGaps(pcm, median(perSecond), periodSec);

  // Долі сітки (від фази онсетів) і чи є на кожній онсет.
  const tol = Math.min(ON_BEAT_TOLERANCE_SEC, periodSec / 4);
  const times = onsets.map((o) => o.timeSec);
  let j = 0;
  let kicks = 0;
  let beatsInVideo = 0;
  let kicksInVideo = 0;
  for (let t = phase.offsetSec; t < totalSec; t += periodSec) {
    while (j < times.length && (times[j] as number) < t - tol) j++;
    const hit = j < times.length && Math.abs((times[j] as number) - t) <= tol;
    if (hit) kicks++;
    if (t < videoSec) {
      beatsInVideo++;
      if (hit) kicksInVideo++;
    }
  }
  const sure = phase.confidence >= MIN_BEAT_CONFIDENCE;
  const enoughKicks = beatsInVideo > 0 && kicksInVideo >= MIN_KICKS_PER_BEAT * beatsInVideo;
  const gapInVideo = gaps.some((g) => g.fromMs < videoSec * 1000);
  const key = detectKey(pcm);
  const bar = sure ? estimateBarPhase(pcm, bpm, phase.offsetSec) : null;
  return {
    bpm,
    kickOnsets: kicks,
    beatConfidence: Math.round(phase.confidence * 100) / 100,
    gaps,
    rmsPerSecondDb: perSecond,
    ok: sure && enoughKicks && !gapInVideo,
    keyDetected: key ? { root: key.root, minor: key.minor, confidence: round2(key.confidence) } : null,
    barOffsetMs: bar ? Math.round(bar.barOffsetSec * 1000) : null,
    barConfidence: bar ? round2(bar.confidence) : null,
    stereoCorrelation: round2(correlation(pcm)),
    lowCorrelation: round2(correlation(pcm, LOW_CORRELATION_HZ)),
    integratedLufs: finite1(measureLoudness(pcm).integratedLufs),
    truePeakDbtp: finite1(truePeakDb(pcm)),
  };
}

/** Тривалість такту 4/4, мс. */
export const barMs = (bpm: number) => (BEATS_PER_BAR * 60_000) / bpm;

/** Скільки мілісекунд провалів потрапляє у вікно [offset, offset + length). */
export function gapOverlapMs(gaps: MusicTrackCheck["gaps"], offsetMs: number, lengthMs: number): number {
  const end = offsetMs + lengthMs;
  return gaps.reduce((a, g) => a + Math.max(0, Math.min(end, g.toMs) - Math.max(offsetMs, g.fromMs)), 0);
}

export interface WindowOptions {
  /** Довжина сирого треку, мс. */
  trackMs: number;
  /** Вікно, яке має бути без провалів (відео), мс. */
  videoMs: number;
  /** Хвіст після вікна, що теж має вміститись у трек, мс. */
  tailMs: number;
  bpm: number;
  /** Перший downbeat треку (`MusicTrackCheck.barOffsetMs`), мс; null — не визначено. */
  barOffsetMs?: number | null;
  /** Впевненість фази такту (`MusicTrackCheck.barConfidence`); нижче `MIN_BAR_CONFIDENCE` — від 0. */
  barConfidence?: number | null;
}

/**
 * Зсув вікна відео в треку: кратний такту від першого downbeat (при певній фазі такту, інакше
 * від 0), вікно + хвіст уміщаються в трек; перше вікно без провалів, інакше — з найменшою їх
 * тривалістю у вікні (за рівності — раніше). Downbeat, що не вміщається, — зсув від 0, як без такту.
 */
export function chooseWindowOffset(gaps: MusicTrackCheck["gaps"], opts: WindowOptions): number {
  const bar = barMs(opts.bpm);
  const room = opts.trackMs - opts.videoMs - opts.tailMs;
  const downbeat =
    opts.barOffsetMs != null && (opts.barConfidence ?? 0) >= MIN_BAR_CONFIDENCE ? opts.barOffsetMs : 0;
  const start = downbeat >= 0 && downbeat <= room ? downbeat : 0;
  const maxBars = bar > 0 && room > start ? Math.floor((room - start) / bar) : 0;
  let best = Math.round(start);
  let bestOverlap = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= maxBars; k++) {
    const offset = Math.round(start + k * bar);
    const overlap = gapOverlapMs(gaps, offset, opts.videoMs);
    if (overlap < bestOverlap) {
      best = offset;
      bestOverlap = overlap;
    }
    if (overlap === 0) break;
  }
  return best;
}

/**
 * Вікно треку [offset, offset + length): обрізання початку з коротким fade-in (`shiftPcm`)
 * і довжина не більша за наявну.
 */
export function cutWindow(pcm: StereoPcm, offsetMs: number, lengthMs: number): StereoPcm {
  const shifted = shiftPcm(pcm, secToSamples(offsetMs / 1000, pcm.sampleRate));
  const length = Math.min(pcmLength(shifted), secToSamples(lengthMs / 1000, pcm.sampleRate));
  return fitLength(shifted, length);
}

/** Чи спроба `a` краща за `b`: пройшла перевірку, потім менше провалів, потім більше онсетів бочки. */
export function betterCheck(a: MusicTrackCheck, b: MusicTrackCheck): boolean {
  if (a.ok !== b.ok) return a.ok;
  if (a.gaps.length !== b.gaps.length) return a.gaps.length < b.gaps.length;
  return a.kickOnsets > b.kickOnsets;
}
