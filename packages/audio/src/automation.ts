import { beatFrames, computeTimeline, type MusicMix, type Storyboard } from "@adc/shared";
import { Biquad } from "./dsp.ts";
import { createStereo, dbToGain, frameToSample, pcmLength, type StereoPcm } from "./pcm.ts";

/**
 * Автоматизація частин треку за `musicBrief.structure[].mix`: генератор план аранжування
 * ігнорує, тож арку (вступ / повна / брейкдаун) робить зведення — low-pass і гучність.
 */

/** «Відкритий» фільтр частини `full`: на цьому зрізі фільтр обходиться (звук без змін). */
const OPEN_CUTOFF_HZ = 20_000;
/** Параметри фільтра оновлюються блоками (крок у семплах). */
const BLOCK = 32;

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
  /** Fade-out наприкінці треку, семпли. */
  fadeOutSamples: number;
}

/** Нова копія музики з автоматизацією частин і fade-out останніх `fadeOutSamples`. */
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
  const fadeStart = n - Math.min(n, opts.fadeOutSamples);
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
