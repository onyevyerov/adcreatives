import {
  beatFrames,
  computeEventPlacements,
  computeTimeline,
  type EventPlacement,
  framesToMs,
  inputsHash,
  SOUND_CUE_TRAITS,
  type SoundAccent,
  SoundCue,
  type Storyboard,
} from "@adc/shared";
import { applyMixAutomation, duckMusic, type MusicDuck, mixSections } from "./automation.ts";
import { MIN_BAR_CONFIDENCE } from "./bars.ts";
import {
  alignToBeatGrid,
  type BeatAlignment,
  beatShiftSamples,
  MIN_BEAT_CONFIDENCE,
  shiftPcm,
} from "./beat.ts";
import { EVENT_BUS_EQ, eqChannel } from "./eq.ts";
import { FALLBACK_KEY, parseKey } from "./key.ts";
import { masterize } from "./master.ts";
import {
  createStereo,
  dbToGain,
  fitLength,
  frameToSample,
  gainToDb,
  pcmLength,
  rmsOf,
  SAMPLE_RATE,
  type StereoPcm,
  secToSamples,
} from "./pcm.ts";
import { applyReverb, REVERB_SEND } from "./reverb.ts";
import { type PreparedSound, pitchShifts, renderSample, type SfxSampleLibrary } from "./samples.ts";
import { chooseVariants, type PreparedEntry, prepareLibrary } from "./variants.ts";
import { encodeWav } from "./wav.ts";
import { widenMusic } from "./width.ts";

export { MASTER_CEILING_DBFS, MASTER_TARGET_LUFS, MASTER_TRUE_PEAK_DBTP } from "./master.ts";

/**
 * Зведення: музика (вирівняна по долі, нормалізована до RMS −14 dBFS, з автоматизацією частин) + звуки
 * подій з бібліотеки SFX (ElevenLabs) за спільним таймлайном — під музикою, а не над нею: шина подій
 * з EQ, спільний реверб для подій і музики, музичний дакінг (HPF на долю), мастер (`master.ts`:
 * −14 LUFS, true peak ≤ −1 dBTP). Результат — `soundtrack.wav`, який хост грає замість музики й SFX.
 */

/** Версія алгоритму зведення: входить у хеш повторного використання. */
export const MIX_VERSION = 4;

/**
 * Груба опора рівнів: музика нормалізується до RMS −14 dBFS до додавання подій (`CUE_LEVEL_DB`
 * рахуються відносно неї); підсумкову гучність (LUFS) і true peak визначає мастер (`masterize`).
 */
export const MASTER_RMS_DBFS = -14;
/** Максимальне підсилення музики при нормалізації (тиха музика не стає шумом). */
const MASTER_MAX_GAIN_DB = 24;

/** Пік події над RMS музики у вікні, дБ (`SOUND_CUE_TRAITS.levelDb`): удари над музикою, дрібниці — під нею. */
export const CUE_LEVEL_DB: Record<SoundCue, number> = Object.fromEntries(
  SoundCue.options.map((cue) => [cue, SOUND_CUE_TRAITS[cue].levelDb]),
) as Record<SoundCue, number>;
export const ACCENT_DB: Record<SoundAccent, number> = { soft: -3, normal: 0, hard: 3 };
/** Стеля рівня події над музикою (cue + accent), дБ: hard-удар не вище +6. */
export const MAX_CUE_DB = 6;

/** Вікно чутності події (100 мс навколо моменту, коли її видно) і ширше вікно для опори гучності. */
const WINDOW_SEC = 0.1;
const CONTEXT_SEC = 0.2;
/** Нижня межа опорного рівня: −12 дБ від середнього RMS музики, абсолютна — −40 dBFS. */
const REF_FLOOR_REL_DB = -12;
const REF_FLOOR_ABS_DB = -40;
/** Подія не гучніша за свою ціль більш ніж на 3.5 дБ (коли пік звуку поза вікном). */
const MAX_WINDOW_BOOST = 1.5;

export interface PlacedSound {
  sceneId: string;
  eventId: string;
  cue: SoundCue;
  accent: SoundAccent;
  frame: number;
  /** Ступінь пентатоніки для stepped-cue (pop/ding у сцені йдуть угору), інакше null. */
  degree: number | null;
  /** Варіант семпла з бібліотеки (1, 2, 3…) і його хеш. */
  variant: number;
  sampleHash: string;
  /** Зсув висоти семпла, півтони (0 — без зсуву). */
  semitones: number;
  /** Семпл кадру події в треку. */
  at: number;
  /** Семпл початку звуку (може бути < 0 — тоді початок обрізано). */
  start: number;
  /** Вікно чутності [from, to) у семплах. */
  window: [number, number];
  /** Пікова гучність звуку (лінійна, до мастера). */
  gain: number;
  /** `gain` у dBFS (до мастера). */
  gainDb: number;
  /** Пік звуку в міксі після підсилення мастера (до лімітера; > 0 — лімітер його притискає), dBFS. */
  peakDb: number;
  /** Найближча доля сітки зведення до кадру події (`nearestBeatIndex`); null — доля не визначена. */
  beatIndex: number | null;
  /** Подія вмикає дакінг музики (важкий удар або riser). */
  ducked: boolean;
}

/** Подія зі звуком, для cue якої в бібліотеці немає семпла (звучить тишею). */
export type SilentPlacement = EventPlacement & {
  cue: SoundCue;
  /** Семпл кадру події в треку. */
  at: number;
  beatIndex: number | null;
};

/**
 * Сітка долей зведення: після вирівнювання (`alignToBeatGrid`) доля k лежить на k·periodSec від
 * кадру 0. Без музики або без певної долі сітки немає.
 */
export interface BeatGrid {
  periodSec: number;
  /** Трек зсунуто по такту: на кадр 0 ліг downbeat, долі з k % 4 = 0 — сильні. */
  onBar: boolean;
}

/** Найближча доля сітки до семпла `at` (не раніше долі 0); null — сітки немає. */
export function nearestBeatIndex(at: number, grid: BeatGrid | null, sampleRate = SAMPLE_RATE): number | null {
  if (!grid || !(grid.periodSec > 0)) return null;
  return Math.max(0, Math.round(at / sampleRate / grid.periodSec));
}

export interface SoundtrackInput {
  /** Декодований трек ElevenLabs; null — лише шар подій. */
  music: StereoPcm | null;
  storyboard: Pick<Storyboard, "fps" | "scenes" | "musicBrief">;
  /** `AudioPlan.key` («A minor»); null або нерозпізнане — ля-мінорна пентатоніка. */
  key: string | null;
  /** Бібліотека семплів подій; cue без жодного придатного семпла — його події без звуку. */
  samples: SfxSampleLibrary;
}

export interface Soundtrack {
  /** Готовий мастер (44.1 кГц, стерео), довжина = відео. */
  pcm: StereoPcm;
  wav: Buffer;
  durationMs: number;
  /** Доріжки до мастера: музика (з автоматизацією й дакінгом), сухі події (після EQ) і повернення реверба. */
  stems: { music: StereoPcm; events: StereoPcm; reverb: StereoPcm };
  /** Підсилення нормалізації музики до RMS −14 dBFS (опора рівнів подій); без музики — 1. */
  masterGain: number;
  /** Мастер: підсилення суми до −14 LUFS, дБ; інтегральна гучність (LUFS) і true peak (dBTP) результату. */
  master: { gainDb: number; integratedLufs: number; truePeakDbtp: number };
  alignment: BeatAlignment | null;
  /** Сітка долей, за якою рахуються `beatIndex`; null — без музики або без певної долі. */
  beatGrid: BeatGrid | null;
  sounds: PlacedSound[];
  /** Події зі звуком, для cue яких у бібліотеці немає семпла (звучать тишею). */
  silent: SilentPlacement[];
}

/**
 * Вікно чутності за якорем cue (`SOUND_CUE_TRAITS.anchor`): end (riser) — 100 мс до кадру,
 * peak (whoosh/swoosh/swipe) — ±50 мс, onset — 100 мс від кадру.
 */
export function audibilityWindow(cue: SoundCue, at: number, sampleRate = SAMPLE_RATE): [number, number] {
  const w = secToSamples(WINDOW_SEC, sampleRate);
  const anchor = SOUND_CUE_TRAITS[cue].anchor;
  if (anchor === "end") return [at - w, at];
  if (anchor === "peak") return [at - Math.floor(w / 2), at + Math.ceil(w / 2)];
  return [at, at + w];
}

function peakIn(buf: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) p = Math.max(p, Math.abs(buf[i] ?? 0));
  return p;
}

/** Ступені cue з `pitch: "stepped"` (pop/ding): послідовні в одній сцені йдуть угору по пентатоніці. */
function scaleDegrees(placements: readonly EventPlacement[]): Map<EventPlacement, number> {
  const counters = new Map<string, number>();
  const out = new Map<EventPlacement, number>();
  for (const p of placements) {
    if (p.cue === null || SOUND_CUE_TRAITS[p.cue].pitch !== "stepped") continue;
    const n = counters.get(p.sceneId) ?? 0;
    out.set(p, n);
    counters.set(p.sceneId, n + 1);
  }
  return out;
}

/** Хеші варіантів бібліотеки по cue (у порядку варіантів) — для `soundtrackHash`. */
export function sampleHashes(samples: SfxSampleLibrary): Partial<Record<SoundCue, string[]>> {
  const out: Partial<Record<SoundCue, string[]>> = {};
  for (const cue of Object.keys(samples) as SoundCue[]) out[cue] = (samples[cue] ?? []).map((s) => s.hash);
  return out;
}

/**
 * EQ шини подій для одного звуку: фільтри лінійні й стаціонарні, тож фільтр кожного звуку окремо
 * = фільтр шини (стан з нуля, бо шина до першого звуку тиха). Після EQ — знову пік 1, щоб рівні
 * подій рахувались за тим, що звучить.
 */
function eventBusEq(sound: PreparedSound, sr: number): PreparedSound {
  const left = eqChannel(sound.left, sr, EVENT_BUS_EQ);
  const right = eqChannel(sound.right, sr, EVENT_BUS_EQ);
  let peak = 0;
  for (let i = 0; i < left.length; i++)
    peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  if (peak > 0) {
    for (let i = 0; i < left.length; i++) {
      left[i] = (left[i] as number) / peak;
      right[i] = (right[i] as number) / peak;
    }
  }
  return { left, right, anchor: sound.anchor };
}

/** Повне зведення саундтреку. Чиста функція: той самий вхід → побайтно той самий WAV. */
export function renderSoundtrack(input: SoundtrackInput): Soundtrack {
  const { storyboard } = input;
  const sr = input.music?.sampleRate ?? SAMPLE_RATE;
  const fps = storyboard.fps;
  const bpm = storyboard.musicBrief.bpm;
  const timeline = computeTimeline(storyboard);
  const total = frameToSample(timeline.totalFrames, fps, sr);

  // 1. Музика: долі на сітку → довжина відео → RMS −14 dBFS (до подій) → ширина стерео →
  // автоматизація частин і короткий fade закінчення (`ENDING_FADE_SEC`).
  let alignment: BeatAlignment | null = null;
  let beatGrid: BeatGrid | null = null;
  let music = createStereo(total, sr);
  let masterGain = 1;
  if (input.music && pcmLength(input.music) > 0) {
    let aligned = alignToBeatGrid(input.music, bpm, fps);
    // Певна доля → трек зсунуто на сітку; фаза такту оцінюється лише тоді, і з певним тактом зсув — по такту.
    const a0 = aligned.alignment;
    let onBar = a0.barConfidence !== null && a0.barConfidence >= MIN_BAR_CONFIDENCE;
    // Зсув на downbeat зрізає до такту з початку; якщо трек через це коротший за відео (старий
    // `music.wav` із запасом 1 с), лишається фаза долі — тиша в кінці гірша за старт не з такту.
    if (pcmLength(aligned.pcm) < total && aligned.alignment.shiftSamples > 0) {
      const a = aligned.alignment;
      const beatShift = beatShiftSamples(a.offsetSec, a.periodSec, sr);
      if (beatShift < a.shiftSamples) {
        aligned = { pcm: shiftPcm(input.music, beatShift), alignment: { ...a, shiftSamples: beatShift } };
        onBar = false;
      }
    }
    alignment = aligned.alignment;
    if (alignment.confidence >= MIN_BEAT_CONFIDENCE) beatGrid = { periodSec: alignment.periodSec, onBar };
    const fitted = fitLength(aligned.pcm, total);
    const rms = rmsOf(fitted);
    masterGain = rms > 0 ? Math.min(dbToGain(MASTER_MAX_GAIN_DB), dbToGain(MASTER_RMS_DBFS) / rms) : 1;
    for (let j = 0; j < total; j++) {
      fitted.left[j] = (fitted.left[j] as number) * masterGain;
      fitted.right[j] = (fitted.right[j] as number) * masterGain;
    }
    music = applyMixAutomation(widenMusic(fitted), mixSections(storyboard), { fps, bpm });
  }

  // 2. Події: семпл бібліотеки (варіанти по колу, висота — у тональності) через EQ шини, розміщення
  // за семантикою кадру, гучність відносно музики навколо (без музики — відносно −14 dBFS).
  const key = parseKey(input.key) ?? FALLBACK_KEY;
  const musicRms = rmsOf(music);
  const nominal = dbToGain(MASTER_RMS_DBFS);
  const floor = Math.max(musicRms * dbToGain(REF_FLOOR_REL_DB), dbToGain(REF_FLOOR_ABS_DB));
  const events = createStereo(total, sr);
  const library = prepareLibrary(input.samples);
  const withCue = computeEventPlacements(storyboard).filter(
    (p): p is EventPlacement & { cue: SoundCue } => p.cue !== null,
  );
  const silent: SilentPlacement[] = withCue
    .filter((p) => !library.has(p.cue))
    .map((p) => {
      const at = frameToSample(p.frame, fps, sr);
      return { ...p, at, beatIndex: nearestBeatIndex(at, beatGrid, sr) };
    });
  const placements = withCue.filter((p) => library.has(p.cue));
  const degrees = scaleDegrees(placements);
  const chosen = chooseVariants(placements, library);
  const shifts = pitchShifts(
    placements.map((p, i) => ({
      cue: p.cue,
      sceneId: p.sceneId,
      pitchHz: chosen[i]?.analysis.pitchHz ?? null,
    })),
    key,
  );
  const rendered = new Map<string, PreparedSound>();
  const sounds: Array<Omit<PlacedSound, "peakDb">> = [];
  for (const [idx, p] of placements.entries()) {
    const degree = degrees.get(p) ?? null;
    const entry = chosen[idx] as PreparedEntry;
    const semitones = shifts[idx] ?? 0;
    const renderKey = `${entry.sample.hash}:${entry.sample.variant}:${semitones}`;
    let sound = rendered.get(renderKey);
    if (!sound) {
      sound = eventBusEq(renderSample(entry.sample.pcm, entry.analysis, { semitones, sampleRate: sr }), sr);
      rendered.set(renderKey, sound);
    }
    const at = frameToSample(p.frame, fps, sr);
    const start = at - sound.anchor;
    const window = audibilityWindow(p.cue, at, sr);
    const ctx = secToSamples(CONTEXT_SEC, sr);
    const ref =
      musicRms > 0
        ? Math.max(rmsOf(music, window[0], window[1]), rmsOf(music, at - ctx, at + ctx), floor)
        : nominal;
    const target = ref * dbToGain(Math.min(MAX_CUE_DB, CUE_LEVEL_DB[p.cue] + ACCENT_DB[p.accent]));
    // Звук нормалізований до піку 1; якщо його пік поза вікном — підтягуємо вікно до цілі (≤ +3.5 дБ).
    const inWindow = Math.max(
      peakIn(sound.left, window[0] - start, window[1] - start),
      peakIn(sound.right, window[0] - start, window[1] - start),
    );
    const gain = target * Math.min(MAX_WINDOW_BOOST, inWindow > 0 ? 1 / inWindow : 1);
    for (let i = 0; i < sound.left.length; i++) {
      const j = start + i;
      if (j < 0) continue;
      if (j >= total) break;
      events.left[j] = (events.left[j] ?? 0) + (sound.left[i] ?? 0) * gain;
      events.right[j] = (events.right[j] ?? 0) + (sound.right[i] ?? 0) * gain;
    }
    sounds.push({
      sceneId: p.sceneId,
      eventId: p.eventId,
      cue: p.cue,
      accent: p.accent,
      frame: p.frame,
      degree,
      variant: entry.sample.variant,
      sampleHash: entry.sample.hash,
      semitones,
      at,
      start,
      window,
      gain,
      gainDb: gainToDb(gain),
      beatIndex: nearestBeatIndex(at, beatGrid, sr),
      ducked: SOUND_CUE_TRAITS[p.cue].hit || SOUND_CUE_TRAITS[p.cue].anchor === "end",
    });
  }

  // 3. Музичний дакінг: HPF на музиці — на долю після важкого удару і відкриття до кадру riser.
  const ducks: MusicDuck[] = [];
  for (const s of sounds) {
    if (!s.ducked) continue;
    if (SOUND_CUE_TRAITS[s.cue].hit) ducks.push({ kind: "beat", at: s.at });
    else ducks.push({ kind: "riser", from: Math.max(0, s.start), at: s.at });
  }
  if (musicRms > 0) {
    music = duckMusic(music, ducks, { beatSamples: frameToSample(beatFrames(bpm, fps), fps, sr) });
  }

  // 4. Спільний реверб: посил подій 0.25 і музики 0.08 в один простір.
  const send = createStereo(total, sr);
  for (let j = 0; j < total; j++) {
    send.left[j] =
      (events.left[j] as number) * REVERB_SEND.events + (music.left[j] as number) * REVERB_SEND.music;
    send.right[j] =
      (events.right[j] as number) * REVERB_SEND.events + (music.right[j] as number) * REVERB_SEND.music;
  }
  const reverb = applyReverb(send);

  // 5. Мастер: сума музики, подій і реверба → −14 LUFS і true-peak лімітер (`masterize`).
  const sum = createStereo(total, sr);
  for (let j = 0; j < total; j++) {
    sum.left[j] = (music.left[j] as number) + (events.left[j] as number) + (reverb.left[j] as number);
    sum.right[j] = (music.right[j] as number) + (events.right[j] as number) + (reverb.right[j] as number);
  }
  const master = masterize(sum, { sampleRate: sr });

  return {
    pcm: master.pcm,
    wav: encodeWav(master.pcm),
    durationMs: framesToMs(timeline.totalFrames, fps),
    stems: { music, events, reverb },
    masterGain,
    master: {
      gainDb: master.gainDb,
      integratedLufs: master.integratedLufs,
      truePeakDbtp: master.truePeakDbtp,
    },
    alignment,
    beatGrid,
    sounds: sounds.map((s) => ({ ...s, peakDb: s.gainDb + master.gainDb })),
    silent,
  };
}

/**
 * Хеш повторного використання зведення: трек (`planHash`), тональність, темп і `mix` частин,
 * таймлайн сцен, усі події з кадрами й звуком, хеші варіантів семплів використаних cue
 * (у порядку варіантів — від нього залежить ротація), плюс версія алгоритму (`version` — лише
 * для перевірки, що зміна версії інвалідує кеш).
 */
export function soundtrackHash(
  input: {
    planHash: string;
    key: string | null;
    storyboard: Pick<Storyboard, "fps" | "scenes" | "musicBrief">;
    /** Хеші варіантів бібліотеки по cue (`sampleHashes`). */
    samples: Partial<Record<SoundCue, readonly string[]>>;
  },
  version: number = MIX_VERSION,
): string {
  const { storyboard } = input;
  const timeline = computeTimeline(storyboard);
  const placements = computeEventPlacements(storyboard);
  const used = [...new Set(placements.map((p) => p.cue).filter((c): c is SoundCue => c !== null))].sort();
  return inputsHash({
    version,
    planHash: input.planHash,
    key: input.key,
    bpm: storyboard.musicBrief.bpm,
    structure: storyboard.musicBrief.structure.map((p) => ({ sceneIds: p.sceneIds, mix: p.mix })),
    timeline: {
      fps: timeline.fps,
      totalFrames: timeline.totalFrames,
      scenes: timeline.scenes.map((s) => ({ id: s.id, from: s.from, durationInFrames: s.durationInFrames })),
    },
    events: placements,
    samples: Object.fromEntries(used.map((cue) => [cue, [...(input.samples[cue] ?? [])]])),
  });
}
