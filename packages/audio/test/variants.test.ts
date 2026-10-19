import type { EventPlacement, SoundCue } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { createStereo } from "../src/pcm.ts";
import type { SampleAnalysis } from "../src/samples.ts";
import {
  chooseVariants,
  type PreparedEntry,
  prepareLibrary,
  variantIndices,
  variantPool,
} from "../src/variants.ts";
import { fakeLibrary } from "./fakeSfx.ts";

/** Вибір варіантів семплів для подій (A5): тональні — лише строєні, pop/ding — один на сцену. */

/** Підготовлений варіант без звуку: важать лише номер і висота. */
function entry(cue: SoundCue, variant: number, pitchHz: number | null): PreparedEntry {
  return {
    sample: { cue, variant, hash: `h:${cue}.${variant}`, pcm: createStereo(1) },
    // Лише поля, від яких залежить вибір (інші блоки додають у аналіз свої).
    analysis: { from: 0, to: 1, anchor: 0, onset: 0, peak: 0, cutIn: false, pitchHz } as SampleAnalysis,
  };
}

let frame = 0;
const at = (sceneId: string, cue: SoundCue): EventPlacement => ({
  sceneId,
  eventId: `e${frame}`,
  frame: frame++,
  cue,
  accent: "normal",
});

const variantsOf = (chosen: readonly PreparedEntry[]) => chosen.map((e) => e.sample.variant);

describe("variantPool", () => {
  it("тональні cue — лише варіанти з висотою; немає таких — усі; решта cue — усі", () => {
    const pop = [entry("pop", 1, null), entry("pop", 2, null), entry("pop", 3, 440)];
    expect(variantPool("pop", pop).map((e) => e.sample.variant)).toEqual([3]);
    const shimmer = [entry("shimmer", 1, 1200), entry("shimmer", 2, null), entry("shimmer", 3, 1500)];
    expect(variantPool("shimmer", shimmer).map((e) => e.sample.variant)).toEqual([1, 3]);
    const unpitched = [entry("ding", 1, null), entry("ding", 2, null)];
    expect(variantPool("ding", unpitched)).toEqual(unpitched);
    const whoosh = [entry("whoosh", 1, null), entry("whoosh", 2, null)];
    expect(variantPool("whoosh", whoosh)).toEqual(whoosh);
  });
});

describe("chooseVariants", () => {
  const library = new Map<SoundCue, PreparedEntry[]>([
    ["pop", [entry("pop", 1, null), entry("pop", 2, 466), entry("pop", 3, 554)]],
    ["ding", [entry("ding", 1, 700), entry("ding", 2, 880), entry("ding", 3, 1046)]],
    ["shimmer", [entry("shimmer", 1, 1300), entry("shimmer", 2, null), entry("shimmer", 3, 1200)]],
    ["whoosh", [entry("whoosh", 1, null), entry("whoosh", 2, null), entry("whoosh", 3, null)]],
  ]);

  it("pop/ding: один варіант на сцену, наступна сцена — наступний варіант (лише строєні)", () => {
    const placements = [
      at("s1", "pop"),
      at("s1", "ding"),
      at("s1", "pop"),
      at("s1", "pop"),
      at("s2", "pop"),
      at("s2", "ding"),
      at("s2", "pop"),
      at("s3", "pop"),
      at("s3", "ding"),
    ];
    const chosen = chooseVariants(placements, library);
    const by = (cue: SoundCue) => variantsOf(chosen.filter((_, i) => placements[i]?.cue === cue));
    // pop.1 без висоти — поза колом: s1 → 2, s2 → 3, s3 → знову 2.
    expect(by("pop")).toEqual([2, 2, 2, 3, 3, 2]);
    expect(by("ding")).toEqual([1, 2, 3]);
  });

  it("події сцени, що перемежовуються з наступною (перехід), тримають варіант своєї сцени", () => {
    const chosen = chooseVariants(
      [at("s1", "pop"), at("s2", "pop"), at("s1", "pop"), at("s2", "pop")],
      library,
    );
    expect(variantsOf(chosen)).toEqual([2, 3, 2, 3]);
  });

  it("shimmer — по колу з подіями (не на сцену), лише строєні; решта cue — по колу як раніше", () => {
    const placements = [
      at("s1", "shimmer"),
      at("s1", "whoosh"),
      at("s1", "shimmer"),
      at("s1", "whoosh"),
      at("s2", "shimmer"),
      at("s2", "whoosh"),
      at("s2", "whoosh"),
    ];
    const chosen = chooseVariants(placements, library);
    const by = (cue: SoundCue) => variantsOf(chosen.filter((_, i) => placements[i]?.cue === cue));
    expect(by("shimmer")).toEqual([1, 3, 1]);
    expect(by("whoosh")).toEqual([1, 2, 3, 1]);
  });

  it("тональний cue без жодного строєного варіанта — по сценах з усіх варіантів", () => {
    const flat = new Map<SoundCue, PreparedEntry[]>([
      ["pop", [entry("pop", 1, null), entry("pop", 2, null)]],
    ]);
    const chosen = chooseVariants([at("s1", "pop"), at("s1", "pop"), at("s2", "pop"), at("s3", "pop")], flat);
    expect(variantsOf(chosen)).toEqual([1, 1, 2, 1]);
  });

  it("детерміновано; бібліотека з фейкових семплів — усі тональні варіанти строєні", () => {
    const prepared = prepareLibrary(fakeLibrary({ cues: ["pop", "ding", "shimmer"] }));
    for (const cue of ["pop", "ding", "shimmer"] as const) {
      expect(variantPool(cue, prepared.get(cue) ?? [])).toHaveLength(3);
    }
    const placements = [at("s1", "pop"), at("s1", "pop"), at("s2", "pop"), at("s2", "shimmer")];
    expect(variantsOf(chooseVariants(placements, prepared))).toEqual(
      variantsOf(chooseVariants(placements, prepared)),
    );
    expect(variantsOf(chooseVariants(placements, prepared))).toEqual([1, 1, 2, 1]);
  });
});

describe("variantIndices", () => {
  it("та сама ротація, що в chooseVariants: pop/ding — один варіант на сцену, решта — по колу", () => {
    const placements = [
      at("s1", "pop"),
      at("s1", "whoosh"),
      at("s1", "pop"),
      at("s2", "pop"),
      at("s1", "pop"),
      at("s2", "whoosh"),
      at("s3", "pop"),
      at("s3", "whoosh"),
      at("s4", "pop"),
    ];
    expect(variantIndices(placements, () => 3)).toEqual([
      { cue: "pop", variant: 1 },
      { cue: "whoosh", variant: 1 },
      { cue: "pop", variant: 1 },
      { cue: "pop", variant: 2 },
      { cue: "pop", variant: 1 },
      { cue: "whoosh", variant: 2 },
      { cue: "pop", variant: 3 },
      { cue: "whoosh", variant: 3 },
      { cue: "pop", variant: 1 },
    ]);
  });

  it("розміщення без cue пропускаються; пул на cue; порожній пул — варіант 1", () => {
    const silent: EventPlacement = { ...at("s1", "pop"), cue: null };
    const placements = [
      at("s1", "whoosh"),
      silent,
      at("s1", "whoosh"),
      at("s1", "click"),
      at("s1", "whoosh"),
    ];
    const pool = (cue: SoundCue) => (cue === "whoosh" ? 2 : 0);
    expect(variantIndices(placements, pool)).toEqual([
      { cue: "whoosh", variant: 1 },
      { cue: "whoosh", variant: 2 },
      { cue: "click", variant: 1 },
      { cue: "whoosh", variant: 1 },
    ]);
  });

  it("chooseVariants = variantIndices по відфільтрованому пулу (позиція в пулі, не номер варіанта)", () => {
    const library = new Map<SoundCue, PreparedEntry[]>([
      ["pop", [entry("pop", 1, null), entry("pop", 2, 466), entry("pop", 3, 554)]],
      ["whoosh", [entry("whoosh", 1, null), entry("whoosh", 2, null)]],
    ]);
    const placements = [
      at("s1", "pop"),
      at("s1", "whoosh"),
      at("s2", "pop"),
      at("s1", "whoosh"),
      at("s3", "pop"),
    ];
    const pools = new Map([...library].map(([cue, v]) => [cue, variantPool(cue, v)]));
    const expected = variantIndices(placements, (cue) => pools.get(cue)?.length ?? 0).map(
      ({ cue, variant }) => pools.get(cue)?.[variant - 1],
    );
    expect(chooseVariants(placements, library)).toEqual(expected);
    expect(variantsOf(chooseVariants(placements, library))).toEqual([2, 1, 3, 2, 2]);
  });
});
