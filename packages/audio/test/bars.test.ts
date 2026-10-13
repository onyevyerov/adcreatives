import { describe, expect, it } from "vitest";
import { estimateBarPhase, MIN_BAR_CONFIDENCE } from "../src/bars.ts";
import { estimateBeatPhase, lowBandOnsets } from "../src/beat.ts";
import { createStereo, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";
import { metronome } from "./signals.ts";
import { barGroove, firstDownbeatSec } from "./trackSignals.ts";

const FRAME_SEC = 1 / 30;

/** Фаза такту від фази долі, яку знаходить детектор (як у зведенні й перевірці треку). */
const barPhaseOf = (pcm: StereoPcm, bpm: number) =>
  estimateBarPhase(pcm, bpm, estimateBeatPhase(lowBandOnsets(pcm), 60 / bpm).offsetSec);

describe("фаза такту", () => {
  it.each([
    { bpm: 120, leadBeats: 0, busy: false },
    { bpm: 120, leadBeats: 1, busy: true },
    { bpm: 120, leadBeats: 2, busy: true },
    { bpm: 120, leadBeats: 3, busy: false },
    { bpm: 90, leadBeats: 2, busy: true },
    { bpm: 150, leadBeats: 3, busy: true },
    { bpm: 85, leadBeats: 1, busy: false },
  ])("бочка на 1 і 3, клап на 2 і 4: $bpm BPM, downbeat через $leadBeats долі → знайдено ±1 кадр", (c) => {
    const opts = { ...c, offsetSec: 0.07, durationSec: 16 };
    const bar = barPhaseOf(barGroove(opts), c.bpm);
    expect(bar).not.toBeNull();
    expect(bar?.confidence).toBeGreaterThanOrEqual(MIN_BAR_CONFIDENCE);
    expect(Math.abs((bar?.barOffsetSec ?? 0) - firstDownbeatSec(opts))).toBeLessThanOrEqual(FRAME_SEC);
  });

  it.each([90, 120, 150])("метроном без акцентів (%d BPM): долі рівні → впевненість нижче порогу", (bpm) => {
    const bar = barPhaseOf(metronome({ bpm, offsetSec: 0.07, durationSec: 16, busy: true, pad: true }), bpm);
    expect(bar).not.toBeNull();
    expect(bar?.confidence).toBeLessThan(MIN_BAR_CONFIDENCE);
  });

  it("без акценту долі 1 і 3 нерозрізнимі: лише бочка 1/3 і клап 2/4 однакової сили → нижче порогу", () => {
    // Той самий грув, але бочка на 3 така сама, як на 1 (сумуємо грув зі зсувом на 2 долі).
    const a = barGroove({ bpm: 120, offsetSec: 0.07, durationSec: 16, leadBeats: 0 });
    const b = barGroove({ bpm: 120, offsetSec: 0.07, durationSec: 16, leadBeats: 2 });
    const sum = createStereo(a.left.length, SAMPLE_RATE);
    for (let i = 0; i < a.left.length; i++) {
      sum.left[i] = ((a.left[i] ?? 0) + (b.left[i] ?? 0)) / 2;
      sum.right[i] = ((a.right[i] ?? 0) + (b.right[i] ?? 0)) / 2;
    }
    expect(barPhaseOf(sum, 120)?.confidence).toBeLessThan(MIN_BAR_CONFIDENCE);
  });

  it("тиша, коротший за 4 такти трек або нема bpm → null", () => {
    expect(estimateBarPhase(createStereo(16 * SAMPLE_RATE, SAMPLE_RATE), 120, 0)).toBeNull();
    const short = barGroove({ bpm: 120, offsetSec: 0.07, durationSec: 7, leadBeats: 0 });
    expect(barPhaseOf(short, 120)).toBeNull();
    expect(estimateBarPhase(short, 0, 0.07)).toBeNull();
  });

  it("детерміновано: той самий вхід → той самий результат", () => {
    const pcm = barGroove({ bpm: 120, offsetSec: 0.07, durationSec: 12, leadBeats: 2, busy: true });
    expect(barPhaseOf(pcm, 120)).toEqual(barPhaseOf(pcm, 120));
  });
});
