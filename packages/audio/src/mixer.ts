import {
  computeEventPlacements,
  computeTimeline,
  type EventPlacement,
  framesToMs,
  inputsHash,
  type SoundAccent,
  type SoundCue,
  type Storyboard,
} from "@adc/shared";
import { applyMixAutomation, mixSections } from "./automation.ts";
import { alignToBeatGrid, type BeatAlignment } from "./beat.ts";
import { FALLBACK_KEY, parseKey } from "./key.ts";
import {
  createStereo,
  dbToGain,
  fitLength,
  frameToSample,
  pcmLength,
  rmsOf,
  SAMPLE_RATE,
  type StereoPcm,
  secToSamples,
} from "./pcm.ts";
import {
  analyzeSample,
  type PreparedSound,
  pitchShifts,
  renderSample,
  type SampleAnalysis,
  type SfxSample,
  type SfxSampleLibrary,
} from "./samples.ts";
import { encodeWav } from "./wav.ts";

/**
 * Зведення: музика (вирівняна по долі, з автоматизацією частин) + звуки подій з бібліотеки SFX
 * (ElevenLabs) за спільним таймлайном + дакінг + мастер. Результат — `soundtrack.wav`, який хост
 * грає замість музики й SFX.
 */

/** Версія алгоритму зведення: входить у хеш повторного використання. */
export const MIX_VERSION = 2;

/** Мастер: RMS ≈ −14 dBFS, м'який кліпер від −6 dBFS, пік ≤ −1 dBFS. */
export const MASTER_RMS_DBFS = -14;
export const MASTER_CEILING_DBFS = -1;
const MASTER_KNEE_DBFS = -6;
/** Максимальне підсилення мастера (тиха музика не стає шумом). */
const MASTER_MAX_GAIN_DB = 24;
/** Fade-out музики в останню секунду ролика і короткий антиклік мастера. */
export const MUSIC_TAIL_FADE_SEC = 1;
const MASTER_END_FADE_SEC = 0.01;

/** Пік події над RMS музики навколо неї, дБ (поріг чутності +6 дБ, тож усі з запасом). */
export const CUE_LEVEL_DB: Record<SoundCue, number> = {
  impact: 15,
  slam: 15,
  riser: 12,
  whoosh: 11,
  swoosh: 10,
  pop: 11,
  ding: 11,
  shimmer: 10,
  tick: 10,
  click: 10,
};
export const ACCENT_DB: Record<SoundAccent, number> = { soft: -2, normal: 0, hard: 3 };

/** Дакінг музики: × (1 − d·e^(−t/τ)) після impact/slam і кінця riser. */
export const DUCK_DEPTH: Record<SoundAccent, number> = { soft: 0.45, normal: 0.55, hard: 0.6 };
export const DUCK_TAU_SEC = 0.15;
const DUCK_ATTACK_SEC = 0.005;
const DUCK_CUES: ReadonlySet<SoundCue> = new Set(["impact", "slam", "riser"]);

/** Вікно чутності події (100 мс навколо моменту, коли її видно) і ширше вікно для опори гучності. */
const WINDOW_SEC = 0.1;
const CONTEXT_SEC = 0.2;
/** Нижня межа опорного рівня: −12 дБ від середнього RMS музики, абсолютна — −40 dBFS. */
const REF_FLOOR_REL_DB = -12;
const REF_FLOOR_ABS_DB = -40;
/** Подія не гучніша за свою ціль більш ніж на 8 дБ (коли пік звуку поза вікном). */
const MAX_WINDOW_BOOST = 2.5;

export interface PlacedSound {
  sceneId: string;
  eventId: string;
  cue: SoundCue;
  accent: SoundAccent;
  frame: number;
  /** Ступінь пентатоніки для pop/ding (у сцені йдуть угору), інакше null. */
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
  /** Доріжки до мастера: музика (з автоматизацією й дакінгом) і події. */
  stems: { music: StereoPcm; events: StereoPcm };
  masterGain: number;
  alignment: BeatAlignment | null;
  sounds: PlacedSound[];
  /** Події зі звуком, для cue яких у бібліотеці немає семпла (звучать тишею). */
  silent: EventPlacement[];
}

/** Вікно чутності: riser — 100 мс до кадру, whoosh/swoosh — ±50 мс, решта — 100 мс від кадру. */
export function audibilityWindow(cue: SoundCue, at: number, sampleRate = SAMPLE_RATE): [number, number] {
  const w = secToSamples(WINDOW_SEC, sampleRate);
  if (cue === "riser") return [at - w, at];
  if (cue === "whoosh" || cue === "swoosh") return [at - Math.floor(w / 2), at + Math.ceil(w / 2)];
  return [at, at + w];
}

function peakIn(buf: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(buf.length, to); i++) p = Math.max(p, Math.abs(buf[i] ?? 0));
  return p;
}

/** Ступені pop/ding: послідовні в одній сцені йдуть угору по пентатоніці. */
function scaleDegrees(placements: readonly EventPlacement[]): Map<EventPlacement, number> {
  const counters = new Map<string, number>();
  const out = new Map<EventPlacement, number>();
  for (const p of placements) {
    if (p.cue !== "pop" && p.cue !== "ding") continue;
    const n = counters.get(p.sceneId) ?? 0;
    out.set(p, n);
    counters.set(p.sceneId, n + 1);
  }
  return out;
}

interface PreparedEntry {
  sample: SfxSample;
  analysis: SampleAnalysis;
}

/** Аналіз варіантів кожного cue (порожні й тихі семпли відкидаються); cue без варіантів — немає в мапі. */
function prepareLibrary(samples: SfxSampleLibrary): Map<SoundCue, PreparedEntry[]> {
  const out = new Map<SoundCue, PreparedEntry[]>();
  for (const cue of Object.keys(samples).sort() as SoundCue[]) {
    const entries: PreparedEntry[] = [];
    for (const sample of samples[cue] ?? []) {
      const analysis = analyzeSample(cue, sample.pcm);
      if (analysis) entries.push({ sample, analysis });
    }
    if (entries.length > 0) out.set(cue, entries);
  }
  return out;
}

/** Хеші варіантів бібліотеки по cue (у порядку варіантів) — для `soundtrackHash`. */
export function sampleHashes(samples: SfxSampleLibrary): Partial<Record<SoundCue, string[]>> {
  const out: Partial<Record<SoundCue, string[]>> = {};
  for (const cue of Object.keys(samples) as SoundCue[]) out[cue] = (samples[cue] ?? []).map((s) => s.hash);
  return out;
}

const softClip = (x: number, knee: number, ceiling: number) => {
  const a = Math.abs(x);
  if (a <= knee) return x;
  return Math.sign(x) * (knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee)));
};

/** Повне зведення саундтреку. Чиста функція: той самий вхід → побайтно той самий WAV. */
export function renderSoundtrack(input: SoundtrackInput): Soundtrack {
  const { storyboard } = input;
  const sr = input.music?.sampleRate ?? SAMPLE_RATE;
  const fps = storyboard.fps;
  const bpm = storyboard.musicBrief.bpm;
  const timeline = computeTimeline(storyboard);
  const total = frameToSample(timeline.totalFrames, fps, sr);

  // 1. Музика: долі на сітку → довжина відео → автоматизація частин і fade-out останньої секунди.
  let alignment: BeatAlignment | null = null;
  let music = createStereo(total, sr);
  if (input.music && pcmLength(input.music) > 0) {
    const aligned = alignToBeatGrid(input.music, bpm, fps);
    alignment = aligned.alignment;
    music = applyMixAutomation(fitLength(aligned.pcm, total), mixSections(storyboard), {
      fps,
      bpm,
      fadeOutSamples: secToSamples(MUSIC_TAIL_FADE_SEC, sr),
    });
  }

  // 2. Події: семпл бібліотеки (варіанти по колу, висота — у тональності), розміщення
  // за семантикою кадру, гучність відносно музики навколо.
  const key = parseKey(input.key) ?? FALLBACK_KEY;
  const musicRms = rmsOf(music);
  const floor = Math.max(musicRms * dbToGain(REF_FLOOR_REL_DB), dbToGain(REF_FLOOR_ABS_DB));
  const events = createStereo(total, sr);
  const library = prepareLibrary(input.samples);
  const withCue = computeEventPlacements(storyboard).filter(
    (p): p is EventPlacement & { cue: SoundCue } => p.cue !== null,
  );
  const silent = withCue.filter((p) => !library.has(p.cue));
  const placements = withCue.filter((p) => library.has(p.cue));
  const degrees = scaleDegrees(placements);
  const rotation = new Map<SoundCue, number>();
  const chosen = placements.map((p) => {
    const variants = library.get(p.cue) ?? [];
    const n = rotation.get(p.cue) ?? 0;
    rotation.set(p.cue, n + 1);
    return variants[n % variants.length] as PreparedEntry;
  });
  const shifts = pitchShifts(
    placements.map((p, i) => ({
      cue: p.cue,
      sceneId: p.sceneId,
      pitchHz: chosen[i]?.analysis.pitchHz ?? null,
    })),
    key,
  );
  const rendered = new Map<string, PreparedSound>();
  const sounds: PlacedSound[] = [];
  for (const [idx, p] of placements.entries()) {
    const degree = degrees.get(p) ?? null;
    const entry = chosen[idx] as PreparedEntry;
    const semitones = shifts[idx] ?? 0;
    const renderKey = `${entry.sample.hash}:${entry.sample.variant}:${semitones}`;
    let sound = rendered.get(renderKey);
    if (!sound) {
      sound = renderSample(entry.sample.pcm, entry.analysis, { semitones, sampleRate: sr });
      rendered.set(renderKey, sound);
    }
    const at = frameToSample(p.frame, fps, sr);
    const start = at - sound.anchor;
    const window = audibilityWindow(p.cue, at, sr);
    const ctx = secToSamples(CONTEXT_SEC, sr);
    const ref = Math.max(rmsOf(music, window[0], window[1]), rmsOf(music, at - ctx, at + ctx), floor);
    const target = ref * dbToGain(CUE_LEVEL_DB[p.cue] + ACCENT_DB[p.accent]);
    // Звук нормалізований до піку 1; якщо його пік поза вікном — підтягуємо вікно до цілі (≤ +8 дБ).
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
    });
  }

  // 3. Дакінг музики після impact/slam і кінця riser.
  const duck = new Float32Array(total).fill(1);
  const attackN = Math.max(1, secToSamples(DUCK_ATTACK_SEC, sr));
  const tauN = DUCK_TAU_SEC * sr;
  for (const s of sounds) {
    if (!DUCK_CUES.has(s.cue)) continue;
    const d = DUCK_DEPTH[s.accent];
    const end = Math.min(total, s.at + Math.ceil(5 * tauN));
    for (let j = Math.max(0, s.at); j < end; j++) {
      const t = j - s.at;
      const shape = Math.min(1, t / attackN) * Math.exp(-Math.max(0, t - attackN) / tauN);
      const g = 1 - d * shape;
      if (g < (duck[j] ?? 1)) duck[j] = g;
    }
  }
  for (let j = 0; j < total; j++) {
    const g = duck[j] ?? 1;
    music.left[j] = (music.left[j] ?? 0) * g;
    music.right[j] = (music.right[j] ?? 0) * g;
  }

  // 4. Мастер: сума → RMS −14 dBFS → м'який кліпер (пік < −1 dBFS) → антиклік у кінці.
  const sum = createStereo(total, sr);
  for (let j = 0; j < total; j++) {
    sum.left[j] = (music.left[j] ?? 0) + (events.left[j] ?? 0);
    sum.right[j] = (music.right[j] ?? 0) + (events.right[j] ?? 0);
  }
  const rms = rmsOf(sum);
  const masterGain = rms > 0 ? Math.min(dbToGain(MASTER_MAX_GAIN_DB), dbToGain(MASTER_RMS_DBFS) / rms) : 1;
  const knee = dbToGain(MASTER_KNEE_DBFS);
  const ceiling = dbToGain(MASTER_CEILING_DBFS);
  const endFade = Math.min(total, secToSamples(MASTER_END_FADE_SEC, sr));
  for (let j = 0; j < total; j++) {
    const tail = j >= total - endFade ? (total - 1 - j) / Math.max(1, endFade) : 1;
    sum.left[j] = softClip((sum.left[j] ?? 0) * masterGain, knee, ceiling) * tail;
    sum.right[j] = softClip((sum.right[j] ?? 0) * masterGain, knee, ceiling) * tail;
  }

  return {
    pcm: sum,
    wav: encodeWav(sum),
    durationMs: framesToMs(timeline.totalFrames, fps),
    stems: { music, events },
    masterGain,
    alignment,
    sounds,
    silent,
  };
}

/**
 * Хеш повторного використання зведення: трек (`planHash`), тональність, темп і `mix` частин,
 * таймлайн сцен, усі події з кадрами й звуком, хеші варіантів семплів використаних cue
 * (у порядку варіантів — від нього залежить ротація), плюс версія алгоритму.
 */
export function soundtrackHash(input: {
  planHash: string;
  key: string | null;
  storyboard: Pick<Storyboard, "fps" | "scenes" | "musicBrief">;
  /** Хеші варіантів бібліотеки по cue (`sampleHashes`). */
  samples: Partial<Record<SoundCue, readonly string[]>>;
}): string {
  const { storyboard } = input;
  const timeline = computeTimeline(storyboard);
  const placements = computeEventPlacements(storyboard);
  const used = [...new Set(placements.map((p) => p.cue).filter((c): c is SoundCue => c !== null))].sort();
  return inputsHash({
    version: MIX_VERSION,
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
