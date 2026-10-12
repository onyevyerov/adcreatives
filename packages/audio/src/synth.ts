import type { SoundCue } from "@adc/shared";
import { Svf } from "./dsp.ts";
import { SAMPLE_RATE } from "./pcm.ts";

/**
 * Шар звукових подій: синтез кожного `SoundCue` кодом. Детерміновано — шум з власного PRNG
 * з фіксованим зерном (плюс хеш id події), тож той самий вхід дає побайтно той самий звук.
 * pop/ding/shimmer — у тональності треку (`AudioPlan.key`), інакше в ля-мінорній пентатоніці.
 */

/** Базове зерно PRNG синтезу. */
export const SYNTH_SEED = 0x0adc5eed;

/** mulberry32: детермінований PRNG, [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32 біт — зерно з рядка. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface CueSound {
  left: Float32Array;
  right: Float32Array;
  /** Семпл, що має припасти на кадр події: 0 — старт, пік для whoosh/swoosh, кінець для riser. */
  anchor: number;
}

export interface SynthOptions {
  key: MusicalKey;
  /** Ступінь пентатоніки для pop/ding (послідовні в сцені — угору). */
  degree: number;
  /** Довжина долі, с (riser триває дві долі в межах 0.8–2 с). */
  beatSec: number;
  /** Зерно шуму (детерміноване). */
  seed: number;
  sampleRate?: number;
}

type Voice = (t: number, i: number) => [number, number];

function render(durSec: number, sampleRate: number, anchorSec: number, voice: Voice): CueSound {
  const n = Math.max(1, Math.round(durSec * sampleRate));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const [l, r] = voice(i / sampleRate, i);
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  // Кожен звук нормалізований до піку 1: гучність задає зведення.
  if (peak > 0) {
    for (let i = 0; i < n; i++) {
      left[i] = (left[i] ?? 0) / peak;
      right[i] = (right[i] ?? 0) / peak;
    }
  }
  return { left, right, anchor: Math.min(n, Math.round(anchorSec * sampleRate)) };
}

/** Рівнопотужне панорамування: p від −1 (ліво) до 1 (право). */
const pan = (x: number, p: number): [number, number] => {
  const a = ((p + 1) * Math.PI) / 4;
  return [x * Math.cos(a), x * Math.sin(a)];
};

/** Атака без клацання. */
const attack = (t: number, sec: number) => (t >= sec ? 1 : t / sec);

/** Генератор синуса з накопиченням фази (для глісандо). */
function oscillator(sampleRate: number) {
  let phase = 0;
  return (freq: number) => {
    const v = Math.sin(phase);
    phase += (2 * Math.PI * freq) / sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    return v;
  };
}

/** Звук події. Повертає нормалізований до піку 1 стерео-буфер і точку прив'язки до кадру. */
export function synthCue(cue: SoundCue, opts: SynthOptions): CueSound {
  const sr = opts.sampleRate ?? SAMPLE_RATE;
  const rand = mulberry32((SYNTH_SEED ^ opts.seed ^ hashString(cue)) >>> 0);
  const noise = () => rand() * 2 - 1;
  switch (cue) {
    case "whoosh": {
      // Смуговий шум: наростання до піку (на кадрі події), центр смуги йде вгору й назад, ліво → право.
      const dur = 0.65;
      const peakAt = 0.4;
      const f = new Svf();
      return render(dur, sr, peakAt, (t) => {
        const env = t < peakAt ? (t / peakAt) ** 3 : Math.exp(-(t - peakAt) / 0.07);
        const fc = 350 + 2600 * (t < peakAt ? t / peakAt : Math.exp(-(t - peakAt) / 0.12));
        f.process(noise(), fc, 1.4, sr);
        return pan(f.band * env, -0.8 + (1.6 * t) / dur);
      });
    }
    case "swoosh": {
      // М'якший і нижчий за whoosh, симетрична огинаюча з піком на кадрі події, право → ліво.
      const dur = 0.45;
      const peakAt = 0.24;
      const f = new Svf();
      return render(dur, sr, peakAt, (t) => {
        const x = t < peakAt ? t / peakAt : 1 - (t - peakAt) / (dur - peakAt);
        const env = Math.sin((Math.PI / 2) * Math.max(0, x)) ** 2;
        const fc = 500 + 1300 * Math.max(0, x);
        f.process(noise(), fc, 0.8, sr);
        return pan(f.low * env, 0.5 - (1.0 * t) / dur);
      });
    }
    case "riser": {
      // Шум зі смугою, що росте на 3 октави, + синус на 2 октави; обривається на кадрі події.
      const dur = Math.min(2, Math.max(0.8, 2 * opts.beatSec));
      const f = new Svf();
      const osc = oscillator(sr);
      return render(dur, sr, dur, (t) => {
        const x = t / dur;
        const env = x ** 2 * Math.min(1, (dur - t) / 0.006);
        f.process(noise(), 300 * 2 ** (3 * x), 2, sr);
        const tone = osc(220 * 2 ** (2 * x));
        const v = (f.band * 1.2 + tone * 0.35) * env;
        return [v * (1 - 0.15 * x), v * (0.85 + 0.15 * x)];
      });
    }
    case "impact": {
      // Глибокий удар: синус 150 → 45 Гц з довгим хвостом + короткий шумовий транзієнт.
      const f = new Svf();
      const osc = oscillator(sr);
      return render(1.1, sr, 0, (t) => {
        const body = osc(45 + 105 * Math.exp(-t / 0.04)) * Math.exp(-t / 0.35);
        f.process(noise(), 2000, 0.7, sr);
        const hit = f.low * Math.exp(-t / 0.015) * 0.8;
        const v = Math.tanh(1.6 * (body + hit) * attack(t, 0.001));
        return [v, v];
      });
    }
    case "slam": {
      // Жорсткіше й середніше за impact: тріск смугового шуму + щільний низ, з перевантаженням.
      const f = new Svf();
      const osc = oscillator(sr);
      return render(0.75, sr, 0, (t) => {
        const body = osc(55 + 60 * Math.exp(-t / 0.03)) * Math.exp(-t / 0.18);
        f.process(noise(), 1200, 0.7, sr);
        const crack = f.band * Math.exp(-t / 0.045) * 1.6;
        const v = Math.tanh(2.5 * (body + crack) * attack(t, 0.0005));
        return [v, v];
      });
    }
    case "pop": {
      // Короткий тональний «поп»: падіння висоти в ступінь пентатоніки (5-та октава).
      const f0 = scaleFrequency(opts.key, opts.degree, 5);
      const osc = oscillator(sr);
      return render(0.2, sr, 0, (t) => {
        const v = osc(f0 * (1 + 1.2 * Math.exp(-t / 0.012))) * Math.exp(-t / 0.045) * attack(t, 0.001);
        return [v, v];
      });
    }
    case "ding": {
      // Дзвіночок: гармонійні партіали з різними загасаннями, тоніка — ступінь пентатоніки.
      const f0 = scaleFrequency(opts.key, opts.degree, 5);
      const partials = [
        { ratio: 1, amp: 1, tau: 0.6 },
        { ratio: 2, amp: 0.5, tau: 0.35 },
        { ratio: 3, amp: 0.22, tau: 0.2 },
        { ratio: 4.2, amp: 0.1, tau: 0.12 },
      ];
      return render(1.2, sr, 0, (t) => {
        let v = 0;
        for (const p of partials)
          v += p.amp * Math.sin(2 * Math.PI * f0 * p.ratio * t) * Math.exp(-t / p.tau);
        v *= attack(t, 0.002);
        return [v, v];
      });
    }
    case "tick": {
      const f = new Svf();
      return render(0.07, sr, 0, (t) => {
        f.process(noise(), 6000, 0.8, sr);
        const v =
          (Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t / 0.006) + f.high * 0.5 * Math.exp(-t / 0.003)) *
          attack(t, 0.0003);
        return [v, v];
      });
    }
    case "click": {
      const f = new Svf();
      return render(0.05, sr, 0, (t) => {
        f.process(noise(), 2500, 1.5, sr);
        const v =
          (f.band * Math.exp(-t / 0.004) + 0.5 * Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.01)) *
          attack(t, 0.0003);
        return [v, v];
      });
    }
    case "shimmer": {
      // Арпеджіо пентатоніки в 6-й октаві вгору, з тремоло і розкиданим стерео.
      const notes = Array.from({ length: 6 }, (_, i) => ({
        freq: scaleFrequency(opts.key, i, 6),
        start: i * 0.035 + rand() * 0.01,
        pan: i % 2 === 0 ? -0.5 : 0.5,
      }));
      return render(1.4, sr, 0, (t) => {
        let l = 0;
        let r = 0;
        for (const n of notes) {
          const dt = t - n.start;
          if (dt < 0) continue;
          const v =
            (Math.sin(2 * Math.PI * n.freq * dt) + 0.3 * Math.sin(4 * Math.PI * n.freq * dt)) *
            Math.exp(-dt / 0.5) *
            attack(dt, 0.01);
          const [pl, pr] = pan(v, n.pan);
          l += pl;
          r += pr;
        }
        const trem = 1 + 0.25 * Math.sin(2 * Math.PI * 7 * t);
        return [l * trem, r * trem];
      });
    }
  }
}
