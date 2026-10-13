import {
  createCostRecorder,
  createPromptLoader,
  loadPrices,
  projectPaths,
  readCosts,
  SoundCue,
  sharedPaths,
} from "@adc/shared";
import { describe, expect, it } from "vitest";
import {
  ensureCustomSfx,
  ensureStandardSfx,
  loadSfxLibrary,
  loadStandardCues,
  SFX_QC_MAX_RETRIES,
  SfxCacheMeta,
  sfxHash,
} from "../src/sfx.ts";
import { runSfxCacheCli, warmSfxCache } from "../src/sfxCache.ts";
import type { SfxQc, SfxQcHook } from "../src/sfxQc.ts";
import { audioStream, instantGate, mockElevenLabs, PROJECT_ID, tmpStorage } from "./helpers.ts";

const prompts = createPromptLoader();
const library = loadStandardCues(prompts);
const events = loadSfxLibrary(prompts);

const sharedCost = (storage: ReturnType<typeof tmpStorage>) =>
  createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "sfx-cache",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });

describe("standard SFX cache", () => {
  it("warms all 30 library variants once into cache/sfx/<hash>.mp3 with shared costs; second run is free", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    const opts = { storage, prompts, client: () => client, gate: instantGate(), cost: sharedCost(storage) };
    const first = await warmSfxCache(opts);
    expect(first.filter((f) => f.generated)).toHaveLength(30);
    expect(client.calls).toHaveLength(30);
    for (const call of client.calls) {
      expect(call.request).toMatchObject({ promptInfluence: 0.6, modelId: "eleven_text_to_sound_v2" });
    }
    expect(new Set(first.map((f) => f.cue))).toEqual(
      new Set(SoundCue.options.flatMap((c) => [1, 2, 3].map((n) => `${c}.${n}`))),
    );
    // Legacy-cue — варіант 1 бібліотеки: той самий файл.
    const whoosh = sharedPaths.sfxCache(sfxHash(library.whoosh));
    expect(sfxHash(library.whoosh)).toBe(sfxHash(events.whoosh[0] as (typeof events.whoosh)[0]));
    expect((await storage.read(whoosh)).toString()).toBe(`SFX:${library.whoosh.text}`);
    expect(await storage.exists(sharedPaths.sfxCacheMeta(sfxHash(library.whoosh)))).toBe(true);
    for (const def of events.slam)
      expect(await storage.exists(sharedPaths.sfxCache(sfxHash(def)))).toBe(true);

    const costs = await readCosts(storage, null);
    expect(costs).toHaveLength(30);
    expect(
      costs.every((c) => c.provider === "elevenlabs" && c.stage === "sfx-cache" && c.projectId === null),
    ).toBe(true);
    expect(costs.find((c) => c.detail === "sfx:riser.1")?.units).toEqual({
      seconds: events.riser[0]?.durationSeconds,
    });

    const second = await warmSfxCache(opts);
    expect(second.every((f) => !f.generated)).toBe(true);
    expect(client.calls).toHaveLength(30);
  });

  it("the CLI refuses paid calls without LIVE=1", async () => {
    const prev = process.env.LIVE;
    // "0", а не delete: loadRootEnv не перезаписує наявні змінні, тож LIVE=1 з .env не підхопиться.
    process.env.LIVE = "0";
    try {
      expect(await runSfxCacheCli([])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.LIVE;
      else process.env.LIVE = prev;
    }
  });
});

describe("custom SFX", () => {
  it("cached per project by spec hash; costs go to the project log", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    const cost = createCostRecorder(storage, loadPrices(), {
      projectId: PROJECT_ID,
      rev: 1,
      stage: "audio",
      phase: "first_delivery",
      source: "test",
      attempt: 1,
    });
    const deps = { storage, client: () => client, gate: instantGate() };
    const def = { text: "cup clink", durationSeconds: 1 };
    const a = await ensureCustomSfx(deps, cost, PROJECT_ID, "cup", def);
    const b = await ensureCustomSfx(deps, cost, PROJECT_ID, "cup", def);
    expect(a.key).toBe(projectPaths(PROJECT_ID).sfx(`${sfxHash(def)}.mp3`));
    expect([a.generated, b.generated]).toEqual([true, false]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.request).toMatchObject({
      text: "cup clink",
      durationSeconds: 1,
      promptInfluence: 0.6,
    });
    const costs = await readCosts(storage, PROJECT_ID);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ units: { seconds: 1 }, usd: 0.002 });
  });
});

describe("QC семплів SFX", () => {
  const def = { text: "glass ding", durationSeconds: 1 };
  const metaOf = (storage: ReturnType<typeof tmpStorage>) =>
    storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(def)), (v) => SfxCacheMeta.parse(v));
  /** Хук: кількість порушень зашита у вміст «аудіо» (`bad:<n>`), інакше ok. */
  const reasonsHook: SfxQcHook = async (audio): Promise<SfxQc> => {
    const n = Number(/^bad:(\d+)/.exec(audio.toString())?.[1] ?? 0);
    return {
      ok: n === 0,
      peakDb: -6,
      onsetMs: 0,
      correlation: 1,
      pitchHz: null,
      reasons: Array.from({ length: n }, (_, i) => `r${i}`),
      attempts: 1,
    };
  };
  const deps = (
    storage: ReturnType<typeof tmpStorage>,
    client: ReturnType<typeof mockElevenLabs>,
    qc?: SfxQcHook,
  ) => ({
    storage,
    client: () => client,
    gate: instantGate(),
    ...(qc ? { qc } : {}),
  });

  it("прогрів кешу з хуком за замовчуванням: QC пройдено з першої спроби, у метаданих qc і формат", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    await warmSfxCache({
      storage,
      prompts,
      client: () => client,
      gate: instantGate(),
      cost: sharedCost(storage),
    });
    expect(client.calls).toHaveLength(30);
    const meta = await storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(library.pop)), (v) =>
      SfxCacheMeta.parse(v),
    );
    expect(meta.qc).toMatchObject({ ok: true, reasons: [], attempts: 1 });
    expect(meta.outputFormat).toBe("mp3_44100_128");
  });

  it("не пройшов QC → повтор; у кеш — перша спроба, що пройшла; кожна спроба — рядок витрат", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs({
      convert: [audioStream("bad:2"), audioStream("bad:1"), audioStream("good")],
    });
    const file = await ensureStandardSfx(
      deps(storage, client, reasonsHook),
      sharedCost(storage),
      "ding.1",
      def,
    );
    expect(file.generated).toBe(true);
    expect(client.calls).toHaveLength(1 + SFX_QC_MAX_RETRIES);
    expect((await storage.read(file.key)).toString()).toBe("good");
    expect((await metaOf(storage)).qc).toMatchObject({ ok: true, reasons: [], attempts: 3 });
    expect(await readCosts(storage, null)).toHaveLength(3);
  });

  it("жодна спроба не пройшла → найкраща (менше причин), ok=false; без хука — одна спроба без QC", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs({
      convert: [audioStream("bad:2"), audioStream("bad:1"), audioStream("bad:3")],
    });
    const file = await ensureStandardSfx(
      deps(storage, client, reasonsHook),
      sharedCost(storage),
      "ding.1",
      def,
    );
    expect(client.calls).toHaveLength(3);
    expect((await storage.read(file.key)).toString()).toBe("bad:1");
    expect((await metaOf(storage)).qc).toMatchObject({ ok: false, reasons: ["r0"], attempts: 3 });

    const plain = tmpStorage();
    const once = mockElevenLabs({ convert: [audioStream("bad:2")] });
    await ensureStandardSfx(deps(plain, once), sharedCost(plain), "ding.1", def);
    expect(once.calls).toHaveLength(1);
    expect((await metaOf(plain)).qc).toBeNull();
  });

  it("старі метадані кешу без qc і outputFormat парсяться з дефолтами", () => {
    const old = {
      cue: "pop.1",
      text: "pop",
      durationSeconds: 0.5,
      modelId: "m",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(SfxCacheMeta.parse(old)).toMatchObject({ qc: null, outputFormat: "mp3_44100_128" });
  });
});
