import { createStereo, type StereoPcm } from "../src/pcm.ts";
import { metronome } from "./signals.ts";

/** Синтетичні треки для перевірки треку (A2): рівний грув і грув із провалами. */

/** Рівний «трек»: бочка на кожну долю, хети, бас і пед. */
export function groove(bpm: number, durationSec: number): StereoPcm {
  return metronome({ bpm, offsetSec: 0.05, durationSec, busy: true, pad: true });
}

/** Копія з провалами: ділянки [from, to) с помножені на `gain` (0 — тиша, «стоп»). */
export function withGaps(
  pcm: StereoPcm,
  gaps: ReadonlyArray<{ fromSec: number; toSec: number; gain?: number }>,
): StereoPcm {
  const out = createStereo(pcm.left.length, pcm.sampleRate);
  out.left.set(pcm.left);
  out.right.set(pcm.right);
  for (const g of gaps) {
    const a = Math.round(g.fromSec * pcm.sampleRate);
    const b = Math.min(out.left.length, Math.round(g.toSec * pcm.sampleRate));
    const gain = g.gain ?? 0;
    for (let i = a; i < b; i++) {
      out.left[i] = (out.left[i] ?? 0) * gain;
      out.right[i] = (out.right[i] ?? 0) * gain;
    }
  }
  return out;
}
