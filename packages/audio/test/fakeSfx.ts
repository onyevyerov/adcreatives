import { SOUND_CUE_TRAITS, SoundCue } from "@adc/shared";
import { createStereo, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";
import type { SfxSample, SfxSampleLibrary } from "../src/samples.ts";
import { mulberry32 } from "./signals.ts";

/**
 * Фейкова бібліотека SFX для тестів: спрощений синтез кожного `SoundCue` кодом замість файлів
 * ElevenLabs. Як справжні файли — з тишею на початку (і ледь чутним шумом), з хвостами;
 * зведення має саме обрізати тишу й поставити якір на кадр.
 */

/** Тиша на початку кожного фейкового семпла. */
export const FAKE_LEAD_SEC = 0.04;
/** Пік огинаючої від початку звуку (без тиші): whoosh/swoosh — посередині, riser — у кінці наростання. */
export const FAKE_PEAK_SEC: Partial<Record<SoundCue, number>> = { whoosh: 0.4, swoosh: 0.24, riser: 1.2 };
/** Хвіст riser після піку (його зведення має відрізати). */
export const FAKE_RISER_TAIL_SEC = 0.4;
/** Основні частоти тональних варіантів 1–3. */
export const FAKE_PITCH_HZ: Record<"pop" | "ding" | "shimmer", readonly number[]> = {
  pop: [466.16, 415.3, 554.37],
  ding: [700, 880, 1046.5],
  shimmer: [1300, 1500, 1200],
};

/** State-variable filter (Cytomic, TPT) для шумових свіпів. */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  low = 0;
  band = 0;
  high = 0;

  process(x: number, cutoffHz: number, q: number, sampleRate: number): void {
    const g = Math.tan((Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;
  }
}

type Voice = (t: number) => [number, number];

/** Семпл: `leadSec` тиші з шумом −80 дБ, далі звук `durSec`. Гучність довільна (≈ −6 dBFS). */
function render(durSec: number, leadSec: number, seed: number, voice: Voice, sr = SAMPLE_RATE): StereoPcm {
  const lead = Math.round(leadSec * sr);
  const n = lead + Math.round(durSec * sr);
  const pcm = createStereo(n, sr);
  const rand = mulberry32(seed ^ 0x5eed);
  for (let i = 0; i < lead; i++) {
    pcm.left[i] = 1e-4 * (rand() * 2 - 1);
    pcm.right[i] = 1e-4 * (rand() * 2 - 1);
  }
  for (let i = lead; i < n; i++) {
    const [l, r] = voice((i - lead) / sr);
    pcm.left[i] = 0.5 * l;
    pcm.right[i] = 0.5 * r;
  }
  return pcm;
}

const attack = (t: number, sec: number) => (t >= sec ? 1 : t / sec);
const pan = (x: number, p: number): [number, number] => {
  const a = ((p + 1) * Math.PI) / 4;
  return [x * Math.cos(a), x * Math.sin(a)];
};

/** Cue з власним синтезом; решта синтезується архетипом за traits (`fakeArchetype`). */
const FAKE_VOICES = [
  "whoosh",
  "swoosh",
  "riser",
  "impact",
  "slam",
  "pop",
  "ding",
  "shimmer",
  "tick",
  "click",
] as const satisfies readonly SoundCue[];
type FakeVoice = (typeof FAKE_VOICES)[number];
/** Довгі звуки (серія натискань, прохід сканера, оплески): архетип `click` довжиною 1 с. */
const FAKE_LONG_CUES: ReadonlySet<SoundCue> = new Set(["typing", "scan", "cheer"]);

/** Архетип синтезу cue: удар → `impact`, тональний → `ding`, якір peak → `whoosh`, інше → `click`. */
export function fakeArchetype(cue: SoundCue): FakeVoice {
  if ((FAKE_VOICES as readonly SoundCue[]).includes(cue)) return cue as FakeVoice;
  const t = SOUND_CUE_TRAITS[cue];
  if (t.hit) return "impact";
  if (t.pitch !== "none") return "ding";
  if (t.anchor === "peak") return "whoosh";
  return "click";
}

/** Фейковий варіант `variant` (1, 2, 3…) cue: різні тембри/висоти, однакова будова. */
export function fakeSample(
  cue: SoundCue,
  variant = 1,
  opts: { leadSec?: number; pitchHz?: number } = {},
): StereoPcm {
  const lead = opts.leadSec ?? FAKE_LEAD_SEC;
  const v = Math.max(0, variant - 1);
  const seed = (variant * 7919 + cue.length * 104729) >>> 0;
  const rand = mulberry32(seed);
  const noise = () => rand() * 2 - 1;
  const sr = SAMPLE_RATE;
  const pitch = (c: "pop" | "ding" | "shimmer") =>
    opts.pitchHz ?? (FAKE_PITCH_HZ[c][v % FAKE_PITCH_HZ[c].length] as number);
  const voice = fakeArchetype(cue);
  switch (voice) {
    case "whoosh":
    case "swoosh": {
      const peakAt = FAKE_PEAK_SEC[voice] as number;
      const dur = peakAt * 1.7;
      const f = new Svf();
      const base = (voice === "whoosh" ? 900 : 500) * (1 + 0.3 * v);
      return render(dur, lead, seed, (t) => {
        // Проліт: наростання й спад з гострим піком посередині.
        const x = t < peakAt ? t / peakAt : 1 - (t - peakAt) / (dur - peakAt);
        const env = Math.exp(-Math.abs(t - peakAt) / 0.06) * Math.sin((Math.PI / 2) * Math.max(0, x));
        f.process(noise(), base * (0.5 + x), 1.2, sr);
        return pan(f.band * env, -0.6 + (1.2 * t) / dur);
      });
    }
    case "riser": {
      const peakAt = FAKE_PEAK_SEC.riser as number;
      const f = new Svf();
      let phase = 0;
      return render(peakAt + FAKE_RISER_TAIL_SEC, lead, seed, (t) => {
        const x = Math.min(1, t / peakAt);
        f.process(noise(), (300 + 100 * v) * 2 ** (3 * x), 2, sr);
        phase += (2 * Math.PI * 220 * 2 ** (2 * x)) / sr;
        const body = f.band * 1.2 + 0.35 * Math.sin(phase);
        // До піку — наростання x², після — тихий хвіст «реверберації».
        const env = t < peakAt ? x ** 2 : 0.25 * Math.exp(-(t - peakAt) / 0.1);
        return [body * env, body * env * 0.9];
      });
    }
    case "impact":
    case "slam": {
      const f = new Svf();
      let phase = 0;
      const hard = voice === "slam";
      return render(hard ? 0.6 : 0.9, lead, seed, (t) => {
        phase += (2 * Math.PI * ((hard ? 55 : 45) + (hard ? 60 : 105) * Math.exp(-t / 0.04) + 5 * v)) / sr;
        const body = Math.sin(phase) * Math.exp(-t / (hard ? 0.18 : 0.3));
        f.process(noise(), hard ? 1200 : 2000, 0.7, sr);
        const hit = (hard ? f.band * 1.6 : f.low * 0.8) * Math.exp(-t / 0.02);
        const x = Math.tanh(2 * (body + hit) * attack(t, 0.0005));
        return [x, x];
      });
    }
    case "pop": {
      const hz = pitch("pop");
      return render(0.3, lead, seed, (t) => {
        const x = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.08) * attack(t, 0.001);
        return [x, x];
      });
    }
    case "ding": {
      const hz = pitch("ding");
      return render(0.8, lead, seed, (t) => {
        let x = 0;
        for (const [ratio, amp, tau] of [
          [1, 1, 0.4],
          [2, 0.4, 0.25],
          [3, 0.15, 0.15],
        ] as const)
          x += amp * Math.sin(2 * Math.PI * hz * ratio * t) * Math.exp(-t / tau);
        x *= attack(t, 0.001);
        return [x, x];
      });
    }
    case "shimmer": {
      const hz = pitch("shimmer");
      return render(1, lead, seed, (t) => {
        const trem = 1 + 0.2 * Math.sin(2 * Math.PI * 7 * t);
        const x =
          (Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(4 * Math.PI * hz * t)) *
          Math.exp(-t / 0.35) *
          trem *
          attack(t, 0.002);
        return pan(x, 0.3 * (v - 1));
      });
    }
    case "tick":
    case "click": {
      const f = new Svf();
      const tone = (voice === "tick" ? 3200 : 1500) * (1 + 0.15 * v);
      return render(FAKE_LONG_CUES.has(cue) ? 1 : 0.06, lead, seed, (t) => {
        f.process(noise(), 4000, 1, sr);
        const x =
          (Math.sin(2 * Math.PI * tone * t) * Math.exp(-t / 0.006) + 0.5 * f.band * Math.exp(-t / 0.003)) *
          attack(t, 0.0003);
        return [x, x];
      });
    }
  }
}

/** Фейковий семпл бібліотеки з хешем `fake:<cue>.<n><suffix>`. */
export function fakeSfxSample(
  cue: SoundCue,
  variant = 1,
  opts: { pitchHz?: number; hashSuffix?: string } = {},
) {
  return {
    cue,
    variant,
    hash: `fake:${cue}.${variant}${opts.hashSuffix ?? ""}`,
    pcm: fakeSample(cue, variant, opts.pitchHz !== undefined ? { pitchHz: opts.pitchHz } : {}),
  } satisfies SfxSample;
}

/** Фейкова бібліотека: усі (або задані) cue × `variants` варіантів. */
export function fakeLibrary(opts: { cues?: readonly SoundCue[]; variants?: number } = {}): SfxSampleLibrary {
  const out: Partial<Record<SoundCue, SfxSample[]>> = {};
  for (const cue of opts.cues ?? SoundCue.options) {
    out[cue] = Array.from({ length: opts.variants ?? 3 }, (_, i) => fakeSfxSample(cue, i + 1));
  }
  return out;
}
