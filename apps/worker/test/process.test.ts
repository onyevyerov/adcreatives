import {
  LlmError,
  makeJobId,
  type PipelineCommand,
  type PipelineDriver,
  type PipelineJob,
  readTrace,
  type Stage,
  type StageDoneEvent,
  StageError,
} from "@adc/shared";
import { describe, expect, it } from "vitest";
import {
  handlePipelineJob,
  runStageJob,
  StageFailureReported,
  toErrorInfo,
  workerFailureEvent,
} from "../src/process.ts";
import { stageEventJobId } from "../src/queue.ts";
import { makeDeps, stageJob, tempStorage, writeProject } from "./helpers.ts";

const crawlOk = async () => ({
  artifacts: ["projects/p1/crawl/site.json"],
  outputs: { mode: "site" as const, partial: false, pages: 7, photos: 3 },
});

describe("jobId template", () => {
  it("stage jobs: <projectId>.<stage>.r<rev>.a<attempt>[.<format>]; events: <jobId>.evt", () => {
    expect(makeJobId("abc", "crawl", 1, 1)).toBe("abc.crawl.r1.a1");
    expect(makeJobId("abc", "render", 3, 2, "square")).toBe("abc.render.r3.a2.square");
    expect(stageEventJobId("abc.render.r3.a2.square")).toBe("abc.render.r3.a2.square.evt");
    expect(stageJob("brandkit-patch", { instruction: null, logoAssetId: null, facts: [] }).jobId).toBe(
      "p1.brandkit-patch.r1.a1",
    );
    // BullMQ 6 не приймає ':' у власних ID
    expect(stageEventJobId(makeJobId("abc", "qa", 1, 1))).not.toContain(":");
  });
});

describe("runStageJob", () => {
  it("success → stage_done event in the pipeline queue with the right shape and jobId", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const deps = makeDeps(storage, { crawl: crawlOk });
    const job = stageJob("crawl", { url: "https://zerno.example.com/", manualText: null });

    const event = await runStageJob("crawl", job, deps);

    expect(event).toEqual({
      type: "stage_done",
      projectId: "p1",
      rev: 1,
      stage: "crawl",
      attempt: 1,
      jobId: "p1.crawl.r1.a1",
      durationMs: expect.any(Number),
      artifacts: ["projects/p1/crawl/site.json"],
      outputs: { mode: "site", partial: false, pages: 7, photos: 3 },
      reused: false,
    });
    expect(deps.queue.pipeline).toEqual([{ kind: "stage_event", event }]);
  });

  it("render event carries the format; reused flag is passed through", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const render = async () => ({
      artifacts: ["projects/p1/rev/1/renders/square.mp4"],
      outputs: { format: "square" as const, out: "projects/p1/rev/1/renders/square.mp4", durationMs: 10 },
      reused: true,
    });
    const deps = makeDeps(storage, { render });
    const event = await runStageJob(
      "render",
      stageJob("render", { format: "square" }, { suffix: "square" }),
      deps,
    );
    expect(event).toMatchObject({
      type: "stage_done",
      format: "square",
      reused: true,
      jobId: "p1.render.r1.a1.square",
    });
  });

  it("deduplicates the pipeline event by jobId (double delivery → one event)", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const deps = makeDeps(storage, { crawl: crawlOk });
    const job = stageJob("crawl", { url: "https://zerno.example.com/", manualText: null });
    await runStageJob("crawl", job, deps);
    await runStageJob("crawl", job, deps);
    expect(deps.queue.pipeline).toHaveLength(1);
  });

  it("StageError → stage_failed with code/userMessage/retryable", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const crawl = async () => {
      throw new StageError("0 сторінок", "crawl_failed", "Не вдалося завантажити сайт.", true);
    };
    const deps = makeDeps(storage, { crawl });
    const event = await runStageJob(
      "crawl",
      stageJob("crawl", { url: "https://x.example/", manualText: null }),
      deps,
    );
    expect(event).toMatchObject({
      type: "stage_failed",
      stage: "crawl",
      jobId: "p1.crawl.r1.a1",
      error: {
        code: "crawl_failed",
        message: "StageError: 0 сторінок",
        userMessage: "Не вдалося завантажити сайт.",
        retryable: true,
      },
    });
    expect(deps.queue.pipeline[0]).toEqual({ kind: "stage_event", event });
  });

  it("director stub → stage_failed not_implemented", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const deps = makeDeps(storage);
    const event = await runStageJob("llm", stageJob("storyboard", { durationSeconds: null }), deps);
    expect(event).toMatchObject({
      type: "stage_failed",
      error: { code: "not_implemented", retryable: false },
    });
  });

  it("a stage that doesn't belong to the queue → stage_failed unknown_stage", async () => {
    const storage = await tempStorage();
    const deps = makeDeps(storage, { crawl: crawlOk });
    const event = await runStageJob("llm", stageJob("crawl", { url: null, manualText: "x" }), deps);
    expect(event).toMatchObject({ type: "stage_failed", error: { code: "unknown_stage", retryable: false } });
  });

  it("writes a trace entry when the stage did not, and none twice when it did", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const brandkit = async () => ({ artifacts: [], outputs: { version: 1 } });
    const crawl: Stage<"crawl"> = async (ctx) => {
      await ctx.trace.record({
        rev: 1,
        stage: "crawl",
        attempt: 1,
        phase: "first_delivery",
        jobId: ctx.jobId,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        ok: true,
        error: null,
      });
      return crawlOk();
    };
    const deps = makeDeps(storage, { brandkit, crawl });
    await runStageJob("llm", stageJob("brandkit", {}), deps);
    await runStageJob("crawl", stageJob("crawl", { url: null, manualText: "x" }), deps);
    const trace = await readTrace(storage, "p1");
    expect(trace.map((t) => [t.stage, t.ok, t.jobId])).toEqual([
      ["brandkit", true, "p1.brandkit.r1.a1"],
      ["crawl", true, "p1.crawl.r1.a1"],
    ]);
  });

  it("aborted stage → stage_failed aborted", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const ac = new AbortController();
    const crawl: Stage<"crawl"> = async (ctx) => {
      ac.abort();
      ctx.signal?.throwIfAborted();
      return crawlOk();
    };
    const deps = makeDeps(storage, { crawl });
    const event = await runStageJob(
      "crawl",
      stageJob("crawl", { url: null, manualText: "x" }),
      deps,
      ac.signal,
    );
    expect(event).toMatchObject({ type: "stage_failed", error: { code: "aborted", retryable: true } });
  });
});

describe("toErrorInfo", () => {
  it("maps LlmError and generic errors", () => {
    expect(toErrorInfo(new LlmError("відмова", "refusal"))).toMatchObject({
      code: "llm_refusal",
      retryable: true,
    });
    expect(toErrorInfo(new Error("boom"))).toEqual({
      code: "internal",
      message: "Error: boom",
      userMessage: "Внутрішня помилка етапу.",
      retryable: true,
    });
    expect(toErrorInfo("x".repeat(5000)).message.length).toBe(2000);
  });
});

describe("workerFailureEvent (stalled / crashed job)", () => {
  it("stalled job → stage_failed code stalled with duration from processedOn", () => {
    const job = stageJob("render", { format: "vertical" }, { suffix: "vertical" });
    const event = workerFailureEvent(job, new Error("job stalled more than allowable limit"), 1_000, 61_000);
    expect(event).toEqual({
      type: "stage_failed",
      projectId: "p1",
      rev: 1,
      stage: "render",
      attempt: 1,
      jobId: "p1.render.r1.a1.vertical",
      durationMs: 60_000,
      format: "vertical",
      error: {
        code: "stalled",
        message: "job stalled more than allowable limit",
        userMessage: "Етап завис і був зупинений.",
        retryable: true,
      },
    } satisfies StageDoneEvent);
  });

  it("other worker errors → worker_error", () => {
    const event = workerFailureEvent(
      stageJob("check", { sceneIds: null }),
      new Error("lock lost"),
      undefined,
    );
    expect(event).toMatchObject({ type: "stage_failed", durationMs: 0, error: { code: "worker_error" } });
  });
});

describe("handlePipelineJob", () => {
  const command: PipelineCommand = {
    projectId: "p1",
    commandId: "c1",
    issuedAt: "2026-10-06T10:00:00.000Z",
    type: "approve",
    rev: 1,
  };

  it("commands → driver.handleCommand, stage events → driver.onStageDone", async () => {
    const seen: string[] = [];
    const driver: PipelineDriver = {
      handleCommand: async (cmd) => {
        seen.push(`cmd:${cmd.type}`);
      },
      onStageDone: async (e) => {
        seen.push(`evt:${e.type}:${e.stage}`);
      },
    };
    await handlePipelineJob({ kind: "command", command }, driver);
    const event = workerFailureEvent(stageJob("qa", { sceneIds: null }), new Error("stalled"), undefined);
    await handlePipelineJob({ kind: "stage_event", event }, driver);
    expect(seen).toEqual(["cmd:approve", "evt:stage_failed:qa"]);
  });

  it("unknown job kind → unrecoverable error", async () => {
    const driver = { handleCommand: async () => {}, onStageDone: async () => {} };
    await expect(handlePipelineJob({ kind: "nope" } as unknown as PipelineJob, driver)).rejects.toThrow(
      /невідомий job/,
    );
  });

  it("StageFailureReported is a named error", () => {
    expect(new StageFailureReported("x").name).toBe("StageFailureReported");
  });
});
