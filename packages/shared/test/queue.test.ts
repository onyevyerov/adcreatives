import { describe, expect, it } from "vitest";
import { I18N_KEYS, t, uk } from "../src/i18n/uk.ts";
import { MemoryQueue, makeJobId, QUEUE_CONCURRENCY, STAGE_QUEUE } from "../src/queue.ts";
import { STAGE_NAMES } from "../src/schemas/project.ts";

describe("queue contracts", () => {
  it("every stage is routed to a queue with spec concurrency", () => {
    expect(Object.keys(STAGE_QUEUE).sort()).toEqual([...STAGE_NAMES].sort());
    expect(STAGE_QUEUE.check).toBe("cpu");
    expect(STAGE_QUEUE.ingest).toBe("crawl");
    expect(STAGE_QUEUE.render).toBe("render");
    expect(QUEUE_CONCURRENCY).toEqual({ pipeline: 8, crawl: 2, llm: 6, cpu: 1, audio: 2, render: 1 });
  });

  it("jobId is deterministic and BullMQ-safe", () => {
    const id = makeJobId("V1StGXR8_Z5jdHi6B-myT", "codegen", 2, 1);
    expect(id).toBe("V1StGXR8_Z5jdHi6B-myT.codegen.r2.a1");
    expect(id).not.toContain(":");
    expect(makeJobId("p", "render", 1, 1, "square")).toBe("p.render.r1.a1.square");
  });

  it("MemoryQueue dedups by jobId (double clicks)", async () => {
    const q = new MemoryQueue();
    const job = {
      jobId: makeJobId("p", "crawl", 1, 1),
      projectId: "p",
      rev: 1,
      stage: "crawl" as const,
      attempt: 1,
      params: { url: "https://x.ua", manualText: null },
    };
    await q.enqueueStage(job);
    await q.enqueueStage(job);
    expect(q.stages).toHaveLength(1);
  });
});

describe("i18n", () => {
  it("has a text for every key and substitutes vars", () => {
    for (const k of I18N_KEYS) expect(uk[k].length).toBeGreaterThan(0);
    expect(t("crawlProgress", { done: 7, total: 25 })).toBe("Сканую сайт… 7/25 сторінок");
    expect(t("costLine", { usd: "1.23" })).toBe("Витрачено: 1.23 $");
  });
});
