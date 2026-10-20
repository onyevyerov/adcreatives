import {
  type CostEvent,
  type CostInput,
  type CostRecorder,
  projectPaths,
  SoundCue,
  shortHash,
} from "@adc/shared";
import { describe, expect, it, vi } from "vitest";
import { EpidemicGate } from "../src/epidemic/gate.ts";
import {
  EPIDEMIC_SFX_FADE_MS,
  EpidemicSfxMeta,
  ensureEpidemicSfxVariants,
  epidemicSfxTerm,
  loadSfxTerms,
  orderSfxCandidates,
  parseSfxTerms,
  trimLeadingSilence,
  worthRetry,
} from "../src/epidemic/sfx.ts";
import { createStereo, pcmLength, SAMPLE_RATE } from "../src/pcm.ts";
import {
  cacheOnlyQuota,
  EpidemicError,
  type EpidemicSoundEffect,
  type SfxVariantRequest,
} from "../src/provider.ts";
import type { CueDefinition } from "../src/sfx.ts";
import type { SfxQc, SfxQcHook } from "../src/sfxQc.ts";
import { decodeWav, encodeWav } from "../src/wav.ts";
import { memoryQuota, mockEpidemic } from "./epidemicHelpers.ts";
import { instantGate, PROJECT_ID, tmpStorage } from "./helpers.ts";

/** B3: семпли Epidemic за cue — один пошук на cue, лише запитані варіанти, QC з одним повтором, обрізання. */

/** Тон (пік 0.8) у WAV — те, що «завантажує» мок; `silence` с тиші на початку входять у `seconds`. */
function toneWav(seconds: number, silence = 0): Buffer {
  const pcm = createStereo(Math.round(seconds * SAMPLE_RATE));
  const lead = Math.round(silence * SAMPLE_RATE);
  for (let i = lead; i < pcmLength(pcm); i++) {
    const v = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    pcm.left[i] = v;
    pcm.right[i] = v;
  }
  return encodeWav(pcm);
}

const fx = (id: string, length: number): EpidemicSoundEffect => ({ id, title: `T ${id}`, length });
const def = (durationSeconds: number, text = "A single fast whoosh, dry"): CueDefinition => ({
  text,
  durationSeconds,
});
const req = (cue: string, variant: number, d = def(0.8), custom = false): SfxVariantRequest => ({
  cue,
  variant,
  def: d,
  custom,
});

const qcResult = (reasons: string[]): SfxQc => ({
  ok: reasons.length === 0,
  peakDb: -1,
  onsetMs: 0,
  correlation: 1,
  pitchHz: null,
  reasons,
  attempts: 1,
});

function fakeCost(): CostRecorder & { inputs: CostInput[] } {
  const inputs: CostInput[] = [];
  return {
    inputs,
    record: async (input) => {
      inputs.push(input);
      return {} as CostEvent;
    },
  };
}

/** Тривалість файлу за id (секунди): за замовчуванням 0.6 с. */
function setup(
  opts: {
    search?: Record<string, EpidemicSoundEffect[]>;
    lengths?: Record<string, number>;
    qc?: SfxQcHook;
    quotaStart?: number;
    cacheOnly?: boolean;
    /** Секунди тиші перед тоном у «завантаженому» файлі. */
    leadSilence?: number;
  } = {},
) {
  const client = mockEpidemic({
    searchSoundEffects: Array.from({ length: 20 }, () => (q: unknown) => ({
      soundEffects: opts.search?.[(q as { term: string }).term] ?? [],
    })),
    fetchBytes: Array.from({ length: 20 }, () => (url: unknown) => {
      const id = String(url).replace(/^.*\/(.+)\.mp3$/, "$1");
      return toneWav(opts.lengths?.[id] ?? 0.6, opts.leadSilence ?? 0);
    }),
  });
  const quota = memoryQuota(opts.quotaStart ?? 0);
  const cache = tmpStorage();
  const storage = tmpStorage();
  const gate = new EpidemicGate();
  const runs: string[] = [];
  const run = gate.run.bind(gate);
  gate.run = (label, fn, signal) => {
    runs.push(label);
    return run(label, fn, signal);
  };
  const cost = fakeCost();
  const deps = {
    storage,
    client: () => {
      throw new Error("ElevenLabs не викликається");
    },
    gate: instantGate(),
    ...(opts.qc ? { qc: opts.qc } : {}),
    epidemic: { client: () => client, quota, cache, gate, ...(opts.cacheOnly ? { cacheOnly: true } : {}) },
    cost,
    projectId: PROJECT_ID,
  };
  const count = (method: string) => client.calls.filter((c) => c.method === method).length;
  return { deps, client, quota, cache, storage, cost, runs, count };
}

const WHOOSH = "fast clean air whoosh transition";

describe("sfx-terms.md", () => {
  it("покриває всі SoundCue.options", () => {
    const terms = loadSfxTerms();
    for (const cue of SoundCue.options) expect(terms[cue], cue).toMatch(/\S/);
    expect(terms.whoosh).toBe(WHOOSH);
  });

  it("відсутній cue — помилка розбору", () => {
    const body = SoundCue.options
      .filter((c) => c !== "pop")
      .map((c) => `- ${c}: phrase ${c}`)
      .join("\n");
    expect(() => parseSfxTerms(body)).toThrow(/pop/);
    expect(parseSfxTerms(`${body}\n- pop: soft pop`).pop).toBe("soft pop");
  });

  it("кастомний cue — текст до першої коми або 120 символів", () => {
    const terms = loadSfxTerms();
    expect(
      epidemicSfxTerm(req("cup-clink", 1, def(0.5, "A ceramic cup clink, dry, no reverb"), true), terms),
    ).toBe("A ceramic cup clink");
    const long = "x".repeat(200);
    expect(epidemicSfxTerm(req("hum", 1, def(1, long), true), terms)).toHaveLength(120);
    expect(epidemicSfxTerm(req("whoosh", 2), terms)).toBe(WHOOSH);
  });
});

describe("orderSfxCandidates", () => {
  it("спершу не довші за max(2×cue, 1.5) с, усередині — порядок best-match", () => {
    const list = [fx("a", 5), fx("b", 1.2), fx("c", 1.6), fx("d", 0.3), fx("e", 1.5)];
    expect(orderSfxCandidates(list, 0.5).map((s) => s.id)).toEqual(["b", "d", "e", "a", "c"]);
    expect(orderSfxCandidates(list, 1).map((s) => s.id)).toEqual(["b", "c", "d", "e", "a"]);
  });
});

describe("ensureEpidemicSfxVariants", () => {
  const search = { [WHOOSH]: [fx("w1", 0.6), fx("w2", 0.7), fx("w3", 0.5), fx("w4", 0.9)] };

  it("один пошук на cue, завантаження лише запитаних варіантів; файли у сховищі проєкту", async () => {
    const t = setup({ search });
    const out = await ensureEpidemicSfxVariants(t.deps, [
      req("whoosh", 1),
      req("whoosh", 3),
      req("whoosh", 2),
    ]);
    expect(t.count("searchSoundEffects")).toBe(1);
    expect(t.client.calls.find((c) => c.method === "searchSoundEffects")?.args[0]).toEqual({
      term: WHOOSH,
      sort: "best-match",
      limit: 30,
    });
    expect(t.count("soundEffectDownloadUrl")).toBe(3);
    expect(t.count("fetchBytes")).toBe(3);
    expect(t.quota.consumed).toEqual([
      { kind: "sfx", id: "w1", detail: "whoosh.1" },
      { kind: "sfx", id: "w3", detail: "whoosh.3" },
      { kind: "sfx", id: "w2", detail: "whoosh.2" },
    ]);
    expect(out.map((o) => [o.cue, o.variant, o.epidemicId, o.title])).toEqual([
      ["whoosh", 1, "w1", "T w1"],
      ["whoosh", 3, "w3", "T w3"],
      ["whoosh", 2, "w2", "T w2"],
    ]);
    const first = out[0]?.file;
    expect(first).toMatchObject({
      cue: "whoosh",
      key: `${projectPaths(PROJECT_ID).audioDir}/epidemic-sfx/w1.wav`,
      hash: "ep-w1",
      durationMs: 600,
      generated: true,
      qcOk: null,
    });
    expect(decodeWav(await t.storage.read(first?.key ?? "")).left.length).toBe(Math.round(0.6 * SAMPLE_RATE));
    // Постійний кеш: сирий файл, meta і пошук.
    expect(await t.cache.exists("sfx/w1.mp3")).toBe(true);
    const meta = await t.cache.readJson("sfx/w1.json", (v) => EpidemicSfxMeta.parse(v));
    expect(meta).toMatchObject({
      id: "w1",
      title: "T w1",
      length: 0.6,
      cue: "whoosh",
      term: WHOOSH,
      qc: null,
    });
    expect(await t.cache.exists(`sfx/search/${shortHash(WHOOSH)}.json`)).toBe(true);
    expect(t.cost.inputs).toEqual([
      {
        provider: "epidemic",
        kind: "sfx",
        model: "epidemic-catalog",
        seconds: 0.6,
        detail: "sfx:whoosh.1:w1",
      },
      {
        provider: "epidemic",
        kind: "sfx",
        model: "epidemic-catalog",
        seconds: 0.5,
        detail: "sfx:whoosh.3:w3",
      },
      {
        provider: "epidemic",
        kind: "sfx",
        model: "epidemic-catalog",
        seconds: 0.7,
        detail: "sfx:whoosh.2:w2",
      },
    ]);
    // Мережа — лише через чергу Epidemic.
    expect(t.runs.filter((l) => l.startsWith("sfx-search:"))).toHaveLength(1);
    expect(t.runs.filter((l) => l.startsWith("sfx-download:"))).toHaveLength(3);
    expect(t.runs.filter((l) => l.startsWith("sfx-fetch:"))).toHaveLength(3);
  });

  it("другий виклик з тими самими (cue, variant) — без пошуку, завантажень і consume", async () => {
    const t = setup({ search });
    await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1), req("whoosh", 2)]);
    const calls = t.client.calls.length;
    const again = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 2), req("whoosh", 1)]);
    expect(t.client.calls.length).toBe(calls);
    expect(t.quota.consumed).toHaveLength(2);
    expect(t.cost.inputs).toHaveLength(2);
    expect(again.map((o) => [o.epidemicId, o.file.generated])).toEqual([
      ["w2", false],
      ["w1", false],
    ]);
  });

  it("варіант k — (k−1) mod n кандидат; довші за 2× cue — у кінці", async () => {
    const t = setup({ search: { [WHOOSH]: [fx("long", 4), fx("ok1", 0.6), fx("ok2", 1)] } });
    const out = await ensureEpidemicSfxVariants(t.deps, [
      req("whoosh", 1),
      req("whoosh", 3),
      req("whoosh", 5),
    ]);
    expect(out.map((o) => o.epidemicId)).toEqual(["ok1", "long", "ok2"]);
  });

  it("cue без результатів пошуку — без семпла (подія німіє), решта — як завжди", async () => {
    const t = setup({ search });
    const out = await ensureEpidemicSfxVariants(t.deps, [req("pop", 1, def(0.5)), req("whoosh", 1)]);
    expect(out.map((o) => o.cue)).toEqual(["whoosh"]);
    expect(t.count("searchSoundEffects")).toBe(2);
    expect(t.quota.consumed).toHaveLength(1);
  });

  it("QC не пройшов — рівно один повтор наступним кандидатом; лишається кращий", async () => {
    const reasons: Record<string, string[]> = { w1: ["пік", "onset"], w2: ["onset"], w3: ["x", "y", "z"] };
    const qc = vi.fn<SfxQcHook>(async (audio) => {
      // Розрізняємо семпли за довжиною WAV.
      const len = decodeWav(audio).left.length;
      const id = Object.keys(lengths).find((k) => Math.round((lengths[k] ?? 0) * SAMPLE_RATE) === len) ?? "";
      return qcResult(reasons[id] ?? []);
    });
    const lengths: Record<string, number> = { w1: 0.6, w2: 0.7, w3: 0.5, w4: 0.55 };
    const t = setup({ search, lengths, qc });
    const [first] = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1)]);
    expect(qc).toHaveBeenCalledTimes(2);
    expect(t.quota.consumed.map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(first?.epidemicId).toBe("w2");
    expect(first?.file).toMatchObject({ hash: "ep-w2", qcOk: false, generated: true });
    const meta = await t.cache.readJson("sfx/w1.json", (v) => EpidemicSfxMeta.parse(v));
    expect(meta.qc?.reasons).toEqual(["пік", "onset"]);

    // Повтор гірший — лишається перший; другий виклик — нуль завантажень.
    const t2 = setup({ search, lengths: { ...lengths }, qc });
    reasons.w1 = ["пік"];
    reasons.w2 = ["a", "b"];
    const [kept] = await ensureEpidemicSfxVariants(t2.deps, [req("whoosh", 1)]);
    expect(kept?.epidemicId).toBe("w1");
    await ensureEpidemicSfxVariants(t2.deps, [req("whoosh", 1)]);
    expect(t2.quota.consumed).toHaveLength(2);
  });

  it("QC пройшов — без повтору; qcOk true; meta з QC", async () => {
    const qc = vi.fn<SfxQcHook>(async () => qcResult([]));
    const t = setup({ search, qc });
    const [out] = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 2)]);
    expect(qc).toHaveBeenCalledTimes(1);
    expect(qc.mock.calls[0]?.[1]).toBe("whoosh");
    expect(out?.file.qcOk).toBe(true);
    expect(t.quota.consumed).toHaveLength(1);
    expect((await t.cache.readJson("sfx/w2.json", (v) => EpidemicSfxMeta.parse(v))).qc?.ok).toBe(true);
  });

  it("повтор не бере кандидата, який уже є основним для іншого запитаного варіанта", async () => {
    const qc = vi.fn<SfxQcHook>(async (audio) =>
      qcResult(decodeWav(audio).left.length === Math.round(0.6 * SAMPLE_RATE) ? ["пік"] : []),
    );
    const t = setup({ search, qc, lengths: { w1: 0.6, w2: 0.7, w3: 0.5, w4: 0.55 } });
    const out = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1), req("whoosh", 2)]);
    expect(out.map((o) => o.epidemicId)).toEqual(["w3", "w2"]);
  });

  it("файл довший за cue обрізано до cue з fade-out наприкінці", async () => {
    const t = setup({ search: { [WHOOSH]: [fx("w1", 1.4)] }, lengths: { w1: 1.4 } });
    const [out] = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1, def(0.8))]);
    expect(out?.file.durationMs).toBe(800);
    const pcm = decodeWav(await t.storage.read(out?.file.key ?? ""));
    const n = Math.round(0.8 * SAMPLE_RATE);
    expect(pcm.left.length).toBe(n);
    expect(Math.abs(pcm.left[n - 1] ?? 1)).toBeLessThan(0.01);
    // До fade — повна гучність, всередині fade — тихіше за тон.
    const fade = Math.round((EPIDEMIC_SFX_FADE_MS / 1000) * SAMPLE_RATE);
    const peak = (a: number, b: number) => Math.max(...Array.from(pcm.left.subarray(a, b), Math.abs));
    expect(peak(n - fade - 400, n - fade)).toBeGreaterThan(0.75);
    expect(peak(n - fade / 4, n)).toBeLessThan(0.25);
    // Сирий файл у кеші — повний.
    expect(decodeWav(await t.cache.read("sfx/w1.mp3")).left.length).toBe(Math.round(1.4 * SAMPLE_RATE));
  });

  it("квота 45 — помилка до завантаження", async () => {
    const t = setup({ search, quotaStart: 45 });
    await expect(ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1)])).rejects.toBeInstanceOf(EpidemicError);
    expect(t.count("soundEffectDownloadUrl")).toBe(0);
    expect(t.count("fetchBytes")).toBe(0);
    expect(t.cost.inputs).toHaveLength(0);
  });

  it("кастомний cue — пошук за текстом до коми", async () => {
    const term = "A ceramic cup clink";
    const t = setup({ search: { [term]: [fx("c1", 0.4)] } });
    const out = await ensureEpidemicSfxVariants(t.deps, [
      req("cup-clink", 1, def(0.5, `${term}, dry, no reverb`), true),
    ]);
    expect(out.map((o) => [o.cue, o.epidemicId])).toEqual([["cup-clink", "c1"]]);
    expect(t.quota.consumed).toEqual([{ kind: "sfx", id: "c1", detail: "cup-clink.1" }]);
  });
});

describe("тиша на початку і повтори QC", () => {
  const search = { [WHOOSH]: [fx("w1", 1.2), fx("w2", 1.2)] };

  it("trimLeadingSilence лишає 5 мс перед першим звуком; без тиші — той самий PCM", () => {
    const pcm = decodeWav(toneWav(1, 0.5));
    const trimmed = trimLeadingSilence(pcm);
    const lead = Math.round(0.5 * SAMPLE_RATE) - Math.round(0.005 * SAMPLE_RATE);
    // Перший ненульовий семпл синуса — на індексі lead+1 (sin(0) = 0).
    expect(pcmLength(trimmed)).toBeGreaterThanOrEqual(pcmLength(pcm) - lead - 2);
    expect(pcmLength(trimmed)).toBeLessThanOrEqual(pcmLength(pcm) - lead + 2);
    const loud = decodeWav(toneWav(0.3));
    expect(trimLeadingSilence(loud)).toBe(loud);
  });

  it("семпл із тишею на початку: обрізання за тривалістю лишає звук, а не тишу", async () => {
    const t = setup({ search, leadSilence: 0.6, lengths: { w1: 1.2 } });
    const out = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1, def(0.4))]);
    const pcm = decodeWav(await t.storage.read(out[0]?.file.key ?? ""));
    let peak = 0;
    for (const v of pcm.left) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.7);
    expect(out[0]?.file.durationMs).toBe(400);
  });

  it("worthRetry: лише відсутність висоти тону — без повтору й зайвого завантаження", async () => {
    expect(worthRetry(qcResult(["немає впевненої висоти тону"]))).toBe(false);
    expect(worthRetry(qcResult(["пік -30 dBFS < -12"]))).toBe(true);
    expect(worthRetry(qcResult([]))).toBe(false);
    const t = setup({ search, qc: async () => qcResult(["немає впевненої висоти тону"]) });
    const out = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1)]);
    expect(t.quota.consumed).toHaveLength(1);
    expect(out[0]?.file.qcOk).toBe(false);
  });
});

describe("режим «лише кеш»", () => {
  const search = { [WHOOSH]: [fx("w1", 0.6), fx("w2", 0.6), fx("w3", 0.6)] };

  /** Прогріває кеш звичайним прогоном і повертає той самий кеш для другого виклику в режимі «лише кеш». */
  async function warm(variants: number[]) {
    const first = setup({ search });
    await ensureEpidemicSfxVariants(
      first.deps,
      variants.map((v) => req("whoosh", v)),
    );
    const t = setup({ search, cacheOnly: true });
    t.deps.epidemic.cache = first.cache;
    return t;
  }

  it("варіант k — k-й із уже завантажених; жодного запиту й consume", async () => {
    // У кеші w1 і w3 (варіанти 1 і 3); у режимі «лише кеш» варіант 2 — другий закешований, тобто w3.
    const t = await warm([1, 3]);
    const out = await ensureEpidemicSfxVariants(t.deps, [
      req("whoosh", 1),
      req("whoosh", 2),
      req("whoosh", 3),
    ]);
    expect(out.map((o) => [o.variant, o.epidemicId, o.file.generated])).toEqual([
      [1, "w1", false],
      [2, "w3", false],
      [3, "w1", false],
    ]);
    expect(t.client.calls).toEqual([]);
    expect(t.quota.consumed).toEqual([]);
  });

  it("cue без кешу пошуку — без запиту, подія без звуку", async () => {
    const t = await warm([1]);
    const out = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1), req("pop", 1)]);
    expect(out.map((o) => o.cue)).toEqual(["whoosh"]);
    expect(t.client.calls).toEqual([]);
  });

  it("повтор QC — лише серед закешованих", async () => {
    const t = await warm([1]);
    const qc = vi.fn<SfxQcHook>(async () => qcResult(["пік -30 dBFS < -12"]));
    t.deps.qc = qc;
    const out = await ensureEpidemicSfxVariants(t.deps, [req("whoosh", 1)]);
    // Закешований лише w1 — повторювати нічим.
    expect(qc).toHaveBeenCalledTimes(1);
    expect(out[0]?.epidemicId).toBe("w1");
    expect(t.quota.consumed).toEqual([]);
  });

  it("cacheOnlyQuota: consume завжди — EpidemicError quota, лічильник не змінюється", async () => {
    const inner = memoryQuota(10);
    const q = cacheOnlyQuota(inner);
    await expect(q.consume("sfx", "x")).rejects.toMatchObject({ kind: "quota" });
    await expect(q.consume("sfx", "x")).rejects.toBeInstanceOf(EpidemicError);
    expect(await q.used()).toBe(10);
    expect(inner.consumed).toEqual([]);
  });
});
