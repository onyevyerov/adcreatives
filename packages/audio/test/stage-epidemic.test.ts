import {
  AudioManifest,
  computeEventPlacements,
  createPromptLoader,
  MusicMeta,
  projectPaths,
  type SoundCue,
  StageError,
  type Storyboard,
  sharedPaths,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import type { DecodeAudio } from "../src/decode.ts";
import { EpidemicGate } from "../src/epidemic/gate.ts";
import { buildAudioManifest } from "../src/manifest.ts";
import {
  type EnsureMusicFn,
  type EnsureSfxVariantsFn,
  EpidemicError,
  type SfxVariantRequest,
} from "../src/provider.ts";
import { loadSfxLibrary, loadStandardCues, sfxHash } from "../src/sfx.ts";
import type { SfxQcHook } from "../src/sfxQc.ts";
import { type AudioStageDeps, canReuseMusic, createAudioStage } from "../src/stage.ts";
import { variantIndices } from "../src/variants.ts";
import { memoryQuota, mockEpidemic } from "./epidemicHelpers.ts";
import { fakeSample } from "./fakeSfx.ts";
import {
  draftFor,
  instantGate,
  makeCtx,
  mockElevenLabs,
  PROJECT_ID,
  seedProject,
  tmpStorage,
} from "./helpers.ts";
import { metronome } from "./signals.ts";

const prompts = createPromptLoader();
const sfxLibrary = loadSfxLibrary(prompts);
const standardCues = loadStandardCues(prompts);
const variantByText = new Map(
  Object.entries(sfxLibrary).flatMap(([cue, variants]) =>
    variants.map((def, i) => [def.text, { cue: cue as SoundCue, variant: i + 1 }] as const),
  ),
);
const rev = projectPaths(PROJECT_ID).rev(1);
const FIXTURE_EVENT_CUES = ["whoosh", "impact", "pop", "shimmer"] as const;
const PASSING_QC = {
  ok: true,
  peakDb: null,
  onsetMs: null,
  correlation: null,
  pitchHz: null,
  reasons: [],
  attempts: 1,
};
const qc: SfxQcHook = async () => ({ ...PASSING_QC });

/** Декодер-мок: семпли ElevenLabs (`SFX:`/`CACHED:` + текст) і Epidemic (`EPSFX:cue.n`) → фейкові семпли; решта — трек. */
function fakeDecoder(): DecodeAudio & { sfx: string[] } {
  const sfx: string[] = [];
  const decode: DecodeAudio = async (bytes) => {
    const text = bytes.toString();
    const ep = /^EPSFX:([a-z-]+)\.(\d+)$/.exec(text);
    if (ep) {
      sfx.push(`${ep[1]}.${ep[2]}`);
      return fakeSample(ep[1] as SoundCue, Number(ep[2]));
    }
    const el = /^(?:SFX|CACHED):([\s\S]*)$/.exec(text);
    const hit = el ? variantByText.get(el[1] ?? "") : undefined;
    if (hit) {
      sfx.push(`${hit.cue}.${hit.variant}`);
      return fakeSample(hit.cue, hit.variant);
    }
    return metronome({ bpm: 85, offsetSec: 0.05, durationSec: 16, busy: true, pad: true });
  };
  return Object.assign(decode, { sfx });
}

async function warmCache(storage: ReturnType<typeof tmpStorage>, cues: readonly SoundCue[]) {
  for (const cue of cues) {
    for (const def of sfxLibrary[cue])
      await storage.write(sharedPaths.sfxCache(sfxHash(def)), `CACHED:${def.text}`);
  }
}

/** Фейковий провайдер музики Epidemic: пише сирий трек і `music.json` з `provider: "epidemic"`. */
function fakeEpidemicMusic(opts: { downloads?: number; fail?: Error; planHash?: string } = {}) {
  const calls: Array<Parameters<EnsureMusicFn>> = [];
  const fn: EnsureMusicFn = async (deps, projectId, plan, briefHash) => {
    calls.push([deps, projectId, plan, briefHash]);
    if (opts.fail) throw opts.fail;
    const planHash = opts.planHash ?? "e9e9e9e9e9e9e9e9";
    const paths = projectPaths(projectId);
    const key = paths.music(planHash);
    await deps.storage.write(key, "EPMUSIC");
    const meta = MusicMeta.parse({
      planHash,
      durationMs: 16_000,
      modelId: "epidemic-catalog",
      provider: "epidemic",
      method: "catalog",
      promptUsed: null,
      briefHash,
      createdAt: "2026-10-19T10:00:00.000Z",
      epidemic: {
        trackId: "trk-1",
        title: "Morning Beans",
        artists: ["Lo Artist"],
        bpm: 86,
        targetBpm: deps.targetBpm,
        tempoWarning: false,
        versionJobId: "job-1",
        candidatesTried: 1,
      },
    });
    await deps.storage.writeJson(paths.musicMeta(planHash), meta);
    return {
      planHash,
      key,
      meta,
      cached: false,
      ...(opts.downloads !== undefined ? { downloads: opts.downloads } : {}),
    };
  };
  return Object.assign(fn, { calls });
}

/** Фейковий провайдер SFX Epidemic: `audio/epidemic-sfx/<id>.wav` з міткою `EPSFX:cue.n`. */
function fakeEpidemicSfx(opts: { fail?: Error; generated?: boolean } = {}) {
  const calls: Array<readonly SfxVariantRequest[]> = [];
  const fn: EnsureSfxVariantsFn = async (deps, requests) => {
    calls.push(requests);
    if (opts.fail) throw opts.fail;
    const out = [];
    for (const r of requests) {
      const id = `ep-${r.cue}-${r.variant}`;
      const key = `${projectPaths(deps.projectId).audioDir}/epidemic-sfx/${id}.wav`;
      await deps.storage.write(key, `EPSFX:${r.cue}.${r.variant}`);
      out.push({
        cue: r.cue,
        variant: r.variant,
        file: {
          cue: r.cue,
          key,
          hash: `ep-${id}`,
          durationMs: Math.round(r.def.durationSeconds * 1000),
          generated: opts.generated ?? true,
          qcOk: true,
        },
        epidemicId: id,
        title: `Title ${id}`,
      });
    }
    return out;
  };
  return Object.assign(fn, { calls });
}

function epidemicStage(
  overrides: Partial<AudioStageDeps> & { music?: EnsureMusicFn; sfx?: EnsureSfxVariantsFn } = {},
) {
  const { music, sfx, ...rest } = overrides;
  const quota = memoryQuota();
  const epidemicCache = tmpStorage();
  const decode = fakeDecoder();
  const run = createAudioStage({
    client: mockElevenLabs(),
    gate: instantGate(),
    sharedCost: (ctx) => ctx.cost,
    decode,
    qc,
    epidemicClient: mockEpidemic(),
    epidemicQuota: quota,
    epidemicCache,
    epidemicGate: new EpidemicGate({ sleep: async () => {} }),
    ensureMusicBy: music ? { epidemic: music } : {},
    ensureSfxVariantsBy: sfx ? { epidemic: sfx } : {},
    ...rest,
  });
  return { run, quota, epidemicCache, decode };
}

type Params = {
  phase?: "music" | "mix" | "full";
  musicProvider?: "elevenlabs" | "epidemic";
  sfxProvider?: "elevenlabs" | "epidemic";
};
const withParams = (ctx: ReturnType<typeof makeCtx>, params: Params) => Object.assign(ctx, { params });
const draftReply = (sb: Storyboard = fixtureStoryboard, overrides = {}) => [
  { json: draftFor(computeChunkLayout(sb), overrides) },
];
const readManifest = (storage: ReturnType<typeof tmpStorage>, r = rev) =>
  storage.readJson(r.audio, (v) => AudioManifest.parse(v));

/** Дві сцени з подіями `pop` (по дві в кожній), без legacy `sfxCue`. */
const twoScenesPop: Storyboard = {
  ...fixtureStoryboard,
  scenes: fixtureStoryboard.scenes.map((s) => {
    const pop = { cue: "pop" as const, accent: "normal" as const };
    if (s.id === "s1") {
      return {
        ...s,
        sfxCue: null,
        events: [
          { id: "e1", at: 10, what: "a", sound: pop, textIds: [] },
          { id: "e2", at: 60, what: "b", sound: pop, textIds: [] },
        ],
      };
    }
    if (s.id === "s2") return { ...s, sfxCue: null, events: s.events.map((e) => ({ ...e, sound: pop })) };
    return { ...s, sfxCue: null };
  }),
};

beforeEach(() => {
  vi.stubEnv("ADC_MUSIC_PROVIDER", "");
  vi.stubEnv("ADC_SFX_PROVIDER", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("audio stage: провайдери Epidemic", () => {
  it("без параметрів і env — ElevenLabs, як сьогодні: providers elevenlabs, epidemic null, фейки Epidemic не викликаються", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, FIXTURE_EVENT_CUES);
    const music = fakeEpidemicMusic();
    const sfx = fakeEpidemicSfx();
    const { run } = epidemicStage({ music, sfx });
    await run(makeCtx(storage, draftReply()));
    expect(music.calls).toHaveLength(0);
    expect(sfx.calls).toHaveLength(0);
    const manifest = await readManifest(storage);
    expect(manifest.providers).toEqual({ music: "elevenlabs", sfx: "elevenlabs" });
    expect(manifest.epidemic).toBeNull();
  });

  it("провайдери з env, якщо в параметрах немає; параметри мають пріоритет", async () => {
    vi.stubEnv("ADC_MUSIC_PROVIDER", "epidemic");
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, FIXTURE_EVENT_CUES);
    const music = fakeEpidemicMusic();
    const { run } = epidemicStage({ music });
    await run(makeCtx(storage, draftReply()));
    expect(music.calls).toHaveLength(1);

    const storage2 = tmpStorage();
    await seedProject(storage2);
    await warmCache(storage2, FIXTURE_EVENT_CUES);
    const music2 = fakeEpidemicMusic();
    const s2 = epidemicStage({ music: music2 });
    await s2.run(withParams(makeCtx(storage2, draftReply()), { musicProvider: "elevenlabs" }));
    expect(music2.calls).toHaveLength(0);
    expect((await readManifest(storage2)).providers.music).toBe("elevenlabs");
  });

  it("musicProvider epidemic: фейк отримує targetBpm розкадровки і залежності Epidemic; клієнт ElevenLabs не створюється", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await warmCache(storage, FIXTURE_EVENT_CUES);
    const music = fakeEpidemicMusic({ downloads: 2 });
    let elevenCreated = 0;
    const { run, quota, epidemicCache } = epidemicStage({
      music,
      client: () => {
        elevenCreated++;
        throw new Error("ElevenLabs не має створюватись");
      },
    });
    const ctx = withParams(makeCtx(storage, draftReply()), { musicProvider: "epidemic" });
    const res = await run(ctx);
    expect(elevenCreated).toBe(0);
    expect(music.calls).toHaveLength(1);
    const [deps, projectId, plan, briefHash] = music.calls[0] as Parameters<EnsureMusicFn>;
    expect(deps.targetBpm).toBe(fixtureStoryboard.musicBrief.bpm);
    expect(deps.epidemic.quota).toBe(quota);
    expect(deps.epidemic.cache).toBe(epidemicCache);
    expect(deps.llm).toBe(ctx.llm);
    expect(deps.storage).toBe(storage);
    expect(projectId).toBe(PROJECT_ID);
    expect(plan.compositionPlan.chunks.length).toBeGreaterThan(0);
    expect(briefHash).toMatch(/^[0-9a-f]+$/);
    expect(res.outputs).toEqual({ planHash: "e9e9e9e9e9e9e9e9", reusedMusic: false, mixed: true });

    const manifest = await readManifest(storage);
    expect(manifest.providers).toEqual({ music: "epidemic", sfx: "elevenlabs" });
    expect(manifest.epidemic).toEqual({ trackId: "trk-1", sfx: [], downloads: 2 });
    expect(manifest.music).toMatchObject({ planHash: "e9e9e9e9e9e9e9e9", src: "music.mp3" });
    expect(manifest.mix).not.toBeNull();
  });

  it("sfxProvider epidemic, фаза music: жодного виклику SFX (ні Epidemic, ні ElevenLabs)", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const sfx = fakeEpidemicSfx();
    const { run } = epidemicStage({ sfx, client });
    await run(withParams(makeCtx(storage, draftReply()), { phase: "music", sfxProvider: "epidemic" }));
    expect(sfx.calls).toHaveLength(0);
    expect(client.calls.map((c) => c.method)).toEqual(["compose"]);
    const manifest = await readManifest(storage);
    expect(manifest.providers).toEqual({ music: "elevenlabs", sfx: "epidemic" });
    expect(manifest.epidemic).toEqual({ trackId: null, sfx: [], downloads: 0 });
    expect(manifest.mix).toBeNull();
  });

  it("приймання: 2 сцени × pop у фазі mix — запити лише на варіанти з variantIndices (менше 5), один виклик", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: twoScenesPop });
    const client = mockElevenLabs();
    const sfx = fakeEpidemicSfx();
    const { run, decode } = epidemicStage({ sfx, client });
    const params = { sfxProvider: "epidemic" } as const;
    await run(withParams(makeCtx(storage, draftReply(twoScenesPop)), { phase: "music", ...params }));
    expect(sfx.calls).toHaveLength(0);
    const res = await run(withParams(makeCtx(storage, []), { phase: "mix", ...params }));
    expect(res.outputs.mixed).toBe(true);

    const expected = [
      ...new Map(
        variantIndices(computeEventPlacements(twoScenesPop), () => 5).map((v) => [
          `${v.cue}.${v.variant}`,
          v,
        ]),
      ).values(),
    ];
    expect(sfx.calls).toHaveLength(1);
    const requests = sfx.calls[0] ?? [];
    expect(requests.map((r) => `${r.cue}.${r.variant}`).sort()).toEqual(
      expected.map((v) => `${v.cue}.${v.variant}`).sort(),
    );
    expect(requests.every((r) => r.cue === "pop" && !r.custom)).toBe(true);
    expect(requests.length).toBeLessThan(5);
    for (const r of requests) expect(r.def).toEqual(sfxLibrary.pop[r.variant - 1]);
    // ElevenLabs SFX не викликається.
    expect(client.calls.filter((c) => c.method === "convert")).toHaveLength(0);
    // Зведення декодує саме семпли Epidemic.
    expect(new Set(decode.sfx)).toEqual(new Set(requests.map((r) => `${r.cue}.${r.variant}`)));

    const manifest = await readManifest(storage);
    expect(manifest.providers).toEqual({ music: "elevenlabs", sfx: "epidemic" });
    expect(manifest.mix).not.toBeNull();
    expect(manifest.epidemic?.trackId).toBeNull();
    expect(manifest.epidemic?.downloads).toBe(requests.length);
    expect(manifest.epidemic?.sfx.map((s) => `${s.cue}.${s.variant}:${s.id}`).sort()).toEqual(
      requests.map((r) => `${r.cue}.${r.variant}:ep-${r.cue}-${r.variant}`).sort(),
    );

    // Повтор mix із кешем провайдера (generated=false): завантаження не додаються.
    const cachedSfx = fakeEpidemicSfx({ generated: false });
    const again = epidemicStage({ sfx: cachedSfx, client });
    await again.run(withParams(makeCtx(storage, []), { phase: "mix", ...params }));
    expect((await readManifest(storage)).epidemic?.downloads).toBe(requests.length);
  });

  it("full: події + legacy sfxCue (варіант 1, без дублів) + кастомний cue — одним викликом; legacy-файли в public", async () => {
    const withCustom: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s2" ? { ...s, sfxCue: "cup-clink" } : s)),
    };
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: withCustom });
    const client = mockElevenLabs();
    const sfx = fakeEpidemicSfx();
    const music = fakeEpidemicMusic({ downloads: 3 });
    const { run } = epidemicStage({ sfx, music, client });
    const custom = {
      cue: "cup-clink",
      text: "ceramic cup clink on a wooden table",
      durationSeconds: 0.8,
      custom: true,
    };
    await run(
      withParams(makeCtx(storage, draftReply(withCustom, { sfx: [custom] })), {
        musicProvider: "epidemic",
        sfxProvider: "epidemic",
      }),
    );
    expect(client.calls).toHaveLength(0);
    expect(sfx.calls).toHaveLength(1);
    const requests = sfx.calls[0] ?? [];
    const eventKeys = variantIndices(computeEventPlacements(withCustom), () => 5).map(
      (v) => `${v.cue}.${v.variant}`,
    );
    expect(requests.map((r) => `${r.cue}.${r.variant}`).sort()).toEqual(
      [...new Set([...eventKeys, "whoosh.1", "shimmer.1", "cup-clink.1"])].sort(),
    );
    const clink = requests.find((r) => r.cue === "cup-clink");
    expect(clink).toEqual({
      cue: "cup-clink",
      variant: 1,
      custom: true,
      def: { text: custom.text, durationSeconds: 0.8 },
    });
    expect(requests.find((r) => r.cue === "whoosh" && r.variant === 1)?.def).toEqual(standardCues.whoosh);

    const manifest = await readManifest(storage);
    expect(manifest.sfx.map((s) => s.cue).sort()).toEqual(["cup-clink", "shimmer", "whoosh"]);
    for (const s of manifest.sfx) expect(await storage.exists(rev.publicFile(s.src))).toBe(true);
    expect(manifest.providers).toEqual({ music: "epidemic", sfx: "epidemic" });
    expect(manifest.epidemic).toMatchObject({ trackId: "trk-1", downloads: requests.length + 3 });
    expect(manifest.epidemic?.sfx).toHaveLength(requests.length);
  });

  describe("перевикористання треку — лише того самого провайдера", () => {
    const rev2Project = (planHash: string) => ({
      rev: 2,
      audioPlanHash: planHash,
      revisions: [
        {
          n: 1,
          createdAt: "2026-10-06T10:00:00.000Z",
          basedOn: null,
          reason: "initial" as const,
          at: null,
          instruction: null,
        },
        {
          n: 2,
          createdAt: "2026-10-06T11:00:00.000Z",
          basedOn: 1,
          reason: "edit" as const,
          at: "delivered" as const,
          instruction: "x",
        },
      ],
    });

    it("music.json від ElevenLabs при musicProvider epidemic → новий трек; той самий провайдер → лишається", async () => {
      const storage = tmpStorage();
      await seedProject(storage);
      await warmCache(storage, FIXTURE_EVENT_CUES);
      const music = fakeEpidemicMusic();
      const { run } = epidemicStage({ music });
      const r1 = await run(makeCtx(storage, draftReply()));
      await seedProject(storage, { rev: 2, project: rev2Project(r1.outputs.planHash) });
      const r2 = await run(
        withParams(makeCtx(storage, draftReply(), { rev: 2, phase: "revision" }), {
          musicProvider: "epidemic",
        }),
      );
      expect(music.calls).toHaveLength(1);
      expect(r2.outputs.reusedMusic).toBe(false);
      expect(r2.outputs.planHash).toBe("e9e9e9e9e9e9e9e9");

      // Ревізія 3 на основі 2 тим самим провайдером: трек Epidemic лишається, фейк не викликається.
      await seedProject(storage, {
        rev: 3,
        project: {
          ...rev2Project(r2.outputs.planHash),
          rev: 3,
          revisions: [
            ...rev2Project(r2.outputs.planHash).revisions,
            {
              n: 3,
              createdAt: "2026-10-06T12:00:00.000Z",
              basedOn: 2,
              reason: "edit",
              at: "delivered",
              instruction: "y",
            },
          ],
        },
      });
      const r3 = await run(
        withParams(makeCtx(storage, draftReply(), { rev: 3, phase: "revision" }), {
          musicProvider: "epidemic",
        }),
      );
      expect(music.calls).toHaveLength(1);
      expect(r3.outputs).toMatchObject({ planHash: r2.outputs.planHash, reusedMusic: true });
    });

    it("music.json з provider epidemic при musicProvider elevenlabs → новий трек ElevenLabs", async () => {
      const storage = tmpStorage();
      await seedProject(storage);
      await warmCache(storage, FIXTURE_EVENT_CUES);
      const client = mockElevenLabs();
      const music = fakeEpidemicMusic();
      const { run } = epidemicStage({ music, client });
      const r1 = await run(withParams(makeCtx(storage, draftReply()), { musicProvider: "epidemic" }));
      expect(client.calls.filter((c) => c.method === "compose")).toHaveLength(0);
      await seedProject(storage, { rev: 2, project: rev2Project(r1.outputs.planHash) });
      const r2 = await run(
        withParams(makeCtx(storage, draftReply(), { rev: 2, phase: "revision" }), {
          musicProvider: "elevenlabs",
        }),
      );
      expect(client.calls.filter((c) => c.method === "compose")).toHaveLength(1);
      expect(r2.outputs.reusedMusic).toBe(false);
      expect(r2.outputs.planHash).not.toBe(r1.outputs.planHash);
      expect((await readManifest(storage, projectPaths(PROJECT_ID).rev(2))).providers.music).toBe(
        "elevenlabs",
      );
    });

    it("canReuseMusic: інший провайдер — ні; старий music.json без поля — ElevenLabs", () => {
      const prev = { briefHash: "a", durationMs: 16_000 };
      expect(canReuseMusic(prev, "a", 16_000)).toBe(true);
      expect(canReuseMusic(prev, "a", 16_000, "elevenlabs")).toBe(true);
      expect(canReuseMusic(prev, "a", 16_000, "epidemic")).toBe(false);
      expect(canReuseMusic({ ...prev, provider: "epidemic" }, "a", 16_000, "epidemic")).toBe(true);
      expect(canReuseMusic({ ...prev, provider: "epidemic" }, "a", 16_000, "elevenlabs")).toBe(false);
    });
  });

  describe("помилки", () => {
    it("без EPIDEMIC_API_KEY і без клієнта → epidemic_not_configured до будь-якого виклику", async () => {
      vi.stubEnv("EPIDEMIC_API_KEY", "");
      const storage = tmpStorage();
      await seedProject(storage);
      const client = mockElevenLabs();
      const music = fakeEpidemicMusic();
      const run = createAudioStage({
        client,
        gate: instantGate(),
        decode: fakeDecoder(),
        qc,
        epidemicQuota: memoryQuota(),
        epidemicCache: tmpStorage(),
        ensureMusicBy: { epidemic: music },
      });
      const ctx = withParams(makeCtx(storage, draftReply()), { musicProvider: "epidemic" });
      const err = await run(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StageError);
      expect(err).toMatchObject({
        code: "epidemic_not_configured",
        userMessage: "Сервіс Epidemic Sound не налаштовано.",
        retryable: false,
      });
      expect(ctx.anthropic.calls).toHaveLength(0);
      expect(music.calls).toHaveLength(0);
      expect(client.calls).toHaveLength(0);
    });

    it("квота в музиці → epidemic_quota з повідомленням квоти, не retryable", async () => {
      const storage = tmpStorage();
      await seedProject(storage);
      await warmCache(storage, FIXTURE_EVENT_CUES);
      const msg = "Epidemic: витрачено 45 з 50 завантажень, поріг 45 — прогін зупинено";
      const { run } = epidemicStage({ music: fakeEpidemicMusic({ fail: new EpidemicError("quota", msg) }) });
      await expect(
        run(withParams(makeCtx(storage, draftReply()), { musicProvider: "epidemic" })),
      ).rejects.toMatchObject({
        name: "StageError",
        code: "epidemic_quota",
        userMessage: msg,
        retryable: false,
      });
    });

    it("unauthorized у музиці → epidemic_not_configured; інша помилка → music_failed (retryable)", async () => {
      const storage = tmpStorage();
      await seedProject(storage);
      await warmCache(storage, FIXTURE_EVENT_CUES);
      const a = epidemicStage({
        music: fakeEpidemicMusic({ fail: new EpidemicError("unauthorized", "401", 401) }),
      });
      await expect(
        a.run(withParams(makeCtx(storage, draftReply()), { musicProvider: "epidemic" })),
      ).rejects.toMatchObject({
        code: "epidemic_not_configured",
        retryable: false,
      });
      const b = epidemicStage({ music: fakeEpidemicMusic({ fail: new Error("catalog empty") }) });
      await expect(
        b.run(withParams(makeCtx(storage, []), { musicProvider: "epidemic" })),
      ).rejects.toMatchObject({
        code: "music_failed",
        retryable: true,
      });
    });

    it("квота в SFX → epidemic_quota; інша помилка SFX — попередження, події без звуку, ролик є", async () => {
      const storage = tmpStorage();
      await seedProject(storage);
      const msg = "Epidemic: витрачено 45 з 50 завантажень, поріг 45 — прогін зупинено";
      const a = epidemicStage({ sfx: fakeEpidemicSfx({ fail: new EpidemicError("quota", msg) }) });
      await expect(
        a.run(withParams(makeCtx(storage, draftReply()), { sfxProvider: "epidemic" })),
      ).rejects.toMatchObject({
        code: "epidemic_quota",
        userMessage: msg,
        retryable: false,
      });
      const b = epidemicStage({ sfx: fakeEpidemicSfx({ fail: new Error("search failed") }) });
      const res = await b.run(withParams(makeCtx(storage, []), { sfxProvider: "epidemic" }));
      expect(res.outputs.mixed).toBe(true);
      const manifest = await readManifest(storage);
      expect(manifest.sfx).toEqual([]);
      expect(manifest.epidemic).toEqual({ trackId: null, sfx: [], downloads: 0 });
    });
  });

  it("buildAudioManifest: providers і epidemic; обидва ElevenLabs → epidemic null", () => {
    const base = { storyboard: fixtureStoryboard, music: null, sfx: [] };
    const ep = { trackId: "t", sfx: [], downloads: 1 };
    expect(buildAudioManifest(base)).toMatchObject({
      providers: { music: "elevenlabs", sfx: "elevenlabs" },
      epidemic: null,
    });
    expect(
      buildAudioManifest({ ...base, providers: { music: "elevenlabs", sfx: "elevenlabs" }, epidemic: ep })
        .epidemic,
    ).toBeNull();
    expect(
      buildAudioManifest({ ...base, providers: { music: "epidemic", sfx: "elevenlabs" }, epidemic: ep }),
    ).toMatchObject({
      providers: { music: "epidemic", sfx: "elevenlabs" },
      epidemic: ep,
    });
  });
});
