import {
  createCostRecorder,
  createPromptLoader,
  type Logger,
  loadPrices,
  noopLogger,
  projectPaths,
  readCosts,
  SoundCue,
  sharedPaths,
  shortHash,
  stableStringify,
} from "@adc/shared";
import { describe, expect, it, vi } from "vitest";
import { publicSfxFile, SFX_OUTPUT_FORMAT } from "../src/constants.ts";
import {
  dropFailedQc,
  ensureCustomSfx,
  ensureStandardSfx,
  loadSfxLibrary,
  loadStandardCues,
  SFX_QC_MAX_RETRIES,
  SfxCacheMeta,
  sfxCacheKey,
  sfxHash,
} from "../src/sfx.ts";
import { runSfxCacheCli, warmSfxCache } from "../src/sfxCache.ts";
import type { SfxQc, SfxQcHook } from "../src/sfxQc.ts";
import { decodeWav } from "../src/wav.ts";
import { audioStream, elError, instantGate, mockElevenLabs, PROJECT_ID, tmpStorage } from "./helpers.ts";

// Формати — дефолтні незалежно від `.env` розробника: порожнє значення = дефолт, `.env` його не перекриває.
vi.hoisted(() => {
  process.env.ELEVENLABS_MUSIC_FORMAT = "";
  process.env.ELEVENLABS_SFX_FORMAT = "";
});

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

  it("прогрів кешу з хуком: QC пройдено з першої спроби, у метаданих qc і формат запиту", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    await warmSfxCache({
      storage,
      prompts,
      client: () => client,
      gate: instantGate(),
      cost: sharedCost(storage),
      qc: reasonsHook,
    });
    expect(client.calls).toHaveLength(30);
    const meta = await storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(library.pop)), (v) =>
      SfxCacheMeta.parse(v),
    );
    expect(meta.qc).toMatchObject({ ok: true, reasons: [], attempts: 1 });
    expect(meta.outputFormat).toBe("mp3_44100_192");
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
    expect(file.qcOk).toBe(false);
    // Повтор — з кешу, результат QC читається з метаданих.
    const cached = await ensureStandardSfx(deps(storage, client), sharedCost(storage), "ding.1", def);
    expect(cached).toMatchObject({ generated: false, qcOk: false });

    const plain = tmpStorage();
    const once = mockElevenLabs({ convert: [audioStream("bad:2")] });
    const unchecked = await ensureStandardSfx(deps(plain, once), sharedCost(plain), "ding.1", def);
    expect(once.calls).toHaveLength(1);
    expect((await metaOf(plain)).qc).toBeNull();
    expect(unchecked.qcOk).toBeNull();
  });

  it("dropFailedQc: семпли без QC поза ротацією, якщо в cue лишається інший варіант", () => {
    const v = (cue: string, variant: number, qcOk: boolean | null) => ({ cue, variant, file: { qcOk } });
    const { kept, dropped } = dropFailedQc([
      v("click", 1, false),
      v("click", 2, false),
      v("click", 3, true),
      v("ding", 1, true),
      v("ding", 2, false),
      v("ding", 3, null),
      // Жоден варіант не пройшов — cue лишає всі (краще поганий звук, ніж подія без звуку).
      v("pop", 1, false),
      v("pop", 2, false),
    ]);
    expect(kept.map((f) => `${f.cue}.${f.variant}`)).toEqual([
      "click.3",
      "ding.1",
      "ding.3",
      "pop.1",
      "pop.2",
    ]);
    expect(dropped.map((f) => `${f.cue}.${f.variant}`)).toEqual(["click.1", "click.2", "ding.2"]);
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

/** Сирий PCM 16 біт LE, як його віддає ElevenLabs у `pcm_44100` (без заголовка). */
function rawPcm(seconds: number, channels: 1 | 2): Buffer {
  const frames = Math.round(seconds * 44_100);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(i / 20) * 16_000);
    buf.writeInt16LE(v, i * channels * 2);
    if (channels === 2) buf.writeInt16LE(-v, i * channels * 2 + 2);
  }
  return buf;
}

/** Модулі, завантажені заново з іншим env форматів (формати читаються при завантаженні модуля). */
async function withFormatEnv<T>(env: Record<string, string>, load: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  try {
    return await load();
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

function captureLogger(): Logger & { warns: Array<{ msg: string; meta?: Record<string, unknown> }> } {
  const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (msg, meta) => {
      warns.push({ msg, ...(meta ? { meta: meta as Record<string, unknown> } : {}) });
    },
    child: () => logger,
  };
  return Object.assign(logger, { warns });
}

/** Відмова ElevenLabs «формат недоступний на тарифі». */
const formatDenied = () =>
  elError(403, {
    detail: {
      status: "output_format_not_allowed",
      message: "To use output format pcm_44100 you need to be subscribed to Pro tier or above.",
    },
  });

describe("формат вихідних даних SFX (A1)", () => {
  const def = { text: "glass ding", durationSeconds: 1 };

  it("запит у SFX_OUTPUT_FORMAT (дефолт mp3_44100_192); формат — у хеші, 128 — старий хеш без поля", async () => {
    expect(SFX_OUTPUT_FORMAT).toBe("mp3_44100_192");
    const storage = tmpStorage();
    const client = mockElevenLabs();
    const file = await ensureStandardSfx(
      { storage, client: () => client, gate: instantGate() },
      sharedCost(storage),
      "ding.1",
      def,
    );
    expect(client.calls[0]?.request).toMatchObject({ outputFormat: "mp3_44100_192" });
    expect(file.key).toBe(sharedPaths.sfxCache(sfxHash(def)));
    expect(file.key.endsWith(".mp3")).toBe(true);

    const hashes = new Set([
      sfxHash(def),
      sfxHash(def, "mp3_44100_192"),
      sfxHash(def, "mp3_44100_128"),
      sfxHash(def, "pcm_44100"),
    ]);
    expect(hashes.size).toBe(3);
    expect(sfxHash(def)).toBe(sfxHash(def, "mp3_44100_192"));
    // Кеш до A1 (mp3_44100_128) лишається валідним: хеш той самий, що й до появи формату в хеші.
    expect(sfxHash(def, "mp3_44100_128")).toBe(
      shortHash(
        stableStringify({
          text: def.text,
          durationSeconds: 1,
          promptInfluence: 0.6,
          modelId: "eleven_text_to_sound_v2",
        }),
      ),
    );
  });

  it("формат недоступний на тарифі → рівно один повтор у mp3_44100_128, попередження в лозі", async () => {
    const storage = tmpStorage();
    const logger = captureLogger();
    const client = mockElevenLabs({ convert: [formatDenied(), audioStream("FALLBACK")] });
    const file = await ensureStandardSfx(
      { storage, client: () => client, gate: instantGate(), logger },
      sharedCost(storage),
      "ding.1",
      def,
    );
    expect(client.calls.map((c) => c.request.outputFormat)).toEqual(["mp3_44100_192", "mp3_44100_128"]);
    expect((await storage.read(file.key)).toString()).toBe("FALLBACK");
    const meta = await storage.readJson(sharedPaths.sfxCacheMeta(sfxHash(def)), (v) => SfxCacheMeta.parse(v));
    expect(meta.outputFormat).toBe("mp3_44100_128");
    expect(logger.warns.map((w) => w.msg)).toEqual([
      "формат SFX недоступний на тарифі — повтор у фолбек-форматі",
    ]);
    expect(logger.warns[0]?.meta).toMatchObject({ format: "mp3_44100_192", fallback: "mp3_44100_128" });
    // Відхилений запит не тарифікується.
    expect(await readCosts(storage, null)).toHaveLength(1);
  });

  it("фолбек теж відхилено або formatFallback: null → помилка, без нових повторів", async () => {
    const storage = tmpStorage();
    const twice = mockElevenLabs({ convert: [formatDenied(), formatDenied()] });
    await expect(
      ensureStandardSfx({ storage, client: () => twice, gate: instantGate() }, sharedCost(storage), "d", def),
    ).rejects.toThrow();
    expect(twice.calls).toHaveLength(2);

    const off = mockElevenLabs({ convert: [formatDenied()] });
    await expect(
      ensureStandardSfx(
        { storage, client: () => off, gate: instantGate(), formatFallback: null },
        sharedCost(storage),
        "d",
        def,
      ),
    ).rejects.toThrow();
    expect(off.calls).toHaveLength(1);
  });

  it("pcm_44100: PCM загортається у WAV одразу, кеш і public — `.wav`, інший хеш; повтор — кеш", async () => {
    const { sfx, constants } = await withFormatEnv({ ELEVENLABS_SFX_FORMAT: "pcm_44100" }, async () => ({
      sfx: await import("../src/sfx.ts"),
      constants: await import("../src/constants.ts"),
    }));
    expect(constants.SFX_OUTPUT_FORMAT).toBe("pcm_44100");
    expect(sfx.sfxHash(def)).toBe(sfxHash(def, "pcm_44100"));
    expect(sfx.sfxHash(def)).not.toBe(sfxHash(def));

    const storage = tmpStorage();
    const client = mockElevenLabs({ convert: [rawPcm(1, 2)] });
    const deps = { storage, client: () => client, gate: instantGate() };
    const file = await sfx.ensureStandardSfx(deps, sharedCost(storage), "ding.1", def);
    expect(client.calls[0]?.request).toMatchObject({ outputFormat: "pcm_44100" });
    expect(file.key).toBe(sfxCacheKey(sfx.sfxHash(def), "wav"));
    const wav = decodeWav(await storage.read(file.key));
    expect(wav.left.length).toBe(44_100);
    // Стерео розпізнано за тривалістю: канали в протифазі (так згенеровано), а не склеєні в моно.
    expect(wav.left[20]).toBeCloseTo(-(wav.right[20] as number), 3);
    const meta = await storage.readJson(sharedPaths.sfxCacheMeta(sfx.sfxHash(def)), (v) =>
      SfxCacheMeta.parse(v),
    );
    expect(meta.outputFormat).toBe("pcm_44100");
    expect(publicSfxFile("ding", file.key)).toBe("sfx/ding.wav");
    expect(publicSfxFile("ding")).toBe("sfx/ding.mp3");

    const again = await sfx.ensureStandardSfx(deps, sharedCost(storage), "ding.1", def);
    expect(again).toMatchObject({ key: file.key, generated: false });
    expect(client.calls).toHaveLength(1);

    // Кастомний cue: кеш проєкту `<hash>.wav`; моно-PCM дублюється в обидва канали.
    const mono = mockElevenLabs({ convert: [rawPcm(1, 1)] });
    const custom = await sfx.ensureCustomSfx(
      { storage, client: () => mono, gate: instantGate() },
      sharedCost(storage),
      PROJECT_ID,
      "cup",
      def,
    );
    expect(custom.key).toBe(projectPaths(PROJECT_ID).sfx(`${sfx.sfxHash(def)}.wav`));
    const monoWav = decodeWav(await storage.read(custom.key));
    expect(monoWav.left.length).toBe(44_100);
    expect(monoWav.right[20]).toBe(monoWav.left[20]);
  });

  it("pcm_44100 недоступний → фолбек mp3 лежить як `.mp3` під хешем запиту і знаходиться в кеші", async () => {
    const sfx = await withFormatEnv({ ELEVENLABS_SFX_FORMAT: "pcm_44100" }, () => import("../src/sfx.ts"));
    const storage = tmpStorage();
    const client = mockElevenLabs({ convert: [formatDenied(), audioStream("MP3")] });
    const deps = { storage, client: () => client, gate: instantGate() };
    const file = await sfx.ensureStandardSfx(deps, sharedCost(storage), "ding.1", def);
    expect(file.key).toBe(sfxCacheKey(sfx.sfxHash(def), "mp3"));
    expect((await storage.read(file.key)).toString()).toBe("MP3");
    const again = await sfx.ensureStandardSfx(deps, sharedCost(storage), "ding.1", def);
    expect(again).toMatchObject({ key: file.key, generated: false });
    expect(client.calls).toHaveLength(2);
  });
});
