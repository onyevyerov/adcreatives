import { makeCommandJobId, makeJobId, type QueueName, type StageJob } from "@adc/shared";
import type { JobsOptions } from "bullmq";
import { describe, expect, it } from "vitest";
import { BullQueue, type QueueProducer } from "../src/queue/bullmq.ts";

function fakeFactory() {
  const added: Array<{ queue: QueueName; name: string; data: unknown; opts?: JobsOptions }> = [];
  const closed: QueueName[] = [];
  const factory = (queue: QueueName): QueueProducer => ({
    add: async (name, data, opts) => {
      added.push({ queue, name, data, ...(opts ? { opts } : {}) });
    },
    close: async () => {
      closed.push(queue);
    },
  });
  return { factory, added, closed };
}

describe("BullQueue (продюсер BullMQ)", () => {
  it("команди → черга pipeline з jobId і name = kind", async () => {
    const f = fakeFactory();
    const q = new BullQueue(f.factory);
    const command = {
      projectId: "p1",
      commandId: "c1",
      issuedAt: "2026-10-06T10:00:00.000Z",
      type: "start" as const,
    };
    await q.enqueuePipeline(
      { kind: "command", command },
      { jobId: makeCommandJobId("p1", "c1"), delayMs: 500 },
    );
    expect(f.added).toEqual([
      {
        queue: "pipeline",
        name: "command",
        data: { kind: "command", command },
        opts: expect.objectContaining({ jobId: "p1.cmd.c1", delay: 500, attempts: 1 }),
      },
    ]);
  });

  it("стадії → черга за STAGE_QUEUE, jobId зі StageJob; продюсер на чергу створюється раз", async () => {
    const f = fakeFactory();
    const q = new BullQueue(f.factory);
    const crawl: StageJob<"crawl"> = {
      jobId: makeJobId("p1", "crawl", 1, 1),
      projectId: "p1",
      rev: 1,
      stage: "crawl",
      attempt: 1,
      params: { url: "https://x.ua", manualText: null },
    };
    const render: StageJob<"render"> = {
      jobId: makeJobId("p1", "render", 1, 1, "vertical"),
      projectId: "p1",
      rev: 1,
      stage: "render",
      attempt: 1,
      params: { format: "vertical" },
    };
    await q.enqueueStage(crawl);
    await q.enqueueStage(render);
    await q.enqueueStage({ ...crawl, jobId: "p1.crawl.r1.a2", attempt: 2 });
    expect(f.added.map((a) => [a.queue, a.name, a.opts?.jobId])).toEqual([
      ["crawl", "crawl", "p1.crawl.r1.a1"],
      ["render", "render", "p1.render.r1.a1.vertical"],
      ["crawl", "crawl", "p1.crawl.r1.a2"],
    ]);
    await q.close();
    expect(f.closed.sort()).toEqual(["crawl", "render"]);
  });
});
