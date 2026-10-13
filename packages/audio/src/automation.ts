import { beatFrames, computeTimeline, type MusicMix, type Storyboard } from "@adc/shared";
import { Biquad } from "./dsp.ts";
import { createStereo, dbToGain, frameToSample, pcmLength, type StereoPcm, secToSamples } from "./pcm.ts";

/**
 * Автоматизація частин треку за `musicBrief.structure[].mix`: генератор план аранжування
 * ігнорує, тож арку (вступ / повна / брейкдаун) робить зведення — low-pass і гучність.
 */

/** «Відкритий» фільтр частини `full`: на цьому зрізі фільтр обходиться (звук без змін). */
const OPEN_CUTOFF_HZ = 20_000;
/** Параметри фільтра оновлюються блоками (крок у семплах). */
const BLOCK = 32;
/** Fade-out музики в останню секунду ролика. */
export const MUSIC_TAIL_FADE_SEC = 1;

export const MIX_SETTINGS: Record<MusicMix, { cutoffHz: number; gainDb: number }> = {
  filtered: { cutoffHz: 800, gainDb: -4 },
  full: { cutoffHz: OPEN_CUTOFF_HZ, gainDb: 0 },
  breakdown: { cutoffHz: 400, gainDb: -10 },
};

export interface MixSection {
  mix: MusicMix;
  /** Глобальний кадр початку частини. */
  fromFrame: number;
}

/**
 * Частини треку в кадрах відео: кожна сцена бере `mix` частини структури, що її містить
 * (немає такої — `full`); сусідні сцени з однаковим `mix` зливаються. Межа — `from` сцени.
 */
export function mixSections(storyboard: Pick<Storyboard, "fps" | "scenes" | "musicBrief">): MixSection[] {
  const timeline = computeTimeline(storyboard);
  const byScene = new Map<string, MusicMix>();
  for (const part of storyboard.musicBrief.structure) {
    for (const id of part.sceneIds) if (!byScene.has(id)) byScene.set(id, part.mix ?? "full");
  }
  const out: MixSection[] = [];
  for (const ts of timeline.scenes) {
    const mix = byScene.get(ts.id) ?? "full";
    if (out.at(-1)?.mix === mix) continue;
    out.push({ mix, fromFrame: ts.index === 0 ? 0 : ts.from });
  }
  return out;
}

interface Params {
  cutoffHz: number;
  gainDb: number;
}

function paramsAt(
  n: number,
  sections: ReadonlyArray<{ mix: MusicMix; start: number }>,
  ramp: number,
): Params {
  let j = 0;
  while (j + 1 < sections.length && (sections[j + 1]?.start ?? Infinity) <= n) j++;
  const cur = MIX_SETTINGS[sections[j]?.mix ?? "full"];
  const next = sections[j + 1];
  if (!next) return cur;
  // Рампа довжиною в долю закінчується на межі: новий стан звучить рівно з першої долі частини.
  const rampStart = Math.max(next.start - ramp, sections[j]?.start ?? 0);
  if (n < rampStart || next.start <= rampStart) return cur;
  const x = (n - rampStart) / (next.start - rampStart);
  const to = MIX_SETTINGS[next.mix];
  return {
    cutoffHz: 2 ** (Math.log2(cur.cutoffHz) + (Math.log2(to.cutoffHz) - Math.log2(cur.cutoffHz)) * x),
    gainDb: cur.gainDb + (to.gainDb - cur.gainDb) * x,
  };
}

export interface AutomationOptions {
  fps: number;
  bpm: number;
}

/** Нова копія музики з автоматизацією частин і fade-out останніх `MUSIC_TAIL_FADE_SEC`. */
export function applyMixAutomation(
  music: StereoPcm,
  sections: readonly MixSection[],
  opts: AutomationOptions,
): StereoPcm {
  const sr = music.sampleRate;
  const n = pcmLength(music);
  const out = createStereo(n, sr);
  const starts = sections.map((s) => ({ mix: s.mix, start: frameToSample(s.fromFrame, opts.fps, sr) }));
  if (starts.length === 0) starts.push({ mix: "full", start: 0 });
  const ramp = frameToSample(beatFrames(opts.bpm, opts.fps), opts.fps, sr);
  const fl = new Biquad();
  const fr = new Biquad();
  const fadeStart = n - Math.min(n, secToSamples(MUSIC_TAIL_FADE_SEC, sr));
  for (let b = 0; b < n; b += BLOCK) {
    const p = paramsAt(b + BLOCK / 2, starts, ramp);
    const open = p.cutoffHz >= OPEN_CUTOFF_HZ - 1;
    fl.setLowpass(p.cutoffHz, sr);
    fr.setLowpass(p.cutoffHz, sr);
    const gain = dbToGain(p.gainDb);
    const end = Math.min(n, b + BLOCK);
    for (let i = b; i < end; i++) {
      const l = music.left[i] ?? 0;
      const r = music.right[i] ?? 0;
      // Фільтр рахується завжди (без розриву стану на межах), але в `full` звук іде повз нього.
      const yl = fl.process(l);
      const yr = fr.process(r);
      let g = gain;
      if (i >= fadeStart) g *= 0.5 * (1 + Math.cos((Math.PI * (i - fadeStart)) / Math.max(1, n - fadeStart)));
      out.left[i] = (open ? l : yl) * g;
      out.right[i] = (open ? r : yr) * g;
    }
  }
  return out;
}

/**
 * Музичний дакінг: замість просідання гучності музика «звільняє низ» під подію — HPF на музиці.
 * impact/slam — HPF 150 Гц рівно на одну долю від кадру (бочка вирізана на долю, качання — по сітці);
 * riser — HPF, що відкривається від 300 Гц до 20 Гц за час riser і закінчується на кадрі події.
 */

/** Зріз HPF на долю після impact/slam, Гц. */
export const DUCK_HPF_HZ = 150;
/** Riser: HPF відкривається з `RISER_HPF_FROM_HZ` до `DUCK_OPEN_HZ`. */
export const RISER_HPF_FROM_HZ = 300;
export const DUCK_OPEN_HZ = 20;
/** Рампа на вході (і на виході riser), с; вихід impact/slam — чверть долі. */
export const DUCK_ATTACK_SEC = 0.005;
export const DUCK_RELEASE_BEATS = 0.25;

/** Дакінг у семплах треку: `beat` — доля від `at`; `riser` — від `from` до `at` (кадр події). */
export type MusicDuck = { kind: "beat"; at: number } | { kind: "riser"; from: number; at: number };

interface DuckShape {
  from: number;
  to: number;
  /** Частка відфільтрованого сигналу (0 — сухий трек, 1 — повністю через HPF). */
  mix(j: number): number;
  cutoff(j: number): number;
}

function duckShape(d: MusicDuck, beatSamples: number, attack: number): DuckShape {
  if (d.kind === "beat") {
    const to = d.at + beatSamples;
    const release = Math.max(1, Math.round(beatSamples * DUCK_RELEASE_BEATS));
    return {
      from: d.at,
      to,
      mix: (j) => Math.min(1, (j - d.at + 1) / attack, (to - j) / release),
      cutoff: () => DUCK_HPF_HZ,
    };
  }
  const span = Math.max(1, d.at - d.from);
  const lo = Math.log2(DUCK_OPEN_HZ);
  const hi = Math.log2(RISER_HPF_FROM_HZ);
  return {
    from: d.from,
    to: d.at,
    mix: (j) => Math.min(1, (j - d.from + 1) / attack, (d.at - j) / attack),
    cutoff: (j) => 2 ** (hi + (lo - hi) * Math.min(1, Math.max(0, (j - d.from) / span))),
  };
}

/** Нова копія музики з дакінгом; поза дакінгами — побайтно сухий трек. HPF — 24 дБ/окт (два біквади). */
export function duckMusic(
  music: StereoPcm,
  ducks: readonly MusicDuck[],
  opts: { beatSamples: number },
): StereoPcm {
  const sr = music.sampleRate;
  const n = pcmLength(music);
  const out = createStereo(n, sr);
  out.left.set(music.left);
  out.right.set(music.right);
  if (ducks.length === 0 || n === 0) return out;
  const attack = Math.max(1, Math.round(DUCK_ATTACK_SEC * sr));
  const shapes = ducks.map((d) => duckShape(d, Math.max(1, opts.beatSamples), attack));
  const mix = new Float32Array(n);
  const cutoff = new Float64Array(n).fill(DUCK_OPEN_HZ);
  for (const s of shapes) {
    for (let j = Math.max(0, s.from); j < Math.min(n, s.to); j++) {
      const m = Math.max(0, s.mix(j));
      if (m > (mix[j] as number)) mix[j] = m;
      const c = s.cutoff(j);
      if (c > (cutoff[j] as number)) cutoff[j] = c;
    }
  }
  // Фільтри йдуть через увесь трек (без розриву стану), а звук бере їх лише там, де mix > 0.
  const filters = [new Biquad(), new Biquad(), new Biquad(), new Biquad()] as const;
  const [l1, l2, r1, r2] = filters;
  for (let b = 0; b < n; b += BLOCK) {
    const c = cutoff[Math.min(n - 1, b + BLOCK / 2)] as number;
    for (const f of filters) f.setHighpass(c, sr);
    const end = Math.min(n, b + BLOCK);
    for (let i = b; i < end; i++) {
      const l = music.left[i] as number;
      const r = music.right[i] as number;
      const yl = l2.process(l1.process(l));
      const yr = r2.process(r1.process(r));
      const m = mix[i] as number;
      if (m <= 0) continue;
      out.left[i] = l + (yl - l) * m;
      out.right[i] = r + (yr - r) * m;
    }
  }
  return out;
}
