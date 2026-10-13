import { beatFrames } from "@adc/shared";
import { BEATS_PER_BAR, estimateBarPhase, MIN_BAR_CONFIDENCE } from "./bars.ts";
import { Biquad } from "./dsp.ts";
import { createStereo, monoOf, pcmLength, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Вирівнювання долі: онсети бочки в низах → фаза долей відносно сітки `beatFrames(bpm)` →
 * фаза такту (`estimateBarPhase`, A6) → зсув треку (обрізати початок або додати тишу), щоб на
 * кадр 0 ліг downbeat (або, без певного такту, доля) і долі лягли на сітку кадрів, де стоять
 * межі сцен і події.
 */

/** Зріз низів для пошуку бочки. */
const KICK_BAND_HZ = 150;
/** Вікно і крок енергетичної огинаючої (23 мс / 5.8 мс при 44.1 кГц). */
const ENV_WINDOW = 1024;
const ENV_HOP = 256;
/** Онсет — локальний максимум у ±60 мс, не слабший за частку найсильнішого. */
const PEAK_RADIUS_SEC = 0.06;
const PEAK_THRESHOLD = 0.25;
/** Нижче цієї впевненості (довжина середнього вектора фаз) трек не зсуваємо. */
export const MIN_BEAT_CONFIDENCE = 0.25;
const MIN_ONSETS = 4;
/** Додаємо тишу на початку, лише якщо її треба не більше за це; інакше обрізаємо початок. */
const MAX_PAD_SEC = 0.15;
/** Короткий fade-in після обрізання, щоб не було клацання. */
const TRIM_FADE_SEC = 0.005;

export interface Onset {
  timeSec: number;
  strength: number;
}

/** Онсети в низах (бочка, бас): зростання RMS-огинаючої низькочастотної смуги. */
export function lowBandOnsets(pcm: StereoPcm): Onset[] {
  const sr = pcm.sampleRate;
  const mono = monoOf(pcm);
  const f1 = new Biquad().setLowpass(KICK_BAND_HZ, sr);
  const f2 = new Biquad().setLowpass(KICK_BAND_HZ, sr);
  const sq = new Float64Array(mono.length + 1);
  for (let i = 0; i < mono.length; i++) {
    const y = f2.process(f1.process(mono[i] ?? 0));
    sq[i + 1] = (sq[i] ?? 0) + y * y;
  }
  const frames = Math.max(0, Math.floor((mono.length - ENV_WINDOW) / ENV_HOP) + 1);
  const env = new Float64Array(frames);
  for (let k = 0; k < frames; k++) {
    const a = k * ENV_HOP;
    env[k] = Math.sqrt(((sq[a + ENV_WINDOW] ?? 0) - (sq[a] ?? 0)) / ENV_WINDOW);
  }
  const flux = new Float64Array(frames);
  let maxFlux = 0;
  for (let k = 1; k < frames; k++) {
    const d = Math.max(0, (env[k] ?? 0) - (env[k - 1] ?? 0));
    flux[k] = d;
    if (d > maxFlux) maxFlux = d;
  }
  if (maxFlux <= 0) return [];
  const radius = Math.max(1, Math.round((PEAK_RADIUS_SEC * sr) / ENV_HOP));
  const out: Onset[] = [];
  for (let k = 1; k < frames; k++) {
    const v = flux[k] ?? 0;
    if (v < PEAK_THRESHOLD * maxFlux) continue;
    let isPeak = true;
    for (let j = Math.max(1, k - radius); j <= Math.min(frames - 1, k + radius); j++) {
      const w = flux[j] ?? 0;
      if (w > v || (w === v && j < k)) {
        isPeak = false;
        break;
      }
    }
    // Онсет потрапляє в кінець вікна, коли воно доходить до удару: час = кінець вікна − пів кроку.
    if (isPeak) out.push({ timeSec: (k * ENV_HOP + ENV_WINDOW - ENV_HOP / 2) / sr, strength: v });
  }
  return out;
}

export interface BeatPhase {
  /** Час першої долі в треку, 0 ≤ offset < period, с. */
  offsetSec: number;
  /** 0..1: довжина зваженого середнього вектора фаз онсетів. */
  confidence: number;
  onsets: number;
}

/** Фаза долей: кругове середнє фаз онсетів відносно періоду, зважене силою онсету. */
export function estimateBeatPhase(onsets: readonly Onset[], periodSec: number): BeatPhase {
  let re = 0;
  let im = 0;
  let total = 0;
  for (const o of onsets) {
    const a = (2 * Math.PI * o.timeSec) / periodSec;
    re += o.strength * Math.cos(a);
    im += o.strength * Math.sin(a);
    total += o.strength;
  }
  if (total <= 0) return { offsetSec: 0, confidence: 0, onsets: onsets.length };
  const phase = Math.atan2(im, re);
  const offsetSec = ((((phase / (2 * Math.PI)) * periodSec) % periodSec) + periodSec) % periodSec;
  return { offsetSec, confidence: Math.hypot(re, im) / total, onsets: onsets.length };
}

export interface BeatAlignment {
  bpm: number;
  periodSec: number;
  offsetSec: number;
  confidence: number;
  /** Час першого downbeat у треку до зсуву, с; null — фаза такту не оцінювалась (нема певної долі). */
  barOffsetSec: number | null;
  /** Впевненість фази такту; зсув по такту — лише від `MIN_BAR_CONFIDENCE`. */
  barConfidence: number | null;
  /** > 0 — обрізано стільки семплів з початку; < 0 — додано стільки семплів тиші. */
  shiftSamples: number;
}

/**
 * Зсув, що ставить доли (або такти — з періодом такту) на сітку: обрізати `offset` або (якщо до
 * наступної долі близько) додати тишу.
 */
export function beatShiftSamples(offsetSec: number, periodSec: number, sampleRate: number): number {
  const pad = periodSec - offsetSec;
  if (pad <= MAX_PAD_SEC && pad < offsetSec) return -secToSamples(pad, sampleRate);
  return secToSamples(offsetSec, sampleRate);
}

/** Зсуває трек: shift > 0 обрізає початок (з коротким fade-in), shift < 0 додає тишу. */
export function shiftPcm(pcm: StereoPcm, shiftSamples: number): StereoPcm {
  const n = pcmLength(pcm);
  if (shiftSamples === 0) return pcm;
  if (shiftSamples < 0) {
    const out = createStereo(n - shiftSamples, pcm.sampleRate);
    out.left.set(pcm.left, -shiftSamples);
    out.right.set(pcm.right, -shiftSamples);
    return out;
  }
  const out = createStereo(Math.max(0, n - shiftSamples), pcm.sampleRate);
  out.left.set(pcm.left.subarray(shiftSamples));
  out.right.set(pcm.right.subarray(shiftSamples));
  const fade = Math.min(pcmLength(out), secToSamples(TRIM_FADE_SEC, pcm.sampleRate));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out.left[i] = (out.left[i] ?? 0) * g;
    out.right[i] = (out.right[i] ?? 0) * g;
  }
  return out;
}

/**
 * Повний крок: онсети → фаза долі → фаза такту → зсув. Без певного біта (тиша, ембієнт) трек не
 * зсувається; з певним тактом на кадр 0 стає downbeat (обрізання ≤ 1 такт або тиша ≤ 150 мс),
 * інакше — найближча доля, як без A6.
 */
export function alignToBeatGrid(
  pcm: StereoPcm,
  bpm: number,
  fps = 30,
): { pcm: StereoPcm; alignment: BeatAlignment } {
  const periodSec = beatFrames(bpm, fps) / fps;
  const phase = estimateBeatPhase(lowBandOnsets(pcm), periodSec);
  const sure = phase.onsets >= MIN_ONSETS && phase.confidence >= MIN_BEAT_CONFIDENCE;
  // Такт — на тій самій сітці долей (період, квантований до кадрів), від знайденої фази долі.
  const bar = sure ? estimateBarPhase(pcm, 60 / periodSec, phase.offsetSec) : null;
  const onBar = bar !== null && bar.confidence >= MIN_BAR_CONFIDENCE;
  const sr = pcm.sampleRate;
  const shiftSamples = !sure
    ? 0
    : onBar
      ? beatShiftSamples(bar.barOffsetSec, BEATS_PER_BAR * periodSec, sr)
      : beatShiftSamples(phase.offsetSec, periodSec, sr);
  return {
    pcm: shiftPcm(pcm, shiftSamples),
    alignment: {
      bpm,
      periodSec,
      offsetSec: phase.offsetSec,
      confidence: phase.confidence,
      barOffsetSec: bar?.barOffsetSec ?? null,
      barConfidence: bar?.confidence ?? null,
      shiftSamples,
    },
  };
}
