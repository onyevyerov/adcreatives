import { type EventPlacement, SOUND_CUE_TRAITS, SoundCue } from "@adc/shared";
import {
  analyzeSample,
  PITCHED_CUES,
  type SampleAnalysis,
  type SfxSample,
  type SfxSampleLibrary,
} from "./samples.ts";

/**
 * Бібліотека семплів зведення і вибір варіанта для кожної події (A5): аналіз варіантів
 * (порожні й тихі відкидаються) і ротація варіантів по подіях. Тональні cue беруть лише
 * варіанти з визначеною висотою (лише їх можна строїти в тональність); cue з `perScene`
 * (pop/ding) тримають один варіант на сцену, щоб мелодія сцени звучала одним тембром.
 */

/** Cue з одним варіантом на сцену (`SOUND_CUE_TRAITS.perScene`): наступна сцена бере наступний варіант. */
export const PER_SCENE_CUES: ReadonlySet<SoundCue> = new Set(
  SoundCue.options.filter((cue) => SOUND_CUE_TRAITS[cue].perScene),
);

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

/** Варіанти, з яких обирається cue: для тональних — лише з `pitchHz` (немає таких — усі), порядок той самий. */
export function variantPool(cue: SoundCue, variants: readonly PreparedEntry[]): readonly PreparedEntry[] {
  if (!PITCHED_CUES.has(cue)) return variants;
  const pitched = variants.filter((v) => v.analysis.pitchHz !== null);
  return pitched.length > 0 ? pitched : variants;
}

/**
 * Варіант семпла для кожного розміщення (у тому ж порядку): по колу з `variantPool`, лічильник —
 * на cue; для `PER_SCENE_CUES` лічильник крокує раз на сцену (усі події cue у сцені — один варіант).
 * Кожне розміщення має cue, для якого в `library` є хоча б один варіант.
 */
export function chooseVariants(
  placements: readonly EventPlacement[],
  library: ReadonlyMap<SoundCue, PreparedEntry[]>,
): PreparedEntry[] {
  const rotation = new Map<SoundCue, number>();
  const byScene = new Map<string, PreparedEntry>();
  return placements.map((p) => {
    const cue = p.cue as SoundCue;
    const sceneKey = `${cue}:${p.sceneId}`;
    const kept = PER_SCENE_CUES.has(cue) ? byScene.get(sceneKey) : undefined;
    if (kept) return kept;
    const pool = variantPool(cue, library.get(cue) ?? []);
    const n = rotation.get(cue) ?? 0;
    rotation.set(cue, n + 1);
    const entry = pool[n % pool.length] as PreparedEntry;
    if (PER_SCENE_CUES.has(cue)) byScene.set(sceneKey, entry);
    return entry;
  });
}
