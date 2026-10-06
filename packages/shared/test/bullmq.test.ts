import type { JobsOptions } from "bullmq";
import { describe, expect, it } from "vitest";
import { type BullQueueLike, createBullQueue, stageEventJobId } from "../src/bullmq.ts";
import type { PipelineJob, QueueName, StageJob, StageName, StageParamsMap } from "../src/index.ts";
import { makeJobId } from "../src/index.ts";

function stageJob<S extends StageName>(
  stage: S,
  params: StageParamsMap[S],
  opts: { suffix?: string } = {},
): StageJob<S> {
  return {
    jobId: makeJobId("p1", stage, 1, 1, opts.suffix),
    projectId: "p1",
    rev: 1,
    stage,
    attempt: 1,
    params,
  };
}

function fakeBull() {
  const added: Array<{ queue: QueueName; name: string; data: unknown; opts?: JobsOptions }> = [];
  const closed: QueueName[] = [];
  const factory = (queue: QueueName): BullQueueLike => ({
    async add(name, data, opts) {
      added.push({ queue, name, data, ...(opts ? { opts } : {}) });
      return {};
    },
    async close() {
      closed.push(queue);
    },
  });
  return { factory, added, closed };
}

describe("BullQueue (producer)", () => {
  it("enqueueStage routes by STAGE_QUEUE with jobId and no retries", async () => {
    const bull = fakeBull();
    const q = createBullQueue({ factory: bull.factory });
    await q.enqueueStage(stageJob("crawl", { url: "https://a.example/", manualText: null }));
    await q.enqueueStage(stageJob("codegen", { sceneIds: null, instructions: [] }));
    await q.enqueueStage(stageJob("check", { sceneIds: null }));
    await q.enqueueStage(stageJob("render", { format: "landscape" }, { suffix: "landscape" }));
    expect(bull.added.map((a) => [a.queue, a.name, a.opts?.jobId, a.opts?.attempts])).toEqual([
      ["crawl", "crawl", "p1.crawl.r1.a1", 1],
      ["llm", "codegen", "p1.codegen.r1.a1", 1],
      ["cpu", "check", "p1.check.r1.a1", 1],
      ["render", "render", "p1.render.r1.a1.landscape", 1],
    ]);
    expect(bull.added[0]?.data).toMatchObject({ projectId: "p1", stage: "crawl", attempt: 1 });
  });

  it("enqueuePipeline passes jobId and delay; commands and events both go to `pipeline`", async () => {
    const bull = fakeBull();
    const q = createBullQueue({ factory: bull.factory });
    const cmd: PipelineJob = {
      kind: "command",
      command: { projectId: "p1", commandId: "c1", issuedAt: "2026-10-06T10:00:00.000Z", type: "start" },
    };
    await q.enqueuePipeline(cmd, { jobId: "p1.cmd.c1", delayMs: 500 });
    await q.enqueuePipeline(cmd);
    expect(bull.added.map((a) => [a.queue, a.name, a.opts?.jobId, a.opts?.delay])).toEqual([
      ["pipeline", "cmd.start", "p1.cmd.c1", 500],
      ["pipeline", "cmd.start", undefined, undefined],
    ]);
    expect(bull.added[0]?.opts?.attempts).toBeGreaterThan(1);
  });

  it("reuses one BullMQ queue per name and closes them all", async () => {
    const bull = fakeBull();
    const q = createBullQueue({ factory: bull.factory });
    await q.enqueueStage(stageJob("brandkit", {}));
    await q.enqueueStage(stageJob("qa", { sceneIds: null }));
    await q.enqueueStage(stageJob("audio", {}));
    await q.close();
    expect(bull.closed.sort()).toEqual(["audio", "llm"]);
  });

  it("requires a connection when no factory is given", async () => {
    const q = createBullQueue();
    await expect(q.enqueueStage(stageJob("audio", {}))).rejects.toThrow(/connection/);
  });

  it("stage event jobId", () => {
    expect(stageEventJobId("p1.audio.r2.a1")).toBe("p1.audio.r2.a1.evt");
  });
});
