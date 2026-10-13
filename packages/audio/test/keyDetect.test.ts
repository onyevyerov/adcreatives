import { type Logger, MusicTrackCheck, noopLogger } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { midiToHz } from "../src/key.ts";
import { detectKey, formatKey, MIN_KEY_CONFIDENCE, resolveEventKey } from "../src/keyDetect.ts";
import { createStereo, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";

/** Тональність треку за хромою (A5) і вибір тональності звуків подій. */

/**
 * Арпеджіо тризвуку: ноти (MIDI) по колу по `noteSec`, кожна — тон із трьома гармоніками
 * (1, 1/2, 1/3) і короткою атакою/спадом, як у синтезатора.
 */
function arpeggio(midis: readonly number[], durationSec: number, noteSec = 0.25): StereoPcm {
  const n = Math.round(durationSec * SAMPLE_RATE);
  const pcm = createStereo(n, SAMPLE_RATE);
  const noteLen = Math.round(noteSec * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(i / noteLen);
    const hz = midiToHz(midis[idx % midis.length] as number);
    const t = (i % noteLen) / SAMPLE_RATE;
    const env = Math.min(1, t / 0.005) * Math.exp(-t * 4);
    let x = 0;
    for (let h = 1; h <= 3; h++) x += Math.sin(2 * Math.PI * hz * h * t) / h;
    pcm.left[i] = 0.3 * env * x;
    pcm.right[i] = 0.3 * env * x;
  }
  return pcm;
}

/** Перевірка треку з визначеною тональністю (решта полів — нейтральні). */
function checkWithKey(keyDetected: MusicTrackCheck["keyDetected"]): MusicTrackCheck {
  return MusicTrackCheck.parse({
    bpm: 120,
    kickOnsets: 40,
    beatConfidence: 0.9,
    gaps: [],
    rmsPerSecondDb: [],
    ok: true,
    keyDetected,
  });
}

/** Логер, що збирає повідомлення. */
function recordingLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  const push = (msg: string) => {
    messages.push(msg);
  };
  return { ...noopLogger, debug: push, info: push, warn: push, error: push, messages };
}

describe("detectKey", () => {
  it("арпеджіо A minor (A3–C4–E4, 8 с) → { root: 9, minor: true }, confidence ≥ 0.2", () => {
    const key = detectKey(arpeggio([57, 60, 64, 69], 8));
    expect(key).toMatchObject({ root: 9, minor: true });
    expect(key?.confidence ?? 0).toBeGreaterThanOrEqual(MIN_KEY_CONFIDENCE);
    expect(key?.confidence ?? 0).toBeLessThanOrEqual(1);
  });

  it("арпеджіо C major і F# major — мажор із правильною тонікою", () => {
    expect(detectKey(arpeggio([48, 52, 55, 60], 8))).toMatchObject({ root: 0, minor: false });
    expect(detectKey(arpeggio([54, 58, 61, 66], 8))).toMatchObject({ root: 6, minor: false });
  });

  it("детермінований результат; тиша й порожній трек — null", () => {
    const pcm = arpeggio([57, 60, 64], 4);
    expect(detectKey(pcm)).toEqual(detectKey(pcm));
    expect(detectKey(createStereo(SAMPLE_RATE * 2, SAMPLE_RATE))).toBeNull();
    expect(detectKey(createStereo(0, SAMPLE_RATE))).toBeNull();
  });

  it("короткий трек (менше за вікно FFT) — оцінка з одного вікна", () => {
    expect(detectKey(arpeggio([57, 60, 64], 0.05, 0.05))).not.toBeNull();
  });
});

describe("resolveEventKey", () => {
  it("впевнений ключ треку, що відрізняється від плану, — ключ треку і лог", () => {
    const logger = recordingLogger();
    const check = checkWithKey({ root: 2, minor: true, confidence: 0.35 });
    expect(resolveEventKey(check, "A minor", logger)).toBe("D minor");
    expect(logger.messages).toEqual(["тональність треку відрізняється від плану"]);
    // План без тональності — теж ключ треку.
    expect(resolveEventKey(checkWithKey({ root: 6, minor: false, confidence: 0.5 }), null)).toBe("F# major");
  });

  it("той самий ключ — рядок плану як є, без логу", () => {
    const logger = recordingLogger();
    expect(resolveEventKey(checkWithKey({ root: 2, minor: true, confidence: 0.9 }), "D dorian", logger)).toBe(
      "D dorian",
    );
    expect(resolveEventKey(checkWithKey({ root: 10, minor: false, confidence: 0.9 }), "Bb major")).toBe(
      "Bb major",
    );
    expect(logger.messages).toEqual([]);
  });

  it("невпевнений або невизначений ключ треку — ключ плану", () => {
    const weak = checkWithKey({ root: 2, minor: true, confidence: MIN_KEY_CONFIDENCE - 0.01 });
    expect(resolveEventKey(weak, "A minor")).toBe("A minor");
    expect(resolveEventKey(checkWithKey(null), "A minor")).toBe("A minor");
    expect(resolveEventKey(null, "A minor")).toBe("A minor");
    expect(resolveEventKey(null, null)).toBeNull();
    // Межа включна.
    const edge = checkWithKey({ root: 2, minor: true, confidence: MIN_KEY_CONFIDENCE });
    expect(resolveEventKey(edge, "A minor")).toBe("D minor");
  });

  it("formatKey — у форматі, який розуміє parseKey", () => {
    expect(formatKey({ root: 9, minor: true })).toBe("A minor");
    expect(formatKey({ root: 1, minor: false })).toBe("C# major");
  });
});
