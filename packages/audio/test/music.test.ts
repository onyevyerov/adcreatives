import {
  createCostRecorder,
  createPromptLoader,
  loadPrices,
  MusicMeta,
  projectPaths,
  readCosts,
} from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import type { DecodeAudio } from "../src/decode.ts";
import { ensureMusic, generateMusic, type MusicDeps, musicWavKey } from "../src/music.ts";
import type { StereoPcm } from "../src/pcm.ts";
import { musicPlanHash, normalizeAudioPlan } from "../src/plan.ts";
import { brandTerms, createSanitizer } from "../src/sanitize.ts";
import { loadStandardCues } from "../src/sfx.ts";
import { decodeWav } from "../src/wav.ts";
import {
  audioStream,
  concurrencyBody,
  draftFor,
  elError,
  instantGate,
  mockElevenLabs,
  PROJECT_ID,
  tmpStorage,
  wrappedDetailedError,
} from "./helpers.ts";
import { groove, withGaps } from "./trackSignals.ts";

const layout = computeChunkLayout(fixtureStoryboard);
const plan = normalizeAudioPlan(draftFor(layout), {
  layout,
  storyboard: fixtureStoryboard,
  sanitizer: createSanitizer(brandTerms(fixtureBrandKit)),
  standardCues: loadStandardCues(createPromptLoader()),
});

// Синтетичні «треки» 23 с у темпі брифу (85 BPM): рівний; провал на 1–2.5 с (обходиться
// зсувом вікна на такт); два провали, другий — посеред будь-якого вікна відео.
const GOOD = groove(85, 23);
const ONE_GAP = withGaps(GOOD, [{ fromSec: 1, toSec: 2.5 }]);
const TWO_GAPS = withGaps(GOOD, [
  { fromSec: 1, toSec: 2.5 },
  { fromSec: 10, toSec: 12 },
]);
const TRACKS: Record<string, StereoPcm> = {
  "MUSIC-COMPOSE": GOOD,
  "MUSIC-DETAILED": GOOD,
  GOOD,
  ONE_GAP,
  TWO_GAPS,
};

/** Декодер-мок: мок ElevenLabs віддає текст — текст → синтетичний PCM. */
function fakeDecode(opts: { fail?: boolean } = {}): DecodeAudio & { calls: string[] } {
  const calls: string[] = [];
  const decode: DecodeAudio = async (bytes) => {
    const name = bytes.toString();
    calls.push(name);
    const pcm = TRACKS[name];
    if (opts.fail || !pcm) throw new Error("ffmpeg не знайдено");
    return pcm;
  };
  return Object.assign(decode, { calls });
}

function deps(client: ReturnType<typeof mockElevenLabs>, decode: DecodeAudio = fakeDecode()) {
  const storage = tmpStorage();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev: 1,
    stage: "audio",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  return { storage, client: () => client, gate: instantGate(), cost, decode } satisfies MusicDeps;
}

const badPrompt = (suggestion?: string) =>
  elError(400, {
    detail: {
      status: "bad_prompt",
      message: "contains artist",
      ...(suggestion ? { data: { prompt_suggestion: suggestion } } : {}),
    },
  });

describe("generateMusic", () => {
  it("один compose з promptFallback: music_v2_5, mp3_44100_128, трек = відео + 8 с, витрати в секундах", async () => {
    const client = mockElevenLabs();
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res).toMatchObject({ method: "compose", promptUsed: plan.promptFallback, durationMs: 23_000 });
    expect(res.audio.toString()).toBe("MUSIC-COMPOSE");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.request).toEqual({
      prompt: plan.promptFallback,
      musicLengthMs: 23_000,
      forceInstrumental: true,
      modelId: "music_v2_5",
      outputFormat: "mp3_44100_128",
    });
    expect(client.calls[0]?.options).toMatchObject({ timeoutInSeconds: 300, maxRetries: 0 });
    expect(plan.promptFallback).toMatch(/no breakdown, no fill, no stop in the first 15 seconds/);

    const costs = await readCosts(d.storage, PROJECT_ID);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "elevenlabs",
      model: "music_v2_5",
      units: { seconds: 23 },
      detail: "music:compose",
      stage: "audio",
    });
  });

  it("відхилений промпт із пропозицією → рівно один повтор compose з нею", async () => {
    const client = mockElevenLabs({
      compose: [badPrompt("warm instrumental lo-fi"), audioStream("SUGGESTED")],
    });
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res).toMatchObject({ method: "compose", promptUsed: "warm instrumental lo-fi" });
    expect(res.audio.toString()).toBe("SUGGESTED");
    expect(client.calls.map((c) => c.method)).toEqual(["compose", "compose"]);
    // Відхилений виклик не тарифікується.
    expect((await readCosts(d.storage, PROJECT_ID)).map((c) => c.detail)).toEqual([
      "music:compose:suggested",
    ]);
  });

  it("відхилений промпт без пропозиції → фолбек composeDetailed з одним чанком", async () => {
    const client = mockElevenLabs({ compose: [badPrompt()] });
    const res = await generateMusic(deps(client), plan);
    expect(res).toMatchObject({ method: "composeDetailed", promptUsed: null, durationMs: 23_000 });
    expect(client.calls.map((c) => c.method)).toEqual(["compose", "composeDetailed"]);
    const detailedPlan = client.calls[1]?.request.compositionPlan as
      | { chunks: Array<{ durationMs: number; positiveStyles: string[] }> }
      | undefined;
    const chunks = detailedPlan?.chunks ?? [];
    expect(chunks.map((c) => c.durationMs)).toEqual([23_000]);
    expect(chunks[0]?.positiveStyles).toContain("instrumental");
  });

  it("і запропонований промпт відхилено → composeDetailed; відхилений план із заміною → один повтор з нею", async () => {
    const suggestion = {
      chunks: [
        { text: "[all]", duration_ms: 23_000, positive_styles: ["calm lo-fi"], context_adherence: "high" },
      ],
    };
    const client = mockElevenLabs({
      compose: [badPrompt("first"), badPrompt("second")],
      composeDetailed: [
        wrappedDetailedError(400, {
          detail: { status: "bad_composition_plan", data: { composition_plan_suggestion: suggestion } },
        }),
      ],
    });
    const res = await generateMusic(deps(client), plan);
    expect(res.method).toBe("composeDetailed");
    expect(client.calls.map((c) => c.method)).toEqual([
      "compose",
      "compose",
      "composeDetailed",
      "composeDetailed",
    ]);
    expect(client.calls[3]?.request.compositionPlan).toEqual({
      chunks: [
        { text: "[all]", durationMs: 23_000, positiveStyles: ["calm lo-fi"], contextAdherence: "high" },
      ],
    });
  });

  it("не відмова (ключ API) → помилка одразу, без фолбеку на composeDetailed", async () => {
    const client = mockElevenLabs({ compose: [elError(401, { detail: "invalid api key" })] });
    await expect(generateMusic(deps(client), plan)).rejects.toThrow();
    expect(client.calls.map((c) => c.method)).toEqual(["compose"]);
  });

  it("429 too_many_concurrent_requests повторює черга, а не фолбек", async () => {
    const client = mockElevenLabs({ compose: [elError(429, concurrencyBody)] });
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res.method).toBe("compose");
    expect(client.calls.map((c) => c.method)).toEqual(["compose", "compose"]);
    expect(d.gate.sleeps).toHaveLength(1);
  });

  it("номер спроби (з 2-ї) — у detail витрат", async () => {
    const d = deps(mockElevenLabs());
    await generateMusic(d, plan, { attempt: 2 });
    expect((await readCosts(d.storage, PROJECT_ID)).map((c) => c.detail)).toEqual(["music:compose:attempt2"]);
  });
});

describe("ensureMusic: перевірка, повтори, вікно відео, кеш", () => {
  const paths = projectPaths(PROJECT_ID);
  const readMeta = (d: ReturnType<typeof deps>, hash: string) =>
    d.storage.readJson(paths.musicMeta(hash), (v) => MusicMeta.parse(v));

  it("трек пройшов перевірку з першого разу: music.mp3 + обрізаний music.wav + music.json; повтор — кеш", async () => {
    const client = mockElevenLabs();
    const d = deps(client);
    const first = await ensureMusic(d, PROJECT_ID, plan, "brief1");
    expect(first.cached).toBe(false);
    expect(first.planHash).toBe(musicPlanHash(plan));
    expect(first.key).toBe(musicWavKey(PROJECT_ID, first.planHash));
    expect(first.key.endsWith("/music.wav")).toBe(true);
    // Сирий трек лишається поруч: за ним стадія шукає трек для повторного використання.
    expect((await d.storage.read(paths.music(first.planHash))).toString()).toBe("MUSIC-COMPOSE");
    const wav = decodeWav(await d.storage.read(first.key));
    expect(wav.left.length).toBe(16 * 44_100);

    const meta = await readMeta(d, first.planHash);
    expect(meta).toMatchObject({
      planHash: first.planHash,
      durationMs: 16_000,
      method: "compose",
      briefHash: "brief1",
      attempts: 1,
      offsetMs: 0,
      check: { bpm: 85, ok: true, gaps: [] },
    });
    expect(first.meta).toEqual(meta);

    const second = await ensureMusic(d, PROJECT_ID, structuredClone(plan), "brief1");
    expect(second).toMatchObject({ cached: true, key: first.key });
    expect(client.calls).toHaveLength(1);
  });

  it("ok=false → повторна генерація; витрати кожної спроби — окремий рядок costs.jsonl", async () => {
    const client = mockElevenLabs({
      compose: [audioStream("TWO_GAPS"), audioStream("ONE_GAP"), audioStream("GOOD")],
    });
    const d = deps(client);
    const res = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(client.calls.map((c) => c.method)).toEqual(["compose", "compose", "compose"]);
    expect(res.meta).toMatchObject({ attempts: 3, offsetMs: 0, check: { ok: true } });
    expect((await d.storage.read(paths.music(res.planHash))).toString()).toBe("GOOD");
    const costs = await readCosts(d.storage, PROJECT_ID);
    expect(costs.map((c) => c.detail)).toEqual([
      "music:compose",
      "music:compose:attempt2",
      "music:compose:attempt3",
    ]);
    expect(costs.map((c) => c.units)).toEqual([{ seconds: 23 }, { seconds: 23 }, { seconds: 23 }]);
  });

  it("усі 3 спроби не пройшли → найкраща (найменше провалів) і вікно відео зі зсувом на такт", async () => {
    const client = mockElevenLabs({
      compose: [audioStream("TWO_GAPS"), audioStream("ONE_GAP"), audioStream("TWO_GAPS")],
    });
    const d = deps(client);
    const res = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(client.calls).toHaveLength(3);
    // Найкраща — друга спроба: сирий трек — її.
    expect((await d.storage.read(paths.music(res.planHash))).toString()).toBe("ONE_GAP");
    // Такт 4/4 при 85 BPM ≈ 2824 мс: вікно зсунуто на один такт, повз провал на 1–2.5 с.
    expect(res.meta.offsetMs).toBe(2_824);
    expect(res.meta.attempts).toBe(3);
    // Перевірка — вже обрізаного треку: провалів у вікні відео нема.
    expect(res.meta.check).toMatchObject({ ok: true, gaps: [] });
    const wav = decodeWav(await d.storage.read(res.key));
    expect(wav.left.length).toBe(16 * 44_100);
    expect(await readMeta(d, res.planHash)).toEqual(res.meta);
    expect(await readCosts(d.storage, PROJECT_ID)).toHaveLength(3);
  });

  it("повторна генерація впала → лишається найкраща з наявних спроб", async () => {
    const client = mockElevenLabs({
      compose: [audioStream("ONE_GAP"), elError(401, { detail: "invalid api key" })],
    });
    const d = deps(client);
    const res = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(client.calls).toHaveLength(2);
    expect(res.meta).toMatchObject({ attempts: 1, offsetMs: 2_824, check: { ok: true } });
  });

  it("перша генерація впала → помилка (стадія зробить з неї music_failed)", async () => {
    const client = mockElevenLabs({ compose: [elError(401, { detail: "invalid api key" })] });
    await expect(ensureMusic(deps(client), PROJECT_ID, plan, "b")).rejects.toThrow();
  });

  it("трек не декодувався (немає ffmpeg) → сирий music.mp3, check: null, offsetMs: 0, без повторів", async () => {
    const client = mockElevenLabs();
    const decode = fakeDecode({ fail: true });
    const d = deps(client, decode);
    const res = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(res.key).toBe(paths.music(res.planHash));
    expect(res.meta).toMatchObject({ check: null, offsetMs: 0, attempts: 1, durationMs: 23_000 });
    expect(client.calls).toHaveLength(1);
    expect(await d.storage.exists(musicWavKey(PROJECT_ID, res.planHash))).toBe(false);
    // Кеш: той самий сирий трек, без нових викликів.
    const again = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(again).toMatchObject({ cached: true, key: res.key });
    expect(client.calls).toHaveLength(1);
  });

  it("старий music.json (без check/attempts/offsetMs) + music.mp3 → кеш із сирим треком", async () => {
    const client = mockElevenLabs();
    const d = deps(client);
    const hash = musicPlanHash(plan);
    await d.storage.write(paths.music(hash), Buffer.from("OLD"));
    await d.storage.writeJson(paths.musicMeta(hash), {
      planHash: hash,
      durationMs: 16_000,
      modelId: "music_v2_5",
      method: "composeDetailed",
      promptUsed: null,
      briefHash: "b",
      createdAt: "2026-10-06T10:00:00.000Z",
    });
    const res = await ensureMusic(d, PROJECT_ID, plan, "b");
    expect(res).toMatchObject({ cached: true, key: paths.music(hash) });
    expect(res.meta).toMatchObject({ check: null, attempts: 1, offsetMs: 0 });
    expect(client.calls).toHaveLength(0);
  });
});
