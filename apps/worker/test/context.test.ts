import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEmitter,
  createMockAnthropic,
  createPromptLoader,
  readCosts,
  readEvents,
  type StageContext,
} from "@adc/shared";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { buildStageContext, lazyAnthropic, readRunInfo } from "../src/context.ts";
import { parseQueueList } from "../src/env.ts";
import { runStageJob } from "../src/process.ts";
import { makeDeps, NOW, stageJob, tempStorage, writeProject } from "./helpers.ts";

describe("buildStageContext", () => {
  it("phase/source from project.json; cost recorder bound to project/rev/stage/attempt", async () => {
    const storage = await tempStorage();
    await writeProject(storage, { phase: "revision", origin: "eval" });
    const deps = makeDeps(storage);
    const job = stageJob("render", { format: "vertical" }, { rev: 3, attempt: 2, suffix: "vertical" });
    const { ctx } = await buildStageContext(job, deps);
    expect(ctx).toMatchObject({
      projectId: "p1",
      rev: 3,
      stage: "render",
      attempt: 2,
      jobId: "p1.render.r3.a2.vertical",
      phase: "revision",
      source: "eval",
      params: { format: "vertical" },
    });
    await ctx.cost.record({ provider: "remotion", renders: 1 });
    const [cost] = await readCosts(storage, "p1");
    expect(cost).toMatchObject({ rev: 3, stage: "render", attempt: 2, phase: "revision", source: "eval" });
  });

  it("defaults when project.json is missing", async () => {
    const storage = await tempStorage();
    const deps = makeDeps(storage);
    expect(await readRunInfo(storage, "nope", deps.logger)).toEqual({
      phase: "first_delivery",
      source: "chat",
    });
  });

  it("ctx.emit writes progress into Redis Stream events:<projectId> (ioredis-mock)", async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const storage = await tempStorage();
    await writeProject(storage);
    const deps = makeDeps(
      storage,
      {
        crawl: async (ctx: StageContext<"crawl">) => {
          await ctx.emit.progress("crawl", "Сканую сайт… 7/25 сторінок", 7, 25);
          return { artifacts: [], outputs: { mode: "site", partial: false, pages: 7, photos: 0 } };
        },
      },
      { emitterFor: (projectId) => createEmitter(redis, projectId, () => NOW) },
    );
    await runStageJob("crawl", stageJob("crawl", { url: null, manualText: "x" }), deps);
    const events = await readEvents(redis, "p1");
    expect(events.map((e) => e.event)).toEqual([
      {
        type: "progress",
        at: NOW.toISOString(),
        stage: "crawl",
        label: "Сканую сайт… 7/25 сторінок",
        done: 7,
        total: 25,
      },
    ]);
  });

  it("ctx.llm uses the injected client lazily and records costs with stage context", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const promptsDir = await mkdtemp(path.join(os.tmpdir(), "adc-prompts-"));
    await writeFile(
      path.join(promptsDir, "hello.md"),
      "---\nmodel: claude-sonnet-5-5\neffort: low\nmax_tokens: 100\ncache: false\n---\nСистема.\n\n=== user ===\nПривіт, {{name}}",
    );
    let created = 0;
    const deps = makeDeps(
      storage,
      {},
      {
        prompts: createPromptLoader({ dir: promptsDir }),
        anthropic: () => {
          created += 1;
          return createMockAnthropic([{ text: "привіт", usage: { input_tokens: 1000, output_tokens: 10 } }]);
        },
      },
    );
    const { ctx, tracer } = await buildStageContext(stageJob("brandkit", {}), deps);
    expect(created).toBe(0);
    const res = await ctx.llm.text("hello", { name: "Зерно" });
    expect(res.text).toBe("привіт");
    expect(created).toBe(1);
    expect(tracer.prompts().map((p) => p.name)).toEqual(["hello"]);
    const costs = await readCosts(storage, "p1");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "anthropic",
      stage: "brandkit",
      promptName: "hello",
      units: { input: 1000, output: 10 },
    });
  });

  it("lazyAnthropic passes an instance through untouched", () => {
    const client = createMockAnthropic([]);
    expect(lazyAnthropic(client)).toBe(client);
  });
});

describe("env", () => {
  it("WORKER_QUEUES parsing", () => {
    expect(parseQueueList(undefined)).toEqual(["pipeline", "crawl", "llm", "cpu", "audio", "render"]);
    expect(parseQueueList(" render, cpu ,render")).toEqual(["render", "cpu"]);
    expect(() => parseQueueList("gpu")).toThrow(/невідома черга/);
  });
});
