/**
 * Тональність треку (`AudioPlan.key`) і пентатоніка, у яку зведення строїть тональні cue
 * (`PITCHED_SOUND_CUES`). Якщо тональність не задана або не розпізнана — ля-мінорна пентатоніка.
 */

export interface MusicalKey {
  /** Висотний клас тоніки: C = 0 … B = 11. */
  root: number;
  minor: boolean;
}

/** Ля мінор — коли тональність не задана або не розпізнана. */
export const FALLBACK_KEY: MusicalKey = { root: 9, minor: true };

const NOTE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** «A minor», «F# major», «Bb minor», «Am», «D dorian» → тоніка і лад; null — не розпізнано. */
export function parseKey(key: string | null | undefined): MusicalKey | null {
  const m = /^\s*([A-Ga-g])([#♯b♭]?)\s*(.*)$/u.exec(key ?? "");
  if (!m) return null;
  const [, letter = "", accidental = "", rest = ""] = m;
  const base = NOTE[letter.toLowerCase()];
  if (base === undefined) return null;
  const shift =
    accidental === "#" || accidental === "♯" ? 1 : accidental === "b" || accidental === "♭" ? -1 : 0;
  const mode = rest.trim().toLowerCase();
  if (
    mode &&
    !/^(m|maj|major|min|minor|ionian|dorian|phrygian|lydian|mixolydian|aeolian|locrian)\b/.test(mode)
  ) {
    return null;
  }
  const minor = /^(m\b|min|minor|dorian|phrygian|aeolian|locrian)/.test(mode) && !/^maj/.test(mode);
  return { root: (base + shift + 12) % 12, minor };
}

/** Пентатоніка тональності: інтервали від тоніки (без півтонових тертів із будь-яким акордом ладу). */
export const pentatonic = (key: MusicalKey): readonly number[] =>
  key.minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];

/** Частота ступеня пентатоніки: `degree` 0, 1, 2… йде вгору (через октави), від тоніки в `octave`. */
export function scaleFrequency(key: MusicalKey, degree: number, octave: number): number {
  const scale = pentatonic(key);
  const d = Math.max(0, Math.floor(degree));
  const step = scale[d % scale.length] ?? 0;
  const midi = 12 * (octave + 1) + key.root + step + 12 * Math.floor(d / scale.length);
  return midiToHz(midi);
}

/** Гц → номер MIDI (дробовий): A4 = 440 Гц = 69. */
export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Чи належить нота (ціле MIDI) пентатоніці тональності. */
export function isScaleNote(key: MusicalKey, midi: number): boolean {
  const pc = (((Math.round(midi) - key.root) % 12) + 12) % 12;
  return pentatonic(key).includes(pc);
}

/** Найближча до `midi` нота пентатоніки (ціле MIDI); за рівної відстані — нижча. */
export function nearestScaleNote(key: MusicalKey, midi: number): number {
  const base = Math.round(midi);
  for (let d = 0; d <= 6; d++) {
    const below = base - d;
    const above = base + d;
    const candidates = [below, above]
      .filter((n) => isScaleNote(key, n))
      .sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi) || a - b);
    if (candidates.length > 0) return candidates[0] as number;
  }
  return base;
}

/** Нота пентатоніки на `steps` ступенів вище за `from` (сама `from` — у звукоряді). */
export function scaleStep(key: MusicalKey, from: number, steps: number): number {
  let n = Math.round(from);
  for (let s = 0; s < Math.max(0, Math.floor(steps)); s++) {
    n++;
    while (!isScaleNote(key, n)) n++;
  }
  return n;
}
