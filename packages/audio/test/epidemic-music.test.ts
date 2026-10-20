import {
  createCostRecorder,
  createPromptLoader,
  type Logger,
  loadPrices,
  type MockReply,
  MusicMeta,
  noopLogger,
  projectPaths,
  readCosts,
} from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import type { DecodeAudio } from "../src/decode.ts";
import type { EpidemicGate } from "../src/epidemic/gate.ts";
import {
  EPIDEMIC_VERSION_POLL_MS,
  EPIDEMIC_VERSION_TIMEOUT_MS,
  type EpidemicMusicDeps,
  ensureEpidemicMusic,
  epidemicMusicCacheKey,
  tempoMatches,
  tempoRanges,
  versionPhase,
} from "../src/epidemic/music.ts";
import type { StereoPcm } from "../src/pcm.ts";
import { musicPlanHash, musicPlanHashFor, normalizeAudioPlan } from "../src/plan.ts";
import { EpidemicError, type EpidemicTrack } from "../src/provider.ts";
import { brandTerms, createSanitizer } from "../src/sanitize.ts";
import { loadStandardCues } from "../src/sfx.ts";
import { type EpidemicFixtures, memoryQuota, mockEpidemic } from "./epidemicHelpers.ts";
import { draftFor, instantGate, makeCtx, mockElevenLabs, PROJECT_ID, tmpStorage } from "./helpers.ts";
import { groove, withGaps } from "./trackSignals.ts";

const layout = computeChunkLayout(fixtureStoryboard);
const plan = normalizeAudioPlan(draftFor(layout), {
  layout,
  storyboard: fixtureStoryboard,
  sanitizer: createSanitizer(brandTerms(fixtureBrandKit)),
  standardCues: loadStandardCues(createPromptLoader()),
});
const TARGET = 85;
const TRACK_MS = 23_000;

// Синтетичні «треки» у темпі брифу: рівний 23 с; з провалом посеред будь-якого вікна; короткий.
const GOOD = groove(85, 23);
const TWO_GAPS = withGaps(GOOD, [
  { fromSec: 1, toSec: 2.5 },
  { fromSec: 10, toSec: 12 },
]);
const SHORT = groove(85, 8);

const track = (id: string, bpm: number | null, extra: Partial<EpidemicTrack> = {}): EpidemicTrack => ({
  id,
  title: `Title ${id}`,
  mainArtists: [`Artist ${id}`],
  bpm,
  length: 120,
  moods: [{ id: "m1", name: "Happy" }],
  genres: [{ id: "g1", name: "Lo-Fi" }],
  hasVocals: false,
  ...extra,
});

/** Декодер-мок: байти мока Epidemic містять URL (`…/<id>.mp3` або `…/job-<id>.mp3`) — за id → PCM. */
function fakeDecode(tracks: Record<string, StereoPcm | "fail">): DecodeAudio & { calls: string[] } {
  const calls: string[] = [];
  const decode: DecodeAudio = async (bytes) => {
    const text = bytes.toString();
    calls.push(text);
    const id = /\/(?:job-)?([^/]+)\.mp3$/.exec(text)?.[1] ?? "";
    const pcm = tracks[id] ?? GOOD;
    if (pcm === "fail") throw new Error("ffmpeg не знайдено");
    return pcm;
  };
  return Object.assign(decode, { calls });
}

interface Setup {
  fixtures?: EpidemicFixtures;
  replies?: MockReply[];
  quotaStart?: number;
  decode?: DecodeAudio;
  logger?: Logger;
  cache?: ReturnType<typeof tmpStorage>;
}

function setup(o: Setup = {}) {
  const storage = tmpStorage();
  const cache = o.cache ?? tmpStorage();
  const client = mockEpidemic(o.fixtures);
  const quota = memoryQuota(o.quotaStart ?? 0);
  const ctx = makeCtx(storage, o.replies ?? []);
  const sleeps: number[] = [];
  // Прохідна черга з журналом міток: тести не залежать від повторів справжньої EpidemicGate.
  const gateLabels: string[] = [];
  const gate = {
    run: <T>(label: string, fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
      gateLabels.push(label);
      return fn(signal);
    },
  } as unknown as EpidemicGate;
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev: 1,
    stage: "audio",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const deps: EpidemicMusicDeps = {
    storage,
    client: () => mockElevenLabs(),
    gate: instantGate(),
    cost,
    decode: o.decode ?? fakeDecode({}),
    logger: o.logger ?? noopLogger,
    llm: ctx.llm,
    targetBpm: TARGET,
    epidemic: { client: () => client, quota, cache, gate },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-10-19T10:00:00.000Z"),
  };
  return { storage, cache, client, quota, anthropic: ctx.anthropic, sleeps, gateLabels, deps };
}

const searches = (client: ReturnType<typeof mockEpidemic>) =>
  client.calls.filter((c) => c.method === "searchTracks").map((c) => c.args[0] as Record<string, unknown>);
const called = (client: ReturnType<typeof mockEpidemic>, method: string) =>
  client.calls.filter((c) => c.method === method);

function capture(): Logger & { warns: string[]; warnMeta: Array<Record<string, unknown> | undefined> } {
  const warns: string[] = [];
  const warnMeta: Array<Record<string, unknown> | undefined> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, meta) => {
      warns.push(msg);
      warnMeta.push(meta as Record<string, unknown> | undefined);
    },
    error: () => {},
    child: () => logger,
  };
  return Object.assign(logger, { warns, warnMeta });
}

describe("versionPhase", () => {
  it("COMPLETED — готово; FAILED/ERROR/CANCELLED — збій; решта (зокрема невідомі) — опитуємо далі", () => {
    expect(versionPhase("COMPLETED")).toBe("completed");
    expect(versionPhase("completed")).toBe("completed");
    for (const s of ["FAILED", "error", "Cancelled", "CANCELED"]) expect(versionPhase(s)).toBe("failed");
    for (const s of ["PENDING", "in_progress", "Processing", "QUEUED", "running", "STARTED", "WEIRD", ""]) {
      expect(versionPhase(s)).toBe("pending");
    }
  });
});

describe("tempoMatches / tempoRanges", () => {
  it("трек, його половина або подвоєння в межах допуску; null — ні", () => {
    expect(tempoMatches(85, 85, 6)).toBe(true);
    expect(tempoMatches(91, 85, 6)).toBe(true);
    expect(tempoMatches(92, 85, 6)).toBe(false);
    expect(tempoMatches(43, 85, 6)).toBe(true); // half-time: 86
    expect(tempoMatches(170, 85, 6)).toBe(true); // double-time: 85
    expect(tempoMatches(182, 85, 6)).toBe(true); // 91
    expect(tempoMatches(184, 85, 6)).toBe(false); // 92
    expect(tempoMatches(null, 85, 6)).toBe(false);
    expect(tempoMatches(94, 85, 10)).toBe(true);
  });

  it("діапазони: t±6, t/2±3, 2t±12 — цілі, не нижче 40", () => {
    expect(tempoRanges(85, 6)).toEqual([
      { bpmMin: 79, bpmMax: 91 },
      { bpmMin: 40, bpmMax: 46 },
      { bpmMin: 158, bpmMax: 182 },
    ]);
    expect(tempoRanges(120, 10)).toEqual([
      { bpmMin: 110, bpmMax: 130 },
      { bpmMin: 55, bpmMax: 65 },
      { bpmMin: 220, bpmMax: 260 },
    ]);
    // Половина темпу цілком нижче 40 — діапазон не шукається.
    expect(tempoRanges(70, 6)).toHaveLength(2);
  });
});

describe("ensureEpidemicMusic", () => {
  it("раунд 1: три пошуки, злиття без дублікатів, сортування за відхиленням → вибір LLM → версія", async () => {
    const s = setup({
      fixtures: {
        searchTracks: [
          { tracks: [track("a", 85), track("b", 88), track("c", null), track("x", 100)] },
          { tracks: [track("d", 43), track("a", 85)] },
          { tracks: [track("e", 170), track("f", 200)] },
        ],
        versionStatus: [{ status: "PENDING" }],
      },
      replies: [{ json: { trackId: "d", reason: "warm lo-fi groove" } }],
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "brief-1");

    const q = searches(s.client);
    expect(q).toHaveLength(3);
    const base = { term: plan.promptFallback, vocalType: ["NONE"], limit: 30, sort: "Relevance" };
    expect(q[0]).toEqual({ ...base, bpmMin: 79, bpmMax: 91 });
    expect(q[1]).toEqual({ ...base, bpmMin: 40, bpmMax: 46 });
    expect(q[2]).toEqual({ ...base, bpmMin: 158, bpmMax: 182 });

    // Один виклик LLM з таблицею кандидатів у порядку: a(0), e(0), d(1), b(3); c (null) і x, f — поза.
    expect(s.anthropic.calls).toHaveLength(1);
    const user = JSON.stringify(s.anthropic.calls[0]?.params.messages);
    const order = ["a", "e", "d", "b"].map((id) => user.indexOf(`\\"id\\": \\"${id}\\"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(user).not.toContain('\\"id\\": \\"c\\"');
    expect(user).not.toContain('\\"id\\": \\"f\\"');
    expect(user).toContain("Target tempo: 85 BPM");

    // Версія обраного треку на тривалість треку плану, опитування кожні 3 с.
    expect(called(s.client, "startVersion")[0]?.args[0]).toEqual({ trackId: "d", durationMs: TRACK_MS });
    expect(called(s.client, "versionStatus")).toHaveLength(2);
    expect(s.sleeps).toEqual([EPIDEMIC_VERSION_POLL_MS, EPIDEMIC_VERSION_POLL_MS]);
    expect(called(s.client, "fetchBytes")[0]?.args[0]).toBe("https://dl.example/version/job-d.mp3");
    expect(called(s.client, "trackDownloadUrl")).toHaveLength(0);
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "version_fetch"]);
    expect(res.downloads).toBe(2);
    // Кожен мережевий виклик — через чергу Epidemic.
    expect(s.gateLabels).toHaveLength(s.client.calls.length);

    // Запис — той самий хвіст, що в ElevenLabs, з метаданими Epidemic.
    expect(res.planHash).toBe(musicPlanHashFor("epidemic", plan));
    expect(res.planHash).not.toBe(musicPlanHash(plan));
    expect(res.cached).toBe(false);
    expect(res.key).toBe(`${projectPaths(PROJECT_ID).audioDir}/${res.planHash}/music.wav`);
    const meta = await s.storage.readJson(projectPaths(PROJECT_ID).musicMeta(res.planHash), (v) =>
      MusicMeta.parse(v),
    );
    expect(meta).toMatchObject({
      provider: "epidemic",
      method: "catalog",
      modelId: "epidemic-catalog",
      promptUsed: plan.promptFallback,
      briefHash: "brief-1",
      attempts: 1,
      epidemic: {
        trackId: "d",
        title: "Title d",
        artists: ["Artist d"],
        bpm: 43,
        targetBpm: 85,
        tempoWarning: false,
        versionJobId: "job-d",
        versionStatus: "COMPLETED",
        candidatesTried: 1,
      },
    });
    expect(meta.check?.ok).toBe(true);
    expect((await s.storage.read(projectPaths(PROJECT_ID).music(res.planHash))).toString()).toBe(
      "BYTES:https://dl.example/version/job-d.mp3",
    );
    // Постійний кеш завантажень і рядок витрат (usd 0).
    expect(await s.cache.exists(epidemicMusicCacheKey("d", TRACK_MS))).toBe(true);
    const costs = (await readCosts(s.storage, PROJECT_ID)).filter((c) => c.provider === "epidemic");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "epidemic",
      model: "epidemic-catalog",
      usd: 0,
      units: { seconds: 23 },
      detail: "music:epidemic:d",
    });
  });

  it("раунд 2: нікого в ±6 → ті самі три пошуки з ±10", async () => {
    const s = setup({
      fixtures: {
        searchTracks: [
          // Раунд 1: 94 BPM — поза ±6; раунд 2: той самий трек уже в допуску ±10.
          { tracks: [track("a", 94)] },
          { tracks: [] },
          { tracks: [] },
          { tracks: [track("a", 94)] },
          { tracks: [] },
          { tracks: [] },
        ],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    const q = searches(s.client);
    expect(q.map((x) => [x.bpmMin, x.bpmMax])).toEqual([
      [79, 91],
      [40, 46],
      [158, 182],
      [75, 95],
      [40, 48],
      [150, 190],
    ]);
    // Один кандидат — без LLM.
    expect(s.anthropic.calls).toHaveLength(0);
    expect(res.meta.epidemic).toMatchObject({ trackId: "a", bpm: 94, tempoWarning: false });
  });

  it("раунд 3: нікого в ±10 → пошук без темпу, найближчий, tempoWarning, без LLM", async () => {
    const log = capture();
    const s = setup({
      logger: log,
      fixtures: {
        searchTracks: [
          ...Array.from({ length: 6 }, () => ({ tracks: [] })),
          { tracks: [track("far", 130), track("nobpm", null), track("near", 100)] },
        ],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    const q = searches(s.client);
    expect(q).toHaveLength(7);
    expect(q[6]).toEqual({ term: plan.promptFallback, vocalType: ["NONE"], limit: 30, sort: "Relevance" });
    expect(s.anthropic.calls).toHaveLength(0);
    expect(res.meta.epidemic).toMatchObject({ trackId: "near", bpm: 100, tempoWarning: true });
    expect(log.warns.some((w) => w.includes("±10"))).toBe(true);
  });

  it("невідомий trackId від LLM → перший кандидат і попередження", async () => {
    const log = capture();
    const s = setup({
      logger: log,
      fixtures: { searchTracks: [{ tracks: [track("a", 85), track("b", 86)] }] },
      replies: [{ json: { trackId: "zzz", reason: "?" } }],
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(s.anthropic.calls).toHaveLength(1);
    expect(res.meta.epidemic?.trackId).toBe("a");
    expect(log.warns.some((w) => w.includes("невідомий"))).toBe(true);
  });

  it("проміжні статуси (IN_PROGRESS, processing, QUEUED) → опитуємо далі: version + version_fetch, без track", async () => {
    const log = capture();
    const s = setup({
      logger: log,
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        startVersion: [{ jobId: "job-a", status: "QUEUED" }],
        versionStatus: [{ status: "IN_PROGRESS" }, { status: "processing" }],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(called(s.client, "versionStatus")).toHaveLength(3);
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "version_fetch"]);
    expect(called(s.client, "trackDownloadUrl")).toHaveLength(0);
    expect(called(s.client, "fetchBytes").map((c) => c.args[0])).toEqual([
      "https://dl.example/version/job-a.mp3",
    ]);
    expect(res.downloads).toBe(2);
    expect(res.meta.epidemic).toMatchObject({ versionJobId: "job-a", versionStatus: "COMPLETED" });
    // Відомі проміжні статуси — без попереджень.
    expect(log.warns).toEqual([]);
  });

  it("невідомий статус → один warn з фактичним статусом, опитуємо далі до COMPLETED", async () => {
    const log = capture();
    const s = setup({
      logger: log,
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        versionStatus: [{ status: "WARMING_UP" }, { status: "WARMING_UP" }, { status: "WARMING_UP" }],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(called(s.client, "versionStatus")).toHaveLength(4);
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "version_fetch"]);
    expect(res.meta.epidemic?.versionStatus).toBe("COMPLETED");
    const unknown = log.warns.flatMap((w, i) => (w.includes("невідомий статус") ? [log.warnMeta[i]] : []));
    expect(unknown).toEqual([{ trackId: "a", jobId: "job-a", status: "WARMING_UP" }]);
  });

  it("явний збій на старті (error) → без опитування, одразу повний трек", async () => {
    const s = setup({
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        startVersion: [{ jobId: "job-a", status: "error" }],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(called(s.client, "versionStatus")).toHaveLength(0);
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "track"]);
    expect(res.meta.epidemic).toMatchObject({ versionJobId: null, versionStatus: "error" });
  });

  it("версія впала (FAILED) → одразу повний трек high: version + track у квоті", async () => {
    const log = capture();
    const s = setup({
      logger: log,
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        versionStatus: [{ status: "FAILED", message: "boom" }],
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "track"]);
    expect(called(s.client, "trackDownloadUrl")[0]?.args).toEqual(["a", { quality: "high" }]);
    expect(called(s.client, "fetchBytes").map((c) => c.args[0])).toEqual(["https://dl.example/track/a.mp3"]);
    expect(res.downloads).toBe(2);
    expect(res.meta.epidemic?.versionJobId).toBeNull();
    expect(res.meta.epidemic?.versionStatus).toBe("FAILED");
    // Одне опитування — далі не чекаємо; у журналі фактичний статус і message API.
    expect(called(s.client, "versionStatus")).toHaveLength(1);
    const i = log.warns.findIndex((w) => w.includes("не готова"));
    expect(log.warnMeta[i]).toMatchObject({
      trackId: "a",
      jobId: "job-a",
      status: "FAILED",
      message: "boom",
    });
    const costs = (await readCosts(s.storage, PROJECT_ID)).filter((c) => c.provider === "epidemic");
    expect(costs).toHaveLength(1);
    expect(costs[0]?.units).toEqual({ seconds: 120 });
  });

  it("версія не готова за 5 хв → фолбек на повний трек; помилка старту — теж фолбек", async () => {
    const s = setup({
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        versionStatus: Array.from({ length: 200 }, () => ({ status: "PENDING" })),
      },
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(s.sleeps.reduce((a, b) => a + b, 0)).toBe(EPIDEMIC_VERSION_TIMEOUT_MS);
    expect(s.quota.consumed.map((c) => c.kind)).toEqual(["version", "track"]);
    expect(res.meta.epidemic?.versionStatus).toBe("TIMEOUT");

    const s2 = setup({
      fixtures: {
        searchTracks: [{ tracks: [track("a", 85)] }],
        startVersion: [new EpidemicError("server", "500", 500)],
      },
    });
    const res2 = await ensureEpidemicMusic(s2.deps, PROJECT_ID, plan, "b");
    expect(s2.quota.consumed.map((c) => c.kind)).toEqual(["version", "track"]);
    expect(res2.meta.epidemic?.versionStatus).toBeNull();
  });

  it("checkTrack ok=false → рівно один повтор з наступним кандидатом, без нового виклику LLM", async () => {
    const s = setup({
      fixtures: { searchTracks: [{ tracks: [track("a", 85), track("b", 85), track("c", 85)] }] },
      replies: [{ json: { trackId: "a", reason: "r" } }],
      decode: fakeDecode({ a: TWO_GAPS, b: GOOD }),
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(s.anthropic.calls).toHaveLength(1);
    expect(called(s.client, "startVersion").map((c) => (c.args[0] as { trackId: string }).trackId)).toEqual([
      "a",
      "b",
    ]);
    expect(res.meta.epidemic).toMatchObject({ trackId: "b", candidatesTried: 2 });
    expect(res.meta.attempts).toBe(2);
    expect(res.meta.check?.ok).toBe(true);
    expect(res.downloads).toBe(4);
  });

  it("обидва кандидати не пройшли → betterCheck, третього не беремо", async () => {
    const s = setup({
      fixtures: { searchTracks: [{ tracks: [track("a", 85), track("b", 85), track("c", 85)] }] },
      replies: [{ json: { trackId: "a", reason: "r" } }],
      decode: fakeDecode({ a: TWO_GAPS, b: TWO_GAPS, c: GOOD }),
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(called(s.client, "startVersion")).toHaveLength(2);
    expect(res.meta.epidemic?.candidatesTried).toBe(2);
    expect(res.meta.epidemic?.trackId).toBe("a");
  });

  it("трек коротший за відео → наступний кандидат; єдиний короткий — сирий, check null", async () => {
    const s = setup({
      fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] },
      decode: fakeDecode({ a: SHORT }),
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(res.meta.check).toBeNull();
    expect(res.key).toBe(projectPaths(PROJECT_ID).music(res.planHash));
  });

  it("короткий перший кандидат → наступний з перевіркою", async () => {
    const s = setup({
      fixtures: { searchTracks: [{ tracks: [track("a", 85), track("b", 85)] }] },
      replies: [{ json: { trackId: "a", reason: "r" } }],
      decode: fakeDecode({ a: SHORT, b: GOOD }),
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(res.meta.epidemic).toMatchObject({ trackId: "b", candidatesTried: 2 });
    expect(res.meta.check?.ok).toBe(true);
  });

  it("не розкодовано → сирий трек без повтору", async () => {
    const s = setup({
      fixtures: { searchTracks: [{ tracks: [track("a", 85), track("b", 85)] }] },
      replies: [{ json: { trackId: "a", reason: "r" } }],
      decode: fakeDecode({ a: "fail", b: "fail" }),
    });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(called(s.client, "startVersion")).toHaveLength(1);
    expect(res.meta.check).toBeNull();
    expect(res.meta.epidemic?.candidatesTried).toBe(1);
  });

  it("кеш-хіт audio/<planHash>/ — нуль викликів і нуль завантажень", async () => {
    const s = setup({ fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] } });
    await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    const calls = s.client.calls.length;
    const consumed = s.quota.consumed.length;
    const again = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(again.cached).toBe(true);
    expect(again.downloads).toBe(0);
    expect(again.meta.provider).toBe("epidemic");
    expect(s.client.calls).toHaveLength(calls);
    expect(s.quota.consumed).toHaveLength(consumed);
  });

  it("постійний кеш Epidemic: новий проєкт з тим самим треком — без завантажень", async () => {
    const first = setup({ fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] } });
    await ensureEpidemicMusic(first.deps, PROJECT_ID, plan, "b");
    const s = setup({ cache: first.cache, fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] } });
    const res = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b");
    expect(s.quota.consumed).toHaveLength(0);
    expect(res.downloads).toBe(0);
    expect(called(s.client, "fetchBytes")).toHaveLength(0);
    expect(res.meta.check?.ok).toBe(true);
  });

  it("квота 45 → EpidemicError quota до будь-якого завантаження", async () => {
    const s = setup({ quotaStart: 45, fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] } });
    const err = await ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpidemicError);
    expect((err as EpidemicError).kind).toBe("quota");
    for (const m of ["startVersion", "versionStatus", "trackDownloadUrl", "fetchBytes"]) {
      expect(called(s.client, m)).toHaveLength(0);
    }
  });

  it("пошук без жодного треку → EpidemicError not_found", async () => {
    const s = setup();
    await expect(ensureEpidemicMusic(s.deps, PROJECT_ID, plan, "b")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(searches(s.client)).toHaveLength(7);
  });

  it("term обрізано до 500 символів", async () => {
    const long = { ...plan, promptFallback: `${"x".repeat(600)} instrumental` };
    const s = setup({ fixtures: { searchTracks: [{ tracks: [track("a", 85)] }] } });
    await ensureEpidemicMusic(s.deps, PROJECT_ID, long, "b");
    expect(String(searches(s.client)[0]?.term).length).toBe(500);
  });
});
