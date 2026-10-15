import { SOUND_CUE_TRAITS, SoundCue } from "@adc/shared";
import { z } from "zod";
import { type DecodeAudio, decodeAudio } from "./decode.ts";
import { gainToDb, peakOf, type StereoPcm } from "./pcm.ts";
import { analyzeSample, PITCHED_CUES } from "./samples.ts";
import type { CueDefinition } from "./sfx.ts";
import { correlation } from "./stereo.ts";

/**
 * Контроль якості семпла SFX після генерації (A2): гучність, атака, моно-сумісність, тон.
 * Хук викликає `ensureCached` (`sfx.ts`); не пройшов — повторна генерація.
 */

export const SfxQc = z.object({
  ok: z.boolean(),
  /** Пік семпла, dBFS; null — не міряно. */
  peakDb: z.number().nullable(),
  /** Onset від початку файлу, мс; null — не міряно. */
  onsetMs: z.number().nullable(),
  /** Кореляція L/R; null — не міряно. */
  correlation: z.number().nullable(),
  /** Впевнена висота тону; null — тону немає або не міряно. */
  pitchHz: z.number().nullable(),
  /** Порушення (порожньо, якщо `ok`). */
  reasons: z.array(z.string()),
  /** Скільки генерацій знадобилось (разом із першою). */
  attempts: z.number().int(),
});
export type SfxQc = z.infer<typeof SfxQc>;

export type SfxQcHook = (
  audio: Buffer,
  cue: string,
  def: CueDefinition,
  signal?: AbortSignal,
) => Promise<SfxQc>;

/**
 * Пік семпла не тихіший за −12 dBFS: зведення нормалізує звук події до піку 0 дБ, тож тихий
 * семпл піднімає й шум mp3 (замір: `ding.2` −34, `shimmer.2` −28 dBFS).
 */
export const SFX_QC_MIN_PEAK_DB = -12;
/**
 * Onset (поріг −24 дБ від піку огинаючої, як у `analyzeSample`) кастомного cue — не пізніше 50 мс від
 * початку файлу; для `SoundCue` — `SOUND_CUE_TRAITS.maxOnsetMs` (riser наростає з тиші — до 400 мс).
 */
export const SFX_QC_MAX_ONSET_MS = 50;
/**
 * Кореляція L/R: удари й тональні звуки мають бути майже моно (у протифазі на телефоні зникають);
 * прольоти й наростання (`stereo: "wide"`) можуть бути широкими, але не в протифазі.
 */
export const SFX_QC_MIN_CORRELATION = 0.3;
export const SFX_QC_MIN_CORRELATION_WIDE = -0.2;

/** Cue з мітки варіанта: `pop.2` → `pop`; кастомний cue (`cup-clink`) → null. */
export function sfxQcCue(label: string): SoundCue | null {
  const parsed = SoundCue.safeParse(label.replace(/\.\d+$/, ""));
  return parsed.success ? parsed.data : null;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * QC декодованого семпла. Кастомні cue (не `SoundCue`) — лише пік, onset і протифаза
 * (кореляція як у широких cue); тон перевіряється лише для тональних (`PITCHED_CUES`).
 */
export function checkSfxPcm(label: string, pcm: StereoPcm): SfxQc {
  const cue = sfxQcCue(label);
  const reasons: string[] = [];
  const peakDb = round(gainToDb(peakOf(pcm)), 1);
  // Кастомний cue аналізуємо як удар: якір — onset, тон не оцінюється.
  const analysis = analyzeSample(cue ?? "impact", pcm);
  const onsetMs = analysis ? round((analysis.onset / pcm.sampleRate) * 1000, 1) : null;
  const corr = round(correlation(pcm), 3);
  const pitchHz = analysis?.pitchHz != null ? round(analysis.pitchHz, 1) : null;

  if (!analysis) reasons.push("семпл порожній або тихий");
  if (peakDb < SFX_QC_MIN_PEAK_DB) reasons.push(`пік ${peakDb} dBFS < ${SFX_QC_MIN_PEAK_DB}`);
  const traits = cue ? SOUND_CUE_TRAITS[cue] : null;
  const maxOnset = traits?.maxOnsetMs ?? SFX_QC_MAX_ONSET_MS;
  if (onsetMs !== null && onsetMs > maxOnset) reasons.push(`onset ${onsetMs} мс > ${maxOnset}`);
  const minCorr = traits && traits.stereo !== "wide" ? SFX_QC_MIN_CORRELATION : SFX_QC_MIN_CORRELATION_WIDE;
  if (corr < minCorr) reasons.push(`кореляція L/R ${corr} < ${minCorr}`);
  if (analysis && cue && PITCHED_CUES.has(cue) && pitchHz === null)
    reasons.push("немає впевненої висоти тону");

  return { ok: reasons.length === 0, peakDb, onsetMs, correlation: corr, pitchHz, reasons, attempts: 1 };
}

/**
 * Хук QC з власним декодером. Декодер упав — хук кидає помилку (`ensureCached` тоді лишає
 * спробу без QC, а не перегенеровує: битий ffmpeg — не привід платити за новий семпл).
 */
export function createSfxQc(opts: { decode?: DecodeAudio } = {}): SfxQcHook {
  const decode = opts.decode ?? decodeAudio;
  return async (audio, cue, _def, signal) => checkSfxPcm(cue, await decode(audio, signal ? { signal } : {}));
}

/** Хук за замовчуванням: декодує через `decodeAudio` (mp3 і WAV) і перевіряє `checkSfxPcm`. */
export const defaultSfxQc: SfxQcHook = createSfxQc();
