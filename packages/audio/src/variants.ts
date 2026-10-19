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
 * Номер варіанта (1-based, позиція в пулі з `poolSize(cue)` варіантів) для кожного розміщення в тому ж
 * порядку; розміщення без cue — null. Лічильник — на cue; для `PER_SCENE_CUES` він крокує раз на сцену
 * (усі події cue у сцені — один варіант, навіть якщо події сусідньої сцени перемежовуються з ними).
 */
function rotate(
  placements: readonly EventPlacement[],
  poolSize: (cue: SoundCue) => number,
): Array<number | null> {
  const rotation = new Map<SoundCue, number>();
  const byScene = new Map<string, number>();
  return placements.map((p) => {
    if (p.cue === null) return null;
    const cue = p.cue;
    const sceneKey = `${cue}:${p.sceneId}`;
    const kept = PER_SCENE_CUES.has(cue) ? byScene.get(sceneKey) : undefined;
    if (kept !== undefined) return kept;
    const n = rotation.get(cue) ?? 0;
    rotation.set(cue, n + 1);
    const variant = (n % Math.max(1, poolSize(cue))) + 1;
    if (PER_SCENE_CUES.has(cue)) byScene.set(sceneKey, variant);
    return variant;
  });
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
  const pools = new Map<SoundCue, readonly PreparedEntry[]>();
  const poolOf = (cue: SoundCue) => {
    let pool = pools.get(cue);
    if (!pool) {
      pool = variantPool(cue, library.get(cue) ?? []);
      pools.set(cue, pool);
    }
    return pool;
  };
  const indices = rotate(placements, (cue) => poolOf(cue).length);
  return placements.map((p, i) => {
    const variant = indices[i] ?? null;
    return (variant === null ? undefined : poolOf(p.cue as SoundCue)[variant - 1]) as PreparedEntry;
  });
}

/**
 * Номери варіантів (1-based) для розміщень з cue, у тому ж порядку (розміщення без cue пропускаються):
 * та сама ротація, що в `chooseVariants`, але по пулу з `poolSize(cue)` варіантів. Для провайдера без
 * готової бібліотеки семплів (Epidemic) стадія вираховує, що прозвучить, і просить лише ці варіанти.
 */
export function variantIndices(
  placements: readonly EventPlacement[],
  poolSize: (cue: SoundCue) => number,
): Array<{ cue: SoundCue; variant: number }> {
  const indices = rotate(placements, poolSize);
  const out: Array<{ cue: SoundCue; variant: number }> = [];
  placements.forEach((p, i) => {
    const variant = indices[i];
    if (p.cue !== null && variant != null) out.push({ cue: p.cue, variant });
  });
  return out;
}
