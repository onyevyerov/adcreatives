import {
  createCostRecorder,
  createPromptLoader,
  loadPrices,
  type MusicMeta,
  projectPaths,
  readCosts,
} from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import { ensureMusic, generateMusic } from "../src/music.ts";
import { musicPlanHash, normalizeAudioPlan } from "../src/plan.ts";
import { brandTerms, createSanitizer } from "../src/sanitize.ts";
import { loadStandardCues } from "../src/sfx.ts";
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

const layout = computeChunkLayout(fixtureStoryboard);
const plan = normalizeAudioPlan(draftFor(layout), {
  layout,
  storyboard: fixtureStoryboard,
  sanitizer: createSanitizer(brandTerms(fixtureBrandKit)),
  standardCues: loadStandardCues(createPromptLoader()),
});

function deps(client: ReturnType<typeof mockElevenLabs>) {
  const storage = tmpStorage();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev: 1,
    stage: "audio",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  return { storage, client: () => client, gate: instantGate(), cost };
}

const badPrompt = (suggestion: string) =>
  elError(400, {
    detail: { status: "bad_prompt", message: "contains artist", data: { prompt_suggestion: suggestion } },
  });

describe("generateMusic", () => {
  it("composeDetailed happy path: music_v2_5 plan, mp3_44100_128, 300 s timeout, cost in seconds", async () => {
    const client = mockElevenLabs();
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res).toMatchObject({ method: "composeDetailed", promptUsed: null, durationMs: 16_000 });
    expect(res.audio.toString()).toBe("MUSIC-DETAILED");
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    if (!call) throw new Error("немає виклику");
    expect(call.method).toBe("composeDetailed");
    expect(call?.request).toMatchObject({ modelId: "music_v2_5", outputFormat: "mp3_44100_128" });
    const chunks = (
      call.request.compositionPlan as { chunks: Array<{ durationMs: number; positiveStyles: string[] }> }
    ).chunks;
    expect(chunks.map((c) => c.durationMs)).toEqual([4_500, 5_000, 6_500]);
    expect(chunks.every((c) => c.positiveStyles.includes("instrumental"))).toBe(true);
    expect(call?.options).toMatchObject({ timeoutInSeconds: 300, maxRetries: 0 });

    const costs = await readCosts(d.storage, PROJECT_ID);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "elevenlabs",
      model: "music_v2_5",
      units: { seconds: 16 },
      usd: 0.04,
      stage: "audio",
    });
  });

  it("falls back to compose(prompt, musicLengthMs, forceInstrumental) when composeDetailed fails", async () => {
    const client = mockElevenLabs({
      composeDetailed: [wrappedDetailedError(422, { detail: "invalid plan" })],
    });
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res).toMatchObject({ method: "compose", promptUsed: plan.promptFallback, durationMs: 16_000 });
    expect(res.audio.toString()).toBe("MUSIC-COMPOSE");
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed", "compose"]);
    expect(client.calls[1]?.request).toMatchObject({
      prompt: plan.promptFallback,
      musicLengthMs: 16_000,
      forceInstrumental: true,
      modelId: "music_v2_5",
    });
    // Невдалий виклик не тарифікується — лише один запис.
    expect(await readCosts(d.storage, PROJECT_ID)).toHaveLength(1);
  });

  it("retries composeDetailed once with the plan suggested by the API", async () => {
    const suggestion = {
      chunks: [
        { text: "[all]", duration_ms: 16_000, positive_styles: ["calm lo-fi"], context_adherence: "high" },
      ],
    };
    const client = mockElevenLabs({
      composeDetailed: [
        wrappedDetailedError(400, {
          detail: { status: "bad_composition_plan", data: { composition_plan_suggestion: suggestion } },
        }),
      ],
    });
    const res = await generateMusic(deps(client), plan);
    expect(res.method).toBe("composeDetailed");
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed", "composeDetailed"]);
    expect(client.calls[1]?.request.compositionPlan).toEqual({
      chunks: [
        { text: "[all]", durationMs: 16_000, positiveStyles: ["calm lo-fi"], contextAdherence: "high" },
      ],
    });
  });

  it("compose: retries exactly once with the suggested prompt", async () => {
    const client = mockElevenLabs({
      composeDetailed: [wrappedDetailedError(422, { detail: "nope" })],
      compose: [badPrompt("warm instrumental lo-fi"), audioStream("SUGGESTED")],
    });
    const res = await generateMusic(deps(client), plan);
    expect(res).toMatchObject({ method: "compose", promptUsed: "warm instrumental lo-fi" });
    expect(res.audio.toString()).toBe("SUGGESTED");
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed", "compose", "compose"]);

    // Повторна відмова із ще однією пропозицією — далі не повторюємо.
    const client2 = mockElevenLabs({
      composeDetailed: [wrappedDetailedError(422, { detail: "nope" })],
      compose: [badPrompt("first"), badPrompt("second")],
    });
    await expect(generateMusic(deps(client2), plan)).rejects.toThrow();
    expect(client2.calls.filter((c) => c.method === "compose")).toHaveLength(2);
  });

  it("prompt suggestion for a rejected plan goes straight to compose with it", async () => {
    const client = mockElevenLabs({
      composeDetailed: [wrappedDetailedError(400, badPrompt("calm beat").body)],
    });
    const res = await generateMusic(deps(client), plan);
    expect(res.promptUsed).toBe("calm beat");
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed", "compose"]);
  });

  it("429 too_many_concurrent_requests is retried by the gate, not treated as failure", async () => {
    const client = mockElevenLabs({ composeDetailed: [wrappedDetailedError(429, concurrencyBody)] });
    const d = deps(client);
    const res = await generateMusic(d, plan);
    expect(res.method).toBe("composeDetailed");
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed", "composeDetailed"]);
    expect(d.gate.sleeps).toHaveLength(1);
  });
});

describe("ensureMusic (cache by plan hash)", () => {
  it("writes audio/<planHash>/{music.mp3,music.json}; second call is a cache hit without API calls", async () => {
    const client = mockElevenLabs();
    const d = deps(client);
    const first = await ensureMusic(d, PROJECT_ID, plan, "brief1");
    expect(first.cached).toBe(false);
    expect(first.planHash).toBe(musicPlanHash(plan));
    const paths = projectPaths(PROJECT_ID);
    expect((await d.storage.read(paths.music(first.planHash))).toString()).toBe("MUSIC-DETAILED");
    const meta = await d.storage.readJson<MusicMeta>(paths.musicMeta(first.planHash));
    expect(meta).toMatchObject({
      planHash: first.planHash,
      durationMs: 16_000,
      method: "composeDetailed",
      briefHash: "brief1",
    });

    const second = await ensureMusic(d, PROJECT_ID, structuredClone(plan), "brief1");
    expect(second.cached).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});
