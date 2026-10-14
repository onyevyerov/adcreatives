import { SoundCue } from "./schemas/storyboard.ts";

/**
 * Поведінка кожного `SoundCue` в одному місці: нормалізація розкадровки (сітка, ліміт ударів), зведення
 * (якір, рівень, дакінг, висота, стерео), вибір варіантів і QC семплів беруть її звідси.
 */
export interface SoundCueTraits {
  /** Що лягає на кадр події: onset — початок звуку; peak — пік огинаючої; end — кінець наростання (riser). */
  anchor: "onset" | "peak" | "end";
  /** normalize підтягує подію до найближчої восьмої; false — звук іде за анімацією. */
  grid: boolean;
  /** Важкий структурний удар: ліміт на ролик (`limitHits`), моно, дакінг музики на долю. */
  hit: boolean;
  /** none — висота не чіпається; tuned — строїться в тональність; stepped — ще й іде вгору в сцені. */
  pitch: "none" | "tuned" | "stepped";
  /** mono — повністю моно; normal — моно нижче 150 Гц, QC кореляції ≥ 0.3; wide — QC ≥ −0.2. */
  stereo: "mono" | "normal" | "wide";
  /** Пік події над RMS музики у вікні, дБ (до акценту). */
  levelDb: number;
  /** QC: onset не пізніше, мс. */
  maxOnsetMs: number;
  /** Скільки звуку може бути до якоря (лише peak/end), с; для onset — 0. */
  maxPreAnchorSec: number;
  /** Один варіант на сцену (мелодія сцени одним тембром). */
  perScene: boolean;
}

/** Типовий cue: стартує з кадру, на сітці, без тону, моно лише низ. */
const cue = (t: Partial<SoundCueTraits> & Pick<SoundCueTraits, "levelDb">): SoundCueTraits => ({
  anchor: "onset",
  grid: true,
  hit: false,
  pitch: "none",
  stereo: "normal",
  maxOnsetMs: 50,
  maxPreAnchorSec: 0,
  perScene: false,
  ...t,
});

export const SOUND_CUE_TRAITS: Readonly<Record<SoundCue, SoundCueTraits>> = {
  whoosh: cue({ anchor: "peak", stereo: "wide", levelDb: 0, maxPreAnchorSec: 1 }),
  swoosh: cue({ anchor: "peak", stereo: "wide", levelDb: 0, maxPreAnchorSec: 1 }),
  riser: cue({ anchor: "end", stereo: "wide", levelDb: 2, maxOnsetMs: 400, maxPreAnchorSec: 2 }),
  impact: cue({ hit: true, stereo: "mono", levelDb: 5 }),
  slam: cue({ hit: true, stereo: "mono", levelDb: 5 }),
  pop: cue({ pitch: "stepped", levelDb: -2, perScene: true }),
  ding: cue({ pitch: "stepped", levelDb: -2, perScene: true }),
  shimmer: cue({ pitch: "tuned", levelDb: -2 }),
  tick: cue({ grid: false, levelDb: -4 }),
  click: cue({ grid: false, levelDb: -4 }),
  drop: cue({ hit: true, stereo: "mono", levelDb: 4 }),
  error: cue({ levelDb: -2 }),
  alert: cue({ levelDb: -2 }),
  glitch: cue({ stereo: "wide", levelDb: -2 }),
  scratch: cue({ levelDb: 0 }),
  typing: cue({ grid: false, levelDb: -4 }),
  notify: cue({ pitch: "tuned", levelDb: -2 }),
  scan: cue({ grid: false, stereo: "wide", levelDb: -4, maxOnsetMs: 150 }),
  swipe: cue({ anchor: "peak", stereo: "wide", levelDb: -2, maxPreAnchorSec: 0.5 }),
  success: cue({ pitch: "tuned", levelDb: -2 }),
  shutter: cue({ levelDb: -3 }),
  scribble: cue({ grid: false, levelDb: -4 }),
  flip: cue({ levelDb: -4 }),
  slide: cue({ grid: false, levelDb: -3 }),
  cash: cue({ levelDb: -2 }),
  lock: cue({ levelDb: -3 }),
  zap: cue({ levelDb: -2 }),
  snap: cue({ levelDb: -3 }),
  bounce: cue({ levelDb: -2 }),
  cheer: cue({ stereo: "wide", levelDb: -4, maxOnsetMs: 150 }),
};

const cuesWhere = (pred: (t: SoundCueTraits) => boolean): ReadonlySet<SoundCue> =>
  new Set(SoundCue.options.filter((c) => pred(SOUND_CUE_TRAITS[c])));

/** Похідні набори для споживачів (обчислюються з таблиці, не задаються вручну). */
export const HIT_SOUND_CUES: ReadonlySet<SoundCue> = cuesWhere((t) => t.hit);
export const GRID_SOUND_CUES: ReadonlySet<SoundCue> = cuesWhere((t) => t.grid);
/** Тональні cue: tuned + stepped. */
export const PITCHED_SOUND_CUES: ReadonlySet<SoundCue> = cuesWhere((t) => t.pitch !== "none");
