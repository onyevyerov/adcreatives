import { createCostRecorder, loadPrices, sharedPaths } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { findFfmpeg } from "../src/decode.ts";
import { createStereo, dbToGain, peakOf, SAMPLE_RATE, type StereoPcm } from "../src/pcm.ts";
import { ensureStandardSfx, SfxCacheMeta, sfxHash } from "../src/sfx.ts";
import { checkSfxPcm, createSfxQc, defaultSfxQc, SFX_QC_MIN_PEAK_DB, SfxQc, sfxQcCue } from "../src/sfxQc.ts";
import { decodeWav, encodeWav } from "../src/wav.ts";
import { instantGate, mockElevenLabs, tmpStorage } from "./helpers.ts";
import { mulberry32 } from "./signals.ts";

/** Семпл: `leadSec` тиші, далі `durSec` звуку; пік нормалізується до `peakDb`. */
function synth(
  opts: { durSec: number; leadSec?: number; peakDb?: number },
  voice: (t: number, i: number) => [number, number],
): StereoPcm {
  const sr = SAMPLE_RATE;
  const lead = Math.round((opts.leadSec ?? 0.005) * sr);
  const n = lead + Math.round(opts.durSec * sr);
  const pcm = createStereo(n, sr);
  for (let i = lead; i < n; i++) {
    const [l, r] = voice((i - lead) / sr, i);
    pcm.left[i] = l;
    pcm.right[i] = r;
  }
  const g = dbToGain(opts.peakDb ?? -3) / peakOf(pcm);
  for (let i = 0; i < n; i++) {
    pcm.left[i] = (pcm.left[i] as number) * g;
    pcm.right[i] = (pcm.right[i] as number) * g;
  }
  return pcm;
}

/** Тональний звук: синус із затуханням, моно. */
const tone = (hz: number, opts: { durSec?: number; leadSec?: number; peakDb?: number } = {}) =>
  synth({ durSec: opts.durSec ?? 0.5, leadSec: opts.leadSec ?? 0.005, peakDb: opts.peakDb ?? -3 }, (t) => {
    const x = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.15) * Math.min(1, t / 0.001);
    return [x, x];
  });

/** Шумовий удар: `stereo` — моно, протифаза або незалежні канали (декорельований шум). */
function noiseHit(
  stereo: "mono" | "anti" | "decor",
  opts: { durSec?: number; leadSec?: number; peakDb?: number } = {},
) {
  const a = mulberry32(7);
  const b = mulberry32(11);
  return synth(
    { durSec: opts.durSec ?? 0.4, leadSec: opts.leadSec ?? 0.005, peakDb: opts.peakDb ?? -3 },
    (t) => {
      const env = Math.exp(-t / 0.08);
      const l = (a() * 2 - 1) * env;
      const r = (b() * 2 - 1) * env;
      return stereo === "mono" ? [l, l] : stereo === "anti" ? [l, -l] : [l, r];
    },
  );
}

/** Проліт: шум із дзвоноподібною огинаючою (пік посередині). */
function whoosh(stereo: "decor" | "anti", durSec = 0.6) {
  const a = mulberry32(3);
  const b = mulberry32(5);
  return synth({ durSec }, (t) => {
    const env = Math.sin((Math.PI * t) / durSec);
    const l = (a() * 2 - 1) * env;
    return [l, stereo === "anti" ? -l : (b() * 2 - 1) * env];
  });
}

/** Наростання riser: шум × (t/T)², обрив на піку. */
function riser(leadSec: number) {
  const a = mulberry32(13);
  return synth({ durSec: 1.2, leadSec }, (t) => {
    const x = (a() * 2 - 1) * (t / 1.2) ** 2;
    return [x, x * 0.9];
  });
}

describe("checkSfxPcm", () => {
  it("чистий тональний pop: ok, пік, onset, кореляція й висота тону виміряні", () => {
    const qc = checkSfxPcm("pop.1", tone(523.25));
    expect(qc.reasons).toEqual([]);
    expect(qc.ok).toBe(true);
    expect(qc.peakDb).toBeCloseTo(-3, 1);
    expect(qc.onsetMs).toBeLessThanOrEqual(10);
    expect(qc.correlation).toBe(1);
    expect(qc.pitchHz).toBeGreaterThan(523.25 * 0.98);
    expect(qc.pitchHz).toBeLessThan(523.25 * 1.02);
    expect(qc.attempts).toBe(1);
    expect(() => SfxQc.parse(qc)).not.toThrow();
  });

  it("тихий семпл (пік −30 dBFS) — порушення піку, решта в нормі", () => {
    const qc = checkSfxPcm("ding.2", tone(880, { peakDb: -30 }));
    expect(qc.ok).toBe(false);
    expect(qc.peakDb).toBeCloseTo(-30, 1);
    expect(qc.reasons).toEqual(["пік -30 dBFS < -12"]);
    expect(SFX_QC_MIN_PEAK_DB).toBe(-12);
  });

  it("onset: ≤ 50 мс для ударів, ≤ 400 мс для riser", () => {
    const late = checkSfxPcm("impact.1", noiseHit("mono", { leadSec: 0.12 }));
    expect(late.onsetMs).toBeGreaterThan(110);
    expect(late.reasons).toEqual([expect.stringMatching(/^onset \d+(\.\d)? мс > 50$/)]);
    expect(checkSfxPcm("impact.1", noiseHit("mono", { leadSec: 0.03 })).ok).toBe(true);

    // Наростання (t/T)² переходить поріг −24 дБ на ~0.25 T = 300 мс — для riser це норма.
    const slow = checkSfxPcm("riser.2", riser(0));
    expect(slow.onsetMs).toBeGreaterThan(50);
    expect(slow.ok).toBe(true);
    const tooSlow = checkSfxPcm("riser.2", riser(0.2));
    expect(tooSlow.reasons).toEqual([expect.stringMatching(/^onset \d+(\.\d)? мс > 400$/)]);
  });

  it("кореляція: удари ≥ 0.3 (протифаза й декорельований шум — ні), прольоти ≥ −0.2", () => {
    const anti = checkSfxPcm("impact.1", noiseHit("anti"));
    expect(anti.correlation).toBe(-1);
    expect(anti.reasons).toEqual(["кореляція L/R -1 < 0.3"]);
    const wide = checkSfxPcm("click.3", noiseHit("decor"));
    expect(Math.abs(wide.correlation as number)).toBeLessThan(0.1);
    expect(wide.ok).toBe(false);

    const w = checkSfxPcm("whoosh.1", whoosh("decor"));
    expect(w.reasons).toEqual([]);
    expect(checkSfxPcm("swoosh.2", whoosh("anti")).reasons).toEqual(["кореляція L/R -1 < -0.2"]);
  });

  it("пороги з SOUND_CUE_TRAITS: scan — onset ≤ 150 мс, typing — ≤ 50; glitch широкий (≥ −0.2)", () => {
    const late = noiseHit("mono", { leadSec: 0.12 });
    expect(checkSfxPcm("scan.1", late).reasons).toEqual([]);
    expect(checkSfxPcm("typing.1", late).reasons).toEqual([
      expect.stringMatching(/^onset \d+(\.\d)? мс > 50$/),
    ]);

    const decor = checkSfxPcm("glitch.4", noiseHit("decor"));
    expect(Math.abs(decor.correlation as number)).toBeLessThan(0.1);
    expect(decor.reasons).toEqual([]);
    expect(checkSfxPcm("error.1", noiseHit("decor")).ok).toBe(false);
  });

  it("pop/ding/shimmer без впевненого тону не проходять; tick/click тону не потребують", () => {
    const noisyPop = checkSfxPcm("pop.2", noiseHit("mono"));
    expect(noisyPop.pitchHz).toBeNull();
    expect(noisyPop.reasons).toEqual(["немає впевненої висоти тону"]);
    expect(checkSfxPcm("shimmer.1", noiseHit("mono")).ok).toBe(false);
    const tick = checkSfxPcm("tick.1", noiseHit("mono"));
    expect(tick.ok).toBe(true);
    expect(tick.pitchHz).toBeNull();
  });

  it("кілька порушень перелічуються всі; тиша — порожній семпл", () => {
    const qc = checkSfxPcm("ding.3", noiseHit("anti", { leadSec: 0.1, peakDb: -20 }));
    expect(qc.reasons).toHaveLength(4);
    const silent = checkSfxPcm("pop.1", createStereo(SAMPLE_RATE / 2));
    expect(silent.ok).toBe(false);
    expect(silent.onsetMs).toBeNull();
    expect(silent.reasons[0]).toBe("семпл порожній або тихий");
  });

  it("cue з мітки варіанта; кастомний cue — пік, onset і лише протифаза", () => {
    expect(sfxQcCue("pop.2")).toBe("pop");
    expect(sfxQcCue("whoosh")).toBe("whoosh");
    expect(sfxQcCue("cup-clink")).toBeNull();
    expect(checkSfxPcm("cup-clink", noiseHit("decor")).ok).toBe(true);
    expect(checkSfxPcm("cup-clink", noiseHit("anti")).ok).toBe(false);
    expect(checkSfxPcm("cup-clink", noiseHit("mono", { peakDb: -20 })).ok).toBe(false);
  });
});

describe("хук QC", () => {
  const wavDecode = async (bytes: Buffer) => decodeWav(bytes);

  it("декодує семпл і перевіряє; недекодований файл — помилка хука, а не ok=false", async () => {
    const hook = createSfxQc({ decode: wavDecode });
    const def = { text: "pop", durationSeconds: 0.5 };
    const good = await hook(encodeWav(tone(523.25)), "pop.3", def);
    expect(good.ok).toBe(true);
    const quiet = await hook(encodeWav(tone(523.25, { peakDb: -26 })), "pop.3", def);
    expect(quiet.ok).toBe(false);
    await expect(hook(Buffer.from("SFX:pop"), "pop.3", def)).rejects.toThrow();
  });

  it("передає signal декодеру", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const hook = createSfxQc({
      decode: async (bytes, opts) => {
        signals.push(opts?.signal);
        return decodeWav(bytes);
      },
    });
    const ctrl = new AbortController();
    await hook(encodeWav(tone(440)), "ding.1", { text: "d", durationSeconds: 1 }, ctrl.signal);
    expect(signals).toEqual([ctrl.signal]);
  });

  it.skipIf(!findFfmpeg())("defaultSfxQc декодує через decodeAudio", async () => {
    const qc = await defaultSfxQc(encodeWav(tone(880)), "ding.1", { text: "d", durationSeconds: 1 });
    expect(qc.ok).toBe(true);
    expect(qc.pitchHz).toBeGreaterThan(860);
  });

  it("у прогріві: тихий семпл → повторна генерація; у кеш — спроба, що пройшла, з qc і attempts", async () => {
    const storage = tmpStorage();
    const quiet = encodeWav(tone(880, { peakDb: -30 }));
    const good = encodeWav(tone(880, { peakDb: -2 }));
    const client = mockElevenLabs({ convert: [quiet, good] });
    const def = { text: "glass ding", durationSeconds: 1 };
    const cost = createCostRecorder(storage, loadPrices(), {
      projectId: null,
      rev: null,
      stage: "sfx-cache",
      phase: "first_delivery",
      source: "test",
      attempt: 1,
    });
    const file = await ensureStandardSfx(
      { storage, client: () => client, gate: instantGate(), qc: createSfxQc({ decode: wavDecode }) },
      cost,
      "ding.1",
      def,
    );
    expect(client.calls).toHaveLength(2);
    expect((await storage.read(file.key)).equals(good)).toBe(true);
    const meta = await storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(def)), (v) => SfxCacheMeta.parse(v));
    expect(meta.qc).toMatchObject({ ok: true, reasons: [], attempts: 2 });
    expect(meta.qc?.peakDb).toBeCloseTo(-2, 0);
  });
});
