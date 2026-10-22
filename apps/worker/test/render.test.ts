import { rm, writeFile } from "node:fs/promises";
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
  renderInputsHash,
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

async function setup(
  formats: Format[],
  format: Format,
  engineOpts: { failMedia?: boolean } = {},
  opts: { motionKitHash?: () => string; speculative?: boolean; projectRev?: number } = {},
) {
  const storage = await tempStorage();
  await writeProject(storage, { formats, phase: "revision", rev: opts.projectRev ?? 2 });
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
    motionKitHash: opts.motionKitHash ?? (() => "mk-1"),
  });
  const params = opts.speculative ? { format, speculative: true } : { format };
  const job = stageJob("render", params, { rev: 2, suffix: opts.speculative ? `spec-${format}` : format });
  const { ctx } = await buildStageContext(job, deps);
  /** Контекст ще одного job того самого формату (звичайний — після «Затвердити»). */
  const nextCtx = async (attempt = 2, speculative = false) => {
    const next = stageJob("render", speculative ? { format, speculative: true } : { format }, {
      rev: 2,
      attempt,
      suffix: speculative ? `spec-${format}` : format,
    });
    return (await buildStageContext(next, deps)).ctx;
  };
  return { storage, deps, stage, ctx, calls, prepared, job, nextCtx };
}

const progressOf = (deps: { emitters: Map<string, { events: unknown[] }> }) =>
  ((deps.emitters.get("p1")?.events ?? []) as ChatEvent[]).filter((e) => e.type === "progress");

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
});

describe("renderStage — reuse by inputs hash", () => {
  it("writes renders/<format>.meta.json with the inputs hash after a real render", async () => {
    const { storage, stage, ctx } = await setup(["vertical"], "vertical");
    const result = await stage(ctx as never);
    const meta = await storage.readJson(projectPaths("p1").rev(2).renderMeta("vertical"));
    expect(meta).toEqual({ inputsHash: result.inputsHash });
    expect(result.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.reused).toBeUndefined();
  });

  it("same inputs + mp4 on disk → reused: true, no engine, no Remotion cost", async () => {
    const { storage, stage, ctx, calls, nextCtx, deps } = await setup(["vertical", "square"], "vertical");
    const first = await stage(ctx as never);
    const second = await stage((await nextCtx()) as never);
    expect(second).toEqual({
      artifacts: ["projects/p1/rev/2/renders/vertical.mp4", "projects/p1/rev/2/poster.png"],
      outputs: { format: "vertical", out: "projects/p1/rev/2/renders/vertical.mp4", durationMs: 0 },
      reused: true,
      inputsHash: first.inputsHash,
    });
    expect(calls.bundle).toHaveLength(1);
    expect(calls.media).toHaveLength(1);
    expect(calls.closed).toBe(1);
    expect(await readCosts(storage, "p1")).toHaveLength(1);
    // Клієнт усе одно бачить, що формат готовий.
    expect(progressOf(deps).at(-1)).toMatchObject({ label: "Рендерю 9:16… 100%", done: 100 });
  });

  it("missing mp4 or poster → renders again", async () => {
    const { storage, stage, ctx, calls, nextCtx } = await setup(["vertical"], "vertical");
    await stage(ctx as never);
    await rm(storage.absPath(projectPaths("p1").rev(2).poster));
    const second = await stage((await nextCtx()) as never);
    expect(second.reused).toBeUndefined();
    expect(calls.media).toHaveLength(2);
    await rm(storage.absPath(projectPaths("p1").rev(2).render("vertical")));
    const third = await stage((await nextCtx(3)) as never);
    expect(third.reused).toBeUndefined();
    expect(calls.media).toHaveLength(3);
    expect(await readCosts(storage, "p1")).toHaveLength(3);
  });

  it("changed scene code or motion-kit context → renders again", async () => {
    let mk = "mk-1";
    const { storage, stage, ctx, calls, nextCtx } = await setup(
      ["square"],
      "square",
      {},
      {
        motionKitHash: () => mk,
      },
    );
    const rp = projectPaths("p1").rev(2);
    await storage.write(rp.scene("s1"), "export const S1 = 1;");
    const first = await stage(ctx as never);
    await storage.write(rp.scene("s1"), "export const S1 = 2;");
    const second = await stage((await nextCtx()) as never);
    expect(second.reused).toBeUndefined();
    expect(second.inputsHash).not.toBe(first.inputsHash);
    mk = "mk-2";
    const third = await stage((await nextCtx(3)) as never);
    expect(third.reused).toBeUndefined();
    expect(calls.media).toHaveLength(3);
    const fourth = await stage((await nextCtx(4)) as never);
    expect(fourth.reused).toBe(true);
  });

  it("speculative: renders silently (no progress), records cost; the approved job reuses it", async () => {
    const { storage, stage, ctx, calls, nextCtx, deps } = await setup(
      ["vertical"],
      "vertical",
      {},
      {
        speculative: true,
      },
    );
    const spec = await stage(ctx as never);
    expect(spec.reused).toBeUndefined();
    expect(calls.media).toHaveLength(1);
    expect(progressOf(deps)).toEqual([]);
    const costs = await readCosts(storage, "p1");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ provider: "remotion", detail: "preview vertical" });

    const approved = await stage((await nextCtx(1)) as never);
    expect(approved.reused).toBe(true);
    expect(calls.media).toHaveLength(1);
    expect(await readCosts(storage, "p1")).toHaveLength(1);
  });

  it("regular render records cost with detail `render <format>`", async () => {
    const { storage, stage, ctx } = await setup(["vertical", "square"], "square");
    await stage(ctx as never);
    expect((await readCosts(storage, "p1"))[0]).toMatchObject({ detail: "render square" });
  });

  it("speculative render of a stale revision → superseded, nothing prepared or rendered", async () => {
    const { storage, stage, ctx, calls, prepared, deps } = await setup(
      ["vertical"],
      "vertical",
      {},
      { speculative: true, projectRev: 3 },
    );
    const err = await stage(ctx as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "superseded", userMessage: "Превʼю застаріло.", retryable: false });
    expect(prepared).toEqual([]);
    expect(calls.bundle).toEqual([]);
    expect(calls.media).toEqual([]);
    expect(calls.closed).toBe(0);
    expect(await readCosts(storage, "p1")).toEqual([]);
    expect(await storage.exists(projectPaths("p1").rev(2).render("vertical"))).toBe(false);
    expect(progressOf(deps)).toEqual([]);
  });

  it("regular render of an older revision still renders (only speculative jobs are skipped)", async () => {
    const { stage, ctx, calls } = await setup(["vertical"], "vertical", {}, { projectRev: 3 });
    const result = await stage(ctx as never);
    expect(result.reused).toBeUndefined();
    expect(calls.media).toHaveLength(1);
  });

  it("render failure leaves no meta", async () => {
    const { storage, stage, ctx } = await setup(["vertical"], "vertical", { failMedia: true });
    await expect(stage(ctx as never)).rejects.toThrow();
    expect(await storage.exists(projectPaths("p1").rev(2).renderMeta("vertical"))).toBe(false);
  });
});

describe("renderInputsHash", () => {
  it("depends on format, templateScenes, storyboard, audio, brand and motion-kit hash", async () => {
    const storage = await tempStorage();
    const base = { storage, projectId: "p1", rev: 1, templateScenes: [] as string[], motionKitHash: "mk" };
    const h = (over: Partial<typeof base> & { props?: Partial<MainProps> } = {}) => {
      const { props, ...rest } = over;
      return renderInputsHash({ ...base, ...rest, inputProps: { ...mainProps("vertical"), ...props } });
    };
    const ref = await h();
    expect(await h()).toBe(ref);
    const variants = [
      await h({ props: { format: "square" } }),
      await h({ templateScenes: ["s2"] }),
      await h({ motionKitHash: "mk2" }),
      await h({ props: { storyboard: shortStoryboard([{ id: "s1", purpose: "hook" }]) } }),
      await h({ props: { audio: { ...fixtureAudioManifest, music: null } } }),
      await h({
        props: { brand: { ...fixtureBrandKit, identity: { ...fixtureBrandKit.identity, name: "X" } } },
      }),
    ];
    for (const v of variants) expect(v).not.toBe(ref);
    expect(new Set(variants).size).toBe(variants.length);
  });
});
