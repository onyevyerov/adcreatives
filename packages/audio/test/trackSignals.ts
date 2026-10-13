import { createStereo, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";
import { metronome, mulberry32 } from "./signals.ts";

/** Синтетичні треки для перевірки треку (A2): рівний грув, грув із провалами і грув такту (A6). */

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

export interface BarGrooveOptions {
  bpm: number;
  /** Час першої долі треку, с. */
  offsetSec: number;
  durationSec: number;
  /** Скільки долей до першого downbeat: 2 — трек починається з 3-ї долі такту. */
  leadBeats: number;
  /** Хай-хети на слабких восьмих. */
  busy?: boolean;
}

/** Час першого downbeat «треку такту», с. */
export const firstDownbeatSec = (o: Pick<BarGrooveOptions, "bpm" | "offsetSec" | "leadBeats">) =>
  o.offsetSec + (o.leadBeats % 4) * (60 / o.bpm);

/**
 * «Трек такту» 4/4: бочка на 1 і 3 (на 1 — удвічі сильніша, з басом: акцент такту), клап
 * (шумовий сплеск) на 2 і 4, тихий пед; за бажанням — хети на слабких восьмих.
 */
export function barGroove(opts: BarGrooveOptions): StereoPcm {
  const sr = SAMPLE_RATE;
  const n = Math.round(opts.durationSec * sr);
  const pcm = createStereo(n, sr);
  const add = (i: number, v: number) => {
    if (i < 0 || i >= n) return;
    pcm.left[i] = (pcm.left[i] ?? 0) + v;
    pcm.right[i] = (pcm.right[i] ?? 0) + v;
  };
  const period = 60 / opts.bpm;
  const rand = mulberry32(5);
  const burst = (s0: number, gain: number, decaySec: number) => {
    for (let i = 0; i < Math.round(0.08 * sr); i++)
      add(s0 + i, gain * (rand() * 2 - 1) * Math.exp(-i / sr / decaySec));
  };
  for (let k = 0; opts.offsetSec + k * period < opts.durationSec; k++) {
    const t0 = opts.offsetSec + k * period;
    const s0 = Math.round(t0 * sr);
    const beat = (((k - opts.leadBeats) % 4) + 4) % 4;
    if (beat === 0 || beat === 2) {
      const gain = beat === 0 ? 0.8 : 0.4;
      let phase = 0;
      for (let i = 0; i < Math.round(0.35 * sr); i++) {
        const t = i / sr;
        phase += (2 * Math.PI * (50 + 70 * Math.exp(-t / 0.03))) / sr;
        add(s0 + i, gain * Math.sin(phase) * Math.exp(-t / 0.12) * Math.min(1, t / 0.001));
      }
      if (beat === 0) {
        for (let i = 0; i < Math.round(period * 0.8 * sr); i++)
          add(s0 + i, 0.2 * Math.sin((2 * Math.PI * 55 * i) / sr) * Math.exp(-i / sr / 0.3));
      }
    } else {
      burst(s0, 0.3, 0.03);
    }
    if (opts.busy) burst(Math.round((t0 + period / 2) * sr), 0.12, 0.01);
  }
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    add(i, 0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 330 * t)));
  }
  return pcm;
}
