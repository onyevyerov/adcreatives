import { writeFile } from "node:fs/promises";
import { shortStoryboard } from "@adc/render/testing";
import {
  type ChatEvent,
  type Format,
  type MainProps,
  projectPaths,
  type RenderEngine,
  type RenderMediaOptions,
  type RenderStillOptions,
  readCosts,
  StageError,
} from "@adc/shared";
import { fixtureAudioManifest, fixtureBrandKit } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { buildStageContext } from "../src/context.ts";
import {
  createRenderStage,
  type PrepareRenderJobArgs,
  posterFrame,
  stubPrepareRenderJob,
} from "../src/render.ts";
import { makeDeps, stageJob, tempStorage, writeProject } from "./helpers.ts";

const storyboard = shortStoryboard([
  { id: "s1", purpose: "hook" },
  { id: "s2", purpose: "cta" },
  { id: "s3", purpose: "brand" },
]);

function mainProps(format: Format): MainProps {
  return {
    brand: fixtureBrandKit,
    storyboard,
    format,
    assets: {},
    audio: fixtureAudioManifest,
    templateScenes: [],
  };
}

function mockEngine(opts: { failMedia?: boolean } = {}) {
  const calls = {
    bundle: [] as string[],
    media: [] as RenderMediaOptions[],
    still: [] as RenderStillOptions[],
    closed: 0,
  };
  const engine: RenderEngine = {
    async bundleJob({ jobDir }) {
      calls.bundle.push(jobDir);
      return { serveUrl: "http://serve.local/bundle" };
    },
    async renderMedia(o) {
      calls.media.push(o);
      if (opts.failMedia) throw new Error("ffmpeg впав");
      for (const p of [0.01, 0.04, 0.33, 0.5, 0.51, 0.99, 1]) o.onProgress?.(p);
      await writeFile(o.out, "mp4");
      return { durationMs: 4321 };
    },
    async renderStill(o) {
      calls.still.push(o);
      await writeFile(o.out, "png");
      return { logs: [] };
    },
    async close() {
      calls.closed += 1;
    },
  };
  return { engine, calls };
}

async function setup(formats: Format[], format: Format, engineOpts: { failMedia?: boolean } = {}) {
  const storage = await tempStorage();
  await writeProject(storage, { formats, phase: "revision", rev: 2 });
  await storage.writeJson(projectPaths("p1").rev(2).pipeline, {
    attempts: {},
    fixRounds: {},
    qaRounds: 0,
    templateScenes: ["s3"],
    dirtyScenes: [],
  });
  const deps = makeDeps(storage);
  const prepared: PrepareRenderJobArgs[] = [];
  const { engine, calls } = mockEngine(engineOpts);
  const stage = createRenderStage({
    prepareRenderJob: async (args) => {
      prepared.push(args);
      return { jobDir: "/abs/job/video", mainProps: mainProps("vertical") };
    },
    createEngine: () => engine,
  });
  const job = stageJob("render", { format }, { rev: 2, suffix: format });
  const { ctx } = await buildStageContext(job, deps);
  return { storage, deps, stage, ctx, calls, prepared, job };
}

describe("posterFrame", () => {
  it("50% of the cta scene in global Main frames", () => {
    // s1: 0..35, s2: 25..60 (перехід 10), s3: 50..85; 50% від 35 = 18
    expect(posterFrame(storyboard)).toEqual({ sceneId: "s2", frame: 25 + 18 });
  });

  it("falls back to the last scene when there is no cta", () => {
    const noCta = shortStoryboard([
      { id: "s1", purpose: "hook" },
      { id: "s2", purpose: "offer" },
      { id: "s3", purpose: "brand", durationFrames: 60 },
    ]);
    expect(posterFrame(noCta)).toEqual({ sceneId: "s3", frame: 50 + 30 });
  });
});

describe("renderStage", () => {
  it("primary format: bundle → mp4 → poster at cta 50%, cost recorded, engine closed", async () => {
    const { storage, stage, ctx, calls, prepared, deps } = await setup(["vertical", "square"], "vertical");
    const result = await stage(ctx as never);

    const outKey = "projects/p1/rev/2/renders/vertical.mp4";
    expect(result.outputs).toEqual({ format: "vertical", out: outKey, durationMs: 4321 });
    expect(result.artifacts).toEqual([outKey, "projects/p1/rev/2/poster.png"]);
    expect(await storage.exists(outKey)).toBe(true);
    expect(await storage.exists("projects/p1/rev/2/poster.png")).toBe(true);

    expect(prepared).toEqual([
      { storage, projectId: "p1", rev: 2, format: "vertical", templateScenes: ["s3"] },
    ]);
    expect(calls.bundle).toEqual(["/abs/job/video"]);
    expect(calls.media).toHaveLength(1);
    expect(calls.media[0]?.out).toBe(storage.absPath(outKey));
    expect(calls.media[0]?.serveUrl).toBe("http://serve.local/bundle");
    expect(calls.still).toHaveLength(1);
    expect(calls.still[0]).toMatchObject({
      composition: "Main",
      frame: 43,
      format: "vertical",
      out: storage.absPath("projects/p1/rev/2/poster.png"),
    });
    expect(calls.closed).toBe(1);

    const costs = await readCosts(storage, "p1");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "remotion",
      stage: "render",
      rev: 2,
      phase: "revision",
      source: "chat",
      units: { renders: 1 },
      usd: deps.prices.remotion.perRender,
    });

    const events = deps.emitters.get("p1")?.events as ChatEvent[];
    const progress = events.filter((e) => e.type === "progress");
    expect(progress.map((e) => (e.type === "progress" ? e.done : null))).toEqual([0, 33, 50, 99, 100]);
    expect(progress.at(-1)).toMatchObject({ stage: "render", label: "Рендерю 9:16… 100%", total: 100 });
  });

  it("non-primary format: no poster, inputProps.format is the job format", async () => {
    const { stage, ctx, calls, storage } = await setup(["vertical", "square"], "square");
    const result = await stage(ctx as never);
    expect(result.artifacts).toEqual(["projects/p1/rev/2/renders/square.mp4"]);
    expect(calls.still).toHaveLength(0);
    expect(calls.media[0]?.inputProps.format).toBe("square");
    expect(calls.media[0]?.format).toBe("square");
    expect(await readCosts(storage, "p1")).toHaveLength(1);
  });

  it("primary = first of vertical/square/landscape among selected formats", async () => {
    const { stage, ctx, calls } = await setup(["landscape", "square"], "square");
    const result = await stage(ctx as never);
    expect(result.artifacts).toContain("projects/p1/rev/2/poster.png");
    expect(calls.still[0]?.format).toBe("square");
  });

  it("render failure: engine still closed, no cost recorded", async () => {
    const { stage, ctx, calls, storage } = await setup(["vertical"], "vertical", { failMedia: true });
    await expect(stage(ctx as never)).rejects.toThrow("ffmpeg впав");
    expect(calls.closed).toBe(1);
    expect(await readCosts(storage, "p1")).toEqual([]);
  });

  it("stub prepareRenderJob → StageError not_implemented", async () => {
    const err = await stubPrepareRenderJob({} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).code).toBe("not_implemented");
  });
});
