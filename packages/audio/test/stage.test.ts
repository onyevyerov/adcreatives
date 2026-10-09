import {
  AudioManifest,
  AudioPlan,
  createCostRecorder,
  createPromptLoader,
  loadPrices,
  projectPaths,
  readCosts,
  type Storyboard,
  sharedPaths,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import { computeAudioPlacements } from "../src/manifest.ts";
import { loadStandardCues, sfxHash } from "../src/sfx.ts";
import { canReuseMusic, createAudioStage } from "../src/stage.ts";
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

const standardCues = loadStandardCues(createPromptLoader());

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

function stage(client: ReturnType<typeof mockElevenLabs>, storage: ReturnType<typeof tmpStorage>) {
  const gate = instantGate();
  const sharedCost = createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "sfx-cache",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  return { run: createAudioStage({ client, gate, sharedCost }), gate };
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
    expect(plan.compositionPlan.chunks.map((c) => c.durationMs)).toEqual([4_500, 5_000, 6_500]);
    expect(res.outputs).toEqual({ planHash: expect.stringMatching(/^[0-9a-f]{16}$/), reusedMusic: false });

    // Один виклик LLM (модель з frontmatter), один — музики, два SFX (whoosh+shimmer зі спільного кешу, кастомний).
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(ctx.anthropic.calls[0]?.params.model).toBe("claude-opus-5-5");
    expect(client.calls.filter((c) => c.method === "composeDetailed")).toHaveLength(1);
    const sfxCalls = client.calls.filter((c) => c.method === "convert");
    expect(sfxCalls.map((c) => c.request.text).sort()).toEqual(
      [standardCues.whoosh.text, standardCues.shimmer.text, "ceramic cup clink on a wooden table"].sort(),
    );
    const custom = sfxCalls.find((c) => c.request.text === "ceramic cup clink on a wooden table");
    expect(custom?.request).toMatchObject({
      durationSeconds: 0.8,
      promptInfluence: 0.6,
      modelId: "eleven_text_to_sound_v2",
    });

    const manifest = await storage.readJson(rev.audio, (v) => AudioManifest.parse(v));
    expect(manifest).toEqual({
      music: {
        src: "music.mp3",
        durationMs: 16_000,
        fadeOutMs: 1_000,
        volume: 0.8,
        planHash: res.outputs.planHash,
      },
      sfx: [
        { cue: "whoosh", src: "sfx/whoosh.mp3", durationMs: 600, volume: 0.6 },
        { cue: "shimmer", src: "sfx/shimmer.mp3", durationMs: 1_200, volume: 0.6 },
        { cue: "cup-clink", src: "sfx/cup-clink.mp3", durationMs: 800, volume: 0.6 },
      ],
      totalFrames: 450,
    });
    expect((await storage.read(rev.publicFile("music.mp3"))).toString()).toBe("MUSIC-DETAILED");
    expect((await storage.read(rev.publicFile("sfx/cup-clink.mp3"))).toString()).toBe(
      "SFX:ceramic cup clink on a wooden table",
    );
    expect(res.artifacts).toEqual(
      expect.arrayContaining([rev.audioPlan, rev.audio, rev.publicFile("music.mp3")]),
    );

    // Витрати: LLM + музика + кастомний SFX — у журнал проєкту; стандартні SFX — у спільний.
    const costs = await readCosts(storage, PROJECT_ID);
    expect(costs.map((c) => `${c.provider}:${c.detail ?? c.promptName}`).sort()).toEqual(
      ["anthropic:audio-plan", "elevenlabs:music:composeDetailed", "elevenlabs:sfx:cup-clink"].sort(),
    );
    expect(costs.find((c) => c.detail === "sfx:cup-clink")?.units).toEqual({ seconds: 0.8 });
    const shared = await readCosts(storage, null);
    expect(shared.map((c) => c.detail).sort()).toEqual(["sfx:shimmer", "sfx:whoosh"]);
    expect(shared.every((c) => c.stage === "sfx-cache" && c.projectId === null)).toBe(true);
  });

  it("uses the pre-warmed standard SFX cache (no SFX calls) and re-runs hit the plan-hash cache", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    for (const cue of ["whoosh", "pop", "shimmer"] as const) {
      await storage.write(sharedPaths.sfxCache(sfxHash(standardCues[cue])), `CACHED:${cue}`);
    }
    const client = mockElevenLabs();
    const { run } = stage(client, storage);
    const first = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    expect(client.calls.map((c) => c.method)).toEqual(["composeDetailed"]);
    const rev = projectPaths(PROJECT_ID).rev(1);
    expect((await storage.read(rev.publicFile("sfx/pop.mp3"))).toString()).toBe("CACHED:pop");

    // Повтор стадії в тій самій ревізії: план уже є — без LLM; трек — з кешу за хешем плану.
    const ctx2 = makeCtx(storage, []);
    const second = await run(ctx2);
    expect(ctx2.anthropic.calls).toHaveLength(0);
    expect(client.calls).toHaveLength(1);
    expect(second.outputs.planHash).toBe(first.outputs.planHash);
  });

  it("reuse rule: same music brief and video not longer than the track → keep the track", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const { run } = stage(client, storage);
    const r1 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));

    // Ревізія 2: сцена s3 коротша (відео 14 с ≤ трек 16 с), бриф той самий.
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
    expect(r2.outputs).toEqual({ planHash: r1.outputs.planHash, reusedMusic: true });
    // План основи покриває всі cue → без LLM; музика — без виклику API.
    expect(ctx2.anthropic.calls).toHaveLength(0);
    expect(client.calls.filter((c) => c.method !== "convert")).toHaveLength(1);
    const manifest = await storage.readJson(projectPaths(PROJECT_ID).rev(2).audio, (v) =>
      AudioManifest.parse(v),
    );
    expect(manifest.music).toMatchObject({ planHash: r1.outputs.planHash, durationMs: 16_000 });
    expect(manifest.totalFrames).toBe(420);
  });

  it("reuse rule: longer video or changed brief → new track", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const client = mockElevenLabs();
    const { run } = stage(client, storage);
    const r1 = await run(makeCtx(storage, [{ json: draftFor(computeChunkLayout(fixtureStoryboard)) }]));
    const project = { rev: 2, audioPlanHash: r1.outputs.planHash };

    const longer: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 225 } : s)),
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
    expect(client.calls.filter((c) => c.method === "composeDetailed")).toHaveLength(3);

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

describe("computeAudioPlacements", () => {
  it("music from frame 0 with fade-out; SFX at scene sequence starts, riser ends at the boundary", () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, sfxCue: "riser" } : s)),
    };
    const manifest: AudioManifest = {
      music: { src: "music.mp3", durationMs: 16_000, fadeOutMs: 1_000, volume: 0.8, planHash: "h" },
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
