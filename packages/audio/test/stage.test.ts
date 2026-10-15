import {
  AudioManifest,
  AudioPlan,
  createCostRecorder,
  createPromptLoader,
  type Logger,
  loadPrices,
  noopLogger,
  projectPaths,
  readCosts,
  SoundCue,
  SoundSheet,
  type Storyboard,
  sharedPaths,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import type { DecodeAudio } from "../src/decode.ts";
import { computeAudioPlacements } from "../src/manifest.ts";
import { loadSfxLibrary, loadStandardCues, sfxHash } from "../src/sfx.ts";
import type { SfxQcHook } from "../src/sfxQc.ts";
import { canReuseMusic, createAudioStage, MixMasterMeta, mixMasterMetaKey } from "../src/stage.ts";
import { decodeWav } from "../src/wav.ts";
import { fakeSample } from "./fakeSfx.ts";
import {
  audioStream,
  concurrencyBody,
  draftFor,
  elError,
  instantGate,
  makeCtx,
  mockElevenLabs,
  PROJECT_ID,
  seedProject,
  tmpStorage,
} from "./helpers.ts";
import { metronome } from "./signals.ts";

const standardCues = loadStandardCues(createPromptLoader());
const sfxLibrary = loadSfxLibrary(createPromptLoader());
/** Текст запиту SFX → cue і варіант бібліотеки (мок ElevenLabs віддає `SFX:<текст>`). */
const variantByText = new Map(
  Object.entries(sfxLibrary).flatMap(([cue, variants]) =>
    variants.map((def, i) => [def.text, { cue: cue as SoundCue, variant: i + 1 }] as const),
  ),
);
/** Cue подій фікстури: whoosh (s1), impact (price-hit), pop (s2), shimmer (s3). */
const FIXTURE_EVENT_CUES = ["whoosh", "impact", "pop", "shimmer"] as const;
/** Заміри мастера в `audio.json`: LUFS і dBTP міряються, підсилення суми поки 0 дБ. */
const MASTER_METRICS = {
  integratedLufs: expect.any(Number),
  truePeakDbtp: expect.any(Number),
  masterGainDb: expect.any(Number),
};
const variantTexts = (cues: readonly SoundCue[]) => cues.flatMap((c) => sfxLibrary[c].map((d) => d.text));
/** Номери варіантів кожного cue бібліотеки. */
const VARIANTS = [1, 2, 3, 4, 5] as const;

/** Прогріває спільний кеш варіантами `variants` (номери) заданих cue. */
async function warmCache(
  storage: ReturnType<typeof tmpStorage>,
  cues: readonly SoundCue[],
  variants: readonly number[] = VARIANTS,
) {
  for (const cue of cues) {
    for (const n of variants) {
      const def = sfxLibrary[cue][n - 1];
      if (def) await storage.write(sharedPaths.sfxCache(sfxHash(def)), `CACHED:${def.text}`);
    }
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

/** Розкадровка з кастомним SFX у другій сцені. */
const withCustomCue: Storyboard = {
  ...fixtureStoryboard,
  scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s2" ? { ...s, sfxCue: "cup-clink" } : s)),
};

function draftWithCustom(storyboard: Storyboard) {
  return draftFor(computeChunkLayout(storyboard), {
    sfx: [
      { cue: "cup-clink", text: "ceramic cup clink on a wooden table", durationSeconds: 0.8, custom: true },
    ],
  });
}

/**
 * Декодер-мок: замість mp3 (мок віддає текст) — синтетичний «трек-метроном» 16 с для музики
 * і фейковий семпл бібліотеки для SFX (за текстом запиту).
 */
function fakeDecoder(opts: { fail?: boolean; failSfx?: (cue: SoundCue) => boolean } = {}) {
  const calls: string[] = [];
  const decode: DecodeAudio = async (bytes) => {
    const m = /^(?:SFX|CACHED):([\s\S]*)$/.exec(bytes.toString());
    const hit = m ? variantByText.get(m[1] ?? "") : undefined;
    if (hit) {
      calls.push(`${hit.cue}.${hit.variant}`);
      if (opts.failSfx?.(hit.cue)) throw new Error("битий mp3");
      return fakeSample(hit.cue, hit.variant);
    }
    calls.push("music");
    if (opts.fail) throw new Error("ffmpeg не знайдено");
    return metronome({ bpm: 85, offsetSec: 0.05, durationSec: 16, busy: true, pad: true });
  };
  return Object.assign(decode, {
    calls,
    musicCalls: () => calls.filter((c) => c === "music").length,
    sfxCalls: () => calls.filter((c) => c !== "music"),
  });
}

const PASSING_QC = {
  ok: true,
  peakDb: null,
  onsetMs: null,
  correlation: null,
  pitchHz: null,
  reasons: [],
  attempts: 1,
};

function stage(
  client: ReturnType<typeof mockElevenLabs>,
  storage: ReturnType<typeof tmpStorage>,
  decode: DecodeAudio = fakeDecoder(),
) {
  const gate = instantGate();
  const sharedCost = createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "sfx-cache",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  // QC семплів перевіряється в `sfxQc.test.ts`; тут байти мока — не аудіо, ffmpeg на них не запускаємо.
  const qc: SfxQcHook = async () => ({ ...PASSING_QC });
  return { run: createAudioStage({ client, gate, sharedCost, decode, qc }), gate };
}

describe("audioStage", () => {
  it("plan → music → SFX → public files + audio.json; costs recorded per ElevenLabs call", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: withCustomCue });
    const client = mockElevenLabs();
    const ctx = makeCtx(storage, [{ json: draftWithCustom(withCustomCue) }]);
    const res = await stage(client, storage).run(ctx);

    const rev = projectPaths(PROJECT_ID).rev(1);
    const plan = await storage.readJson(rev.audioPlan, (v) => AudioPlan.parse(v));
    expect(plan.compositionPlan.chunks.map((c) => c.durationMs)).toEqual([23_000]);
    expect(res.outputs).toEqual({
      planHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      reusedMusic: false,
      mixed: true,
    });

    // Один виклик LLM (модель з frontmatter), один — музики; SFX: усі варіанти cue подій
    // (whoosh, impact, shimmer; legacy whoosh/shimmer — їхні варіанти 1, без повторного виклику) і кастомний.
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(ctx.anthropic.calls[0]?.params.model).toBe("claude-opus-5-5");
    expect(client.calls.filter((c) => c.method === "compose")).toHaveLength(1);
    const sfxCalls = client.calls.filter((c) => c.method === "convert");
    expect(sfxCalls.map((c) => c.request.text).sort()).toEqual(
      [...variantTexts(["whoosh", "impact", "shimmer"]), "ceramic cup clink on a wooden table"].sort(),
    );
    const custom = sfxCalls.find((c) => c.request.text === "ceramic cup clink on a wooden table");
    expect(custom?.request).toMatchObject({
      durationSeconds: 0.8,
      promptInfluence: 0.6,
      modelId: "eleven_text_to_sound_v2",
    });

    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest).toEqual({
      // ensureMusic декодує тим самим декодером (метроном 16 с) → обрізаний WAV: відео 15 с + 1 с хвоста.
      music: {
        src: "music.wav",
        durationMs: 16_000,
        fadeOutMs: 1_000,
        volume: 0.8,
        planHash: res.outputs.planHash,
      },
      mix: { src: "soundtrack.wav", durationMs: 15_000, ...MASTER_METRICS },
      sfx: [
        {
          cue: "whoosh",
          src: "sfx/whoosh.mp3",
          durationMs: standardCues.whoosh.durationSeconds * 1000,
          volume: 0.6,
        },
        {
          cue: "shimmer",
          src: "sfx/shimmer.mp3",
          durationMs: standardCues.shimmer.durationSeconds * 1000,
          volume: 0.6,
        },
        { cue: "cup-clink", src: "sfx/cup-clink.mp3", durationMs: 800, volume: 0.6 },
      ],
      totalFrames: 450,
    });
    expect(plan.key).toBe("A minor");
    const soundtrack = decodeWav(await storage.read(rev.publicFile("soundtrack.wav")));
    expect(soundtrack.sampleRate).toBe(44_100);
    expect(soundtrack.left.length).toBe(15 * 44_100);
    expect(decodeWav(await storage.read(rev.publicFile("music.wav"))).left.length).toBe(16 * 44_100);
    expect((await storage.read(rev.publicFile("sfx/cup-clink.mp3"))).toString()).toBe(
      "SFX:ceramic cup clink on a wooden table",
    );
    expect(res.artifacts).toEqual(
      expect.arrayContaining([
        rev.audioPlan,
        rev.audio,
        rev.publicFile("music.wav"),
        rev.publicFile("soundtrack.wav"),
      ]),
    );

    // Витрати: LLM + музика + кастомний SFX — у журнал проєкту; стандартні SFX — у спільний.
    const costs = await readCosts(storage, PROJECT_ID);
    expect(costs.map((c) => `${c.provider}:${c.detail ?? c.promptName}`).sort()).toEqual(
      ["anthropic:audio-plan", "elevenlabs:music:compose", "elevenlabs:sfx:cup-clink"].sort(),
    );
    expect(costs.find((c) => c.detail === "sfx:cup-clink")?.units).toEqual({ seconds: 0.8 });
    const shared = await readCosts(storage, null);
    expect(shared.map((c) => c.detail).sort()).toEqual(
      ["whoosh", "impact", "shimmer"].flatMap((c) => VARIANTS.map((n) => `sfx:${c}.${n}`)).sort(),
    );
    expect(shared.every((c) => c.stage === "sfx-cache" && c.projectId === null)).toBe(true);
  });

  it("uses the pre-warmed standard SFX cache (no SFX calls) and re-runs hit the plan-hash cache", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, FIXTURE_EVENT_CUES);
    const client = mockElevenLabs();
    const decode = fakeDecoder();
    const { run } = stage(client, storage, decode);
    const first = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    expect(client.calls.map((c) => c.method)).toEqual(["compose"]);
    expect(await readCosts(storage, null)).toHaveLength(0);
    const rev = projectPaths(PROJECT_ID).rev(1);
    expect((await storage.read(rev.publicFile("sfx/pop.mp3"))).toString()).toBe(
      `CACHED:${standardCues.pop.text}`,
    );
    // Зведення взяло всі 12 варіантів cue подій із кешу.
    expect(decode.sfxCalls().sort()).toEqual(
      FIXTURE_EVENT_CUES.flatMap((c) => VARIANTS.map((n) => `${c}.${n}`)).sort(),
    );
    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest.mix).toEqual({ src: "soundtrack.wav", durationMs: 15_000, ...MASTER_METRICS });

    // Повтор стадії в тій самій ревізії: план уже є — без LLM; трек — з кешу за хешем плану.
    const ctx2 = makeCtx(storage, []);
    const second = await run(ctx2);
    expect(ctx2.anthropic.calls).toHaveLength(0);
    expect(client.calls).toHaveLength(1);
    expect(second.outputs.planHash).toBe(first.outputs.planHash);
    // Зведення з кешу: заміри мастера — з `mix-<hash>.json` поруч із WAV, ті самі.
    const again = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(again.mix).toEqual(manifest.mix);
  });

  it("reuse rule: same music brief and video not longer than the track → keep the track", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const { run } = stage(client, storage);
    const r1 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));

    // Ревізія 2: сцена s3 коротша (відео 14 с ≤ обрізаний трек 16 с), бриф той самий.
    const shorter: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 135 } : s)),
    };
    await seedProject(storage, {
      storyboard: shorter,
      rev: 2,
      project: {
        rev: 2,
        audioPlanHash: r1.outputs.planHash,
        revisions: [
          {
            n: 1,
            createdAt: "2026-10-06T10:00:00.000Z",
            basedOn: null,
            reason: "initial",
            at: null,
            instruction: null,
          },
          {
            n: 2,
            createdAt: "2026-10-06T11:00:00.000Z",
            basedOn: 1,
            reason: "edit",
            at: "delivered",
            instruction: "x",
          },
        ],
      },
    });
    const ctx2 = makeCtx(storage, [], { rev: 2, phase: "revision" });
    const r2 = await run(ctx2);
    expect(r2.outputs).toEqual({ planHash: r1.outputs.planHash, reusedMusic: true, mixed: true });
    // План основи покриває всі cue → без LLM; музика — без виклику API.
    expect(ctx2.anthropic.calls).toHaveLength(0);
    expect(client.calls.filter((c) => c.method !== "convert")).toHaveLength(1);
    const manifest = await storage.readJson(projectPaths(PROJECT_ID).rev(2).audio, (v) =>
      AudioManifest.parse(v),
    );
    // Повторно використовується обрізаний music.wav (є check), а не сирий mp3.
    expect(manifest.music).toMatchObject({
      planHash: r1.outputs.planHash,
      durationMs: 16_000,
      src: "music.wav",
    });
    expect(manifest.totalFrames).toBe(420);
  });

  it("reuse rule: longer video or changed brief → new track", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const { run } = stage(client, storage);
    const r1 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    const project = { rev: 2, audioPlanHash: r1.outputs.planHash };

    // Відео 23.5 с > трек 23 с (відео 15 с + 8 с запасу).
    const longer: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 420 } : s)),
    };
    await seedProject(storage, { storyboard: longer, rev: 2, project });
    const r2 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(longer)) }], { rev: 2 }));
    expect(r2.outputs.reusedMusic).toBe(false);
    expect(r2.outputs.planHash).not.toBe(r1.outputs.planHash);

    const newBrief: Storyboard = {
      ...fixtureStoryboard,
      musicBrief: { ...fixtureStoryboard.musicBrief, genre: "acoustic folk" },
    };
    await seedProject(storage, {
      storyboard: newBrief,
      rev: 3,
      project: { rev: 3, audioPlanHash: r1.outputs.planHash },
    });
    const draft = draftFor(computeChunkLayout(newBrief), { promptFallback: "acoustic folk, instrumental" });
    const r3 = await run(makeCtx(storage, [{ json: draft }], { rev: 3 }));
    expect(r3.outputs.reusedMusic).toBe(false);
    expect(client.calls.filter((c) => c.method === "compose")).toHaveLength(3);

    expect(canReuseMusic({ briefHash: "a", durationMs: 16_000 }, "a", 16_000)).toBe(true);
    expect(canReuseMusic({ briefHash: "a", durationMs: 16_000 }, "a", 16_001)).toBe(false);
    expect(canReuseMusic({ briefHash: "a", durationMs: 16_000 }, "b", 10_000)).toBe(false);
  });

  it("429 on SFX is retried; a custom SFX that keeps failing is skipped, music still delivered", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: withCustomCue });
    // Кастомний cue завжди відхиляється (400); перший запит отримує 429 і повторюється.
    const reply = (req: unknown) => {
      const text = (req as { text: string }).text;
      return text.includes("cup") ? elError(400, { detail: "invalid" }) : audioStream(`SFX:${text}`);
    };
    const client = mockElevenLabs({ convert: [elError(429, concurrencyBody), reply, reply, reply, reply] });
    const { run, gate } = stage(client, storage);
    await run(makeCtx(storage, [{ json: draftWithCustom(withCustomCue) }]));
    expect(gate.sleeps.length).toBeGreaterThanOrEqual(1);
    const manifest = await storage.readJson(projectPaths(PROJECT_ID).rev(1).audio, (v) =>
      AudioManifest.parse(v),
    );
    expect(manifest.music).not.toBeNull();
    expect(manifest.sfx.map((s) => s.cue)).toEqual(["whoosh", "shimmer"]);
  });

  it("music failure becomes a retryable StageError", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs({
      composeDetailed: [elError(401, { detail: "invalid api key" })],
      compose: [elError(401, { detail: "invalid api key" })],
    });
    const { run } = stage(client, storage);
    await expect(
      run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }])),
    ).rejects.toMatchObject({ name: "StageError", code: "music_failed", retryable: true });
  });
});

describe("audioStage: зведення soundtrack.wav", () => {
  it("кеш зведення: повтор стадії не декодує трек знову; зміна подій — нове зведення на тому ж треку", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const decode = fakeDecoder();
    const { run } = stage(client, storage, decode);
    const r1 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    // Трек декодується двічі: перевірка в ensureMusic (сирий) і зведення (обрізаний WAV).
    expect(decode.musicCalls()).toBe(2);
    const decodedSfx = decode.sfxCalls().length;
    const rev = projectPaths(PROJECT_ID).rev(1);
    const first = await storage.read(rev.publicFile("soundtrack.wav"));

    // Повтор стадії: той самий план, події і семпли → зведення з кешу, побайтно те саме, без декодування.
    await run(makeCtx(storage, []));
    expect(decode.musicCalls()).toBe(2);
    expect(decode.sfxCalls()).toHaveLength(decodedSfx);
    expect((await storage.read(rev.publicFile("soundtrack.wav"))).equals(first)).toBe(true);

    // Ревізія 2: подія зсунулась, бриф і таймінги ті самі → трек лишається, зведення нове.
    const moved: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) =>
        s.id === "s2" ? { ...s, events: s.events.map((e) => ({ ...e, at: e.at + 5 })) } : s,
      ),
    };
    await seedProject(storage, {
      storyboard: moved,
      rev: 2,
      project: { rev: 2, audioPlanHash: r1.outputs.planHash },
    });
    const r2 = await run(makeCtx(storage, [], { rev: 2 }));
    expect(r2.outputs.planHash).toBe(r1.outputs.planHash);
    expect(decode.musicCalls()).toBe(3);
    const second = await storage.read(projectPaths(PROJECT_ID).rev(2).publicFile("soundtrack.wav"));
    expect(second.equals(first)).toBe(false);
    expect(client.calls.filter((c) => c.method === "compose")).toHaveLength(1);
  });

  it("зведення не вдалося (немає ffmpeg) → mix: null, хост грає музику і SFX як раніше", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const { run } = stage(client, storage, fakeDecoder({ fail: true }));
    const res = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    const rev = projectPaths(PROJECT_ID).rev(1);
    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest.mix).toBeNull();
    // Не розкодувався → сирий трек під своїм розширенням.
    expect(manifest.music?.src).toBe("music.mp3");
    expect(await storage.exists(rev.publicFile("music.mp3"))).toBe(true);
    expect(await storage.exists(rev.publicFile("music.wav"))).toBe(false);
    expect(manifest.sfx.length).toBeGreaterThan(0);
    expect(await storage.exists(rev.publicFile("soundtrack.wav"))).toBe(false);
    expect(res.artifacts).not.toContain(rev.publicFile("soundtrack.wav"));
  });
});

describe("audioStage: бібліотека семплів подій", () => {
  it("холодний кеш: догенеровує лише відсутні варіанти, витрати — у спільний журнал", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, FIXTURE_EVENT_CUES, [1]);
    const client = mockElevenLabs();
    const decode = fakeDecoder();
    const { run } = stage(client, storage, decode);
    await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    const generated = client.calls.filter((c) => c.method === "convert").map((c) => c.request.text);
    expect(generated.sort()).toEqual(
      FIXTURE_EVENT_CUES.flatMap((c) => sfxLibrary[c].slice(1).map((d) => d.text)).sort(),
    );
    const shared = await readCosts(storage, null);
    expect(shared.map((c) => c.detail).sort()).toEqual(
      FIXTURE_EVENT_CUES.flatMap((c) => VARIANTS.slice(1).map((n) => `sfx:${c}.${n}`)).sort(),
    );
    expect(shared.every((c) => c.stage === "sfx-cache" && c.projectId === null)).toBe(true);
    expect(await readCosts(storage, PROJECT_ID)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "sfx" })]),
    );
    expect(decode.sfxCalls()).toHaveLength(FIXTURE_EVENT_CUES.length * VARIANTS.length);
  });

  it("варіант не згенерувався або не декодувався → пропуск; cue без жодного семпла → події без звуку, зведення є", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, ["whoosh", "pop", "shimmer"]);
    await warmCache(storage, ["impact"], [1]);
    // impact.2 і impact.3 не генеруються (400), а решта (impact.1 з кешу, .4, .5) не декодується.
    const client = mockElevenLabs({
      convert: [elError(400, { detail: "invalid" }), elError(400, { detail: "invalid" })],
    });
    let broken = true;
    const decode = fakeDecoder({ failSfx: (cue) => broken && cue === "impact" });
    const { run } = stage(client, storage, decode);
    const ctx = makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]);
    const logger = captureLogger();
    ctx.logger = logger;
    await run(ctx);
    const rev = projectPaths(PROJECT_ID).rev(1);
    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest.mix).toEqual({ src: "soundtrack.wav", durationMs: 15_000, ...MASTER_METRICS });
    expect(logger.warns.filter((w) => /варіант SFX не згенерувався/.test(w.msg))).toHaveLength(2);
    expect(logger.warns.find((w) => /не декодувався/.test(w.msg))?.meta).toMatchObject({
      cue: "impact",
      variant: 1,
    });
    expect(logger.warns.find((w) => /немає жодного семпла/.test(w.msg))?.meta).toEqual({ cue: "impact" });
    const degraded = await storage.read(rev.publicFile("soundtrack.wav"));

    // Наступний прогін з робочим декодером: хеш зведення інший (є семпл impact) → нове зведення.
    broken = false;
    await run(makeCtx(storage, []));
    expect(decode.musicCalls()).toBe(3);
    expect((await storage.read(rev.publicFile("soundtrack.wav"))).equals(degraded)).toBe(false);
  });
});

describe("computeAudioPlacements", () => {
  it("старий audio.json без mix парситься з mix: null; зі зведенням хост грає лише soundtrack.wav", () => {
    const old = {
      music: { src: "music.mp3", durationMs: 16_000, fadeOutMs: 1_000, volume: 0.8, planHash: "h" },
      sfx: [{ cue: "whoosh", src: "sfx/whoosh.mp3", durationMs: 600, volume: 0.6 }],
      totalFrames: 450,
    };
    const parsed = AudioManifest.parse(old);
    expect(parsed.mix).toBeNull();
    expect(computeAudioPlacements(fixtureStoryboard, parsed).map((p) => p.kind)).toEqual(["music", "sfx"]);

    const mixed = AudioManifest.parse({ ...old, mix: { src: "soundtrack.wav", durationMs: 15_000 } });
    expect(computeAudioPlacements(fixtureStoryboard, mixed)).toEqual([
      {
        kind: "mix",
        cue: "mix",
        sceneId: null,
        src: "soundtrack.wav",
        from: 0,
        durationInFrames: 450,
        volume: 1,
      },
    ]);
  });

  it("music from frame 0 with fade-out; SFX at scene sequence starts, riser ends at the boundary", () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, sfxCue: "riser" } : s)),
    };
    const manifest: AudioManifest = {
      music: { src: "music.mp3", durationMs: 16_000, fadeOutMs: 1_000, volume: 0.8, planHash: "h" },
      mix: null,
      sfx: [
        { cue: "whoosh", src: "sfx/whoosh.mp3", durationMs: 600, volume: 0.6 },
        { cue: "riser", src: "sfx/riser.mp3", durationMs: 1_500, volume: 0.6 },
      ],
      totalFrames: 450,
    };
    const placements = computeAudioPlacements(storyboard, manifest);
    expect(placements).toEqual([
      expect.objectContaining({ kind: "music", from: 0, durationInFrames: 450, fadeOutFrames: 30 }),
      expect.objectContaining({ kind: "sfx", cue: "whoosh", sceneId: "s1", from: 0, durationInFrames: 18 }),
      // s2 має cue "pop", якого немає в бібліотеці, — пропускається.
      expect.objectContaining({
        kind: "sfx",
        cue: "riser",
        sceneId: "s3",
        from: 285 - 45,
        durationInFrames: 45,
      }),
    ]);
  });
});

describe("audioStage: фази music і mix (звукорежисер)", () => {
  /** План звукорежисера для фікстури: price-hit мовчить (або `hit`), badge-in звучить ding. */
  const sfxPlan = (hit: { cue: SoundCue; accent: "soft" | "normal" | "hard" } | null = null) => ({
    version: 1,
    inputsHash: "test",
    sceneIds: ["s2"],
    notes: "",
    decisions: [
      { sceneId: "s2", eventId: "price-hit", sound: hit, reason: "" },
      { sceneId: "s2", eventId: "badge-in", sound: { cue: "ding", accent: "normal" }, reason: "" },
    ],
  });
  const rev = projectPaths(PROJECT_ID).rev(1);
  const withPhase = (ctx: ReturnType<typeof makeCtx>, phase: "music" | "mix" | "full") =>
    Object.assign(ctx, { params: { phase } });
  const readSheet = async (storage: ReturnType<typeof tmpStorage>) =>
    storage.readJson(rev.soundSheet, (v) => SoundSheet.parse(v));
  const mixFiles = async (storage: ReturnType<typeof tmpStorage>, planHash: string) =>
    (await storage.list(`${projectPaths(PROJECT_ID).audioDir}/${planHash}`)).filter((k) =>
      /mix-[0-9a-f]+\.wav$/.test(k),
    );

  it("music: план, трек і прогрів усієї бібліотеки, без зведення; повтор без ключа ElevenLabs при повному кеші не падає", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, SoundCue.options);
    const client = mockElevenLabs();
    const decode = fakeDecoder();
    const { run } = stage(client, storage, decode);
    const res = await run(
      withPhase(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]), "music"),
    );
    expect(res.outputs).toEqual({
      planHash: expect.stringMatching(/^[0-9a-f]{16}$/),
      reusedMusic: false,
      mixed: false,
    });
    // Лише трек: усі 30 cue × 5 варіантів — із кешу; семпли не декодуються (зведення немає).
    expect(client.calls.map((c) => c.method)).toEqual(["compose"]);
    expect(decode.sfxCalls()).toHaveLength(0);
    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest.mix).toBeNull();
    expect(manifest.music).toMatchObject({ src: "music.wav", planHash: res.outputs.planHash });
    expect(await storage.exists(rev.publicFile("soundtrack.wav"))).toBe(false);
    expect(await storage.exists(rev.soundSheet)).toBe(false);
    expect(res.artifacts).toEqual(expect.arrayContaining([rev.audioPlan, rev.audio]));

    // Повтор фази без ключа: план — з ревізії, трек — з кешу за хешем плану, семпли — зі спільного кешу.
    const noKey = createAudioStage({
      client: () => {
        throw new Error("ELEVENLABS_API_KEY не задано");
      },
      gate: instantGate(),
      decode,
      qc: async () => ({ ...PASSING_QC }),
    });
    const again = await noKey(withPhase(makeCtx(storage, []), "music"));
    expect(again.outputs).toEqual(res.outputs);
  });

  it("mix без фази music → audio_inputs_missing (не повторюється)", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const { run } = stage(mockElevenLabs(), storage);
    await expect(run(withPhase(makeCtx(storage, []), "mix"))).rejects.toMatchObject({
      name: "StageError",
      code: "audio_inputs_missing",
      retryable: false,
    });
  });

  it("music → mix: план SFX накладено, зведення і відомість; новий план — нове зведення, старе лишається в кеші", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, SoundCue.options);
    const client = mockElevenLabs();
    const decode = fakeDecoder();
    const { run } = stage(client, storage, decode);
    const music = await run(
      withPhase(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]), "music"),
    );
    const musicManifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));

    await storage.writeJson(rev.sfxPlan, sfxPlan());
    const ctx = withPhase(makeCtx(storage, []), "mix");
    const mixed = await run(ctx);
    expect(mixed.outputs).toEqual({ planHash: music.outputs.planHash, reusedMusic: false, mixed: true });
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(client.calls.map((c) => c.method)).toEqual(["compose"]);
    expect(mixed.artifacts).toEqual(
      expect.arrayContaining([rev.audio, rev.soundSheet, rev.publicFile("soundtrack.wav")]),
    );
    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest).toEqual({
      ...musicManifest,
      mix: { src: "soundtrack.wav", durationMs: 15_000, ...MASTER_METRICS },
    });
    // Декодуються лише варіанти cue ефективної розкадровки: impact вимкнено, ding додано.
    expect(new Set(decode.sfxCalls().map((c) => c.split(".")[0]))).toEqual(
      new Set(["whoosh", "pop", "shimmer", "ding"]),
    );

    const sheet = await readSheet(storage);
    expect(sheet.events.map((e) => `${e.sceneId}/${e.eventId}:${e.cue}:${e.silent}`)).toEqual([
      "s1/arrive:whoosh:none",
      "s2/arrive:pop:none",
      "s2/price-hit:impact:muted",
      "s2/badge-in:ding:none",
      "s3/arrive:shimmer:none",
    ]);
    expect(sheet).toMatchObject({ version: 1, fps: 30, bpm: 85, totalFrames: 450 });
    expect(sheet.integratedLufs).toBe(manifest.mix?.integratedLufs);
    const firstSheet = await storage.read(rev.soundSheet);
    const firstMix = await storage.read(rev.publicFile("soundtrack.wav"));

    // Повтор mix з тим самим планом: зведення з кешу, відомість — побайтно та сама.
    const musicDecodes = decode.musicCalls();
    await run(withPhase(makeCtx(storage, []), "mix"));
    expect(decode.musicCalls()).toBe(musicDecodes);
    expect((await storage.read(rev.soundSheet)).equals(firstSheet)).toBe(true);
    expect((await storage.read(rev.publicFile("soundtrack.wav"))).equals(firstMix)).toBe(true);

    // Новий план у тій самій ревізії: новий хеш і нове зведення; старий файл лишається в кеші.
    await storage.writeJson(rev.sfxPlan, sfxPlan({ cue: "slam", accent: "hard" }));
    await run(withPhase(makeCtx(storage, []), "mix"));
    expect((await storage.read(rev.publicFile("soundtrack.wav"))).equals(firstMix)).toBe(false);
    expect(await mixFiles(storage, music.outputs.planHash)).toHaveLength(2);
    expect((await readSheet(storage)).events.find((e) => e.eventId === "price-hit")).toMatchObject({
      cue: "slam",
      accent: "hard",
      silent: "none",
      ducked: true,
    });
  });

  it("full (без phase): як раніше, плюс план SFX і відомість", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, [...FIXTURE_EVENT_CUES, "ding"]);
    await storage.writeJson(rev.sfxPlan, sfxPlan());
    const { run } = stage(mockElevenLabs(), storage);
    const res = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    expect(res.outputs.mixed).toBe(true);
    expect(res.artifacts).toContain(rev.soundSheet);
    const sheet = await readSheet(storage);
    expect(sheet.events.find((e) => e.eventId === "price-hit")?.silent).toBe("muted");
    expect(sheet.events.find((e) => e.eventId === "badge-in")).toMatchObject({ cue: "ding", silent: "none" });
  });

  it("старий кеш зведення без фактів відомості → зводиться заново тим самим WAV, відомість з'являється", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const decode = fakeDecoder();
    const { run } = stage(mockElevenLabs(), storage, decode);
    const res = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    const [wavKey] = await mixFiles(storage, res.outputs.planHash);
    if (!wavKey) throw new Error("немає зведення в кеші");
    const metaKey = mixMasterMetaKey(wavKey);
    const meta = await storage.readJson(metaKey, (v) => MixMasterMeta.parse(v));
    expect(meta.facts).not.toBeNull();
    const wav = await storage.read(wavKey);
    const sheet = await storage.read(rev.soundSheet);
    // Як писав код до відомості: лише заміри мастера.
    const { facts: _facts, ...legacy } = meta;
    await storage.writeJson(metaKey, legacy);
    expect(MixMasterMeta.parse(legacy).facts).toBeNull();

    const musicDecodes = decode.musicCalls();
    await run(makeCtx(storage, []));
    expect(decode.musicCalls()).toBe(musicDecodes + 1);
    expect((await storage.read(wavKey)).equals(wav)).toBe(true);
    expect((await storage.read(rev.soundSheet)).equals(sheet)).toBe(true);
    expect((await storage.readJson(metaKey, (v) => MixMasterMeta.parse(v))).facts).toEqual(meta.facts);
  });
});
