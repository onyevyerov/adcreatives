import type { EventPlacement, SoundCue } from "@adc/shared";
import { analyzeSample, type SampleAnalysis, type SfxSample, type SfxSampleLibrary } from "./samples.ts";

/**
 * Бібліотека семплів зведення і вибір варіанта для кожної події (A5): аналіз варіантів
 * (порожні й тихі відкидаються) і ротація варіантів по подіях.
 */

export interface PreparedEntry {
  sample: SfxSample;
  analysis: SampleAnalysis;
}

/** Аналіз варіантів кожного cue (порожні й тихі семпли відкидаються); cue без варіантів — немає в мапі. */
export function prepareLibrary(samples: SfxSampleLibrary): Map<SoundCue, PreparedEntry[]> {
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

/**
 * Варіант семпла для кожного розміщення (у тому ж порядку): по колу, лічильник — на cue.
 * Кожне розміщення має cue, для якого в `library` є хоча б один варіант.
 */
export function chooseVariants(
  placements: readonly EventPlacement[],
  library: ReadonlyMap<SoundCue, PreparedEntry[]>,
): PreparedEntry[] {
  const rotation = new Map<SoundCue, number>();
  return placements.map((p) => {
    const cue = p.cue as SoundCue;
    const variants = library.get(cue) ?? [];
    const n = rotation.get(cue) ?? 0;
    rotation.set(cue, n + 1);
    return variants[n % variants.length] as PreparedEntry;
  });
}
