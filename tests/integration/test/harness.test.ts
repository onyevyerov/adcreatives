import type { PipelineJob, StageJob } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { InProcessQueue, MemoryEvents } from "../src/harness.ts";

const stageJob = (stage: StageJob["stage"], jobId: string): StageJob =>
  ({ jobId, projectId: "p1", rev: 1, stage, attempt: 1, params: {} }) as StageJob;

const command = (commandId: string): PipelineJob => ({
  kind: "command",
  command: { type: "retry", projectId: "p1", commandId, issuedAt: "2026-10-06T00:00:00.000Z" },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("InProcessQueue", () => {
  it("стадія, поставлена кроком оркестратора, стартує лише після цього кроку", async () => {
    const log: string[] = [];
    const step = deferred();
    const queue: InProcessQueue = new InProcessQueue({
      runPipeline: async () => {
        log.push("step:start");
        await queue.enqueueStage(stageJob("storyboard", "j1"));
        await step.promise;
        log.push("step:end");
      },
      runStage: async (_q, job) => {
        log.push(`stage:${job.jobId}`);
      },
    });
    await queue.enqueuePipeline(command("c1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["step:start"]);
    step.resolve();
    await queue.idle();
    expect(log).toEqual(["step:start", "step:end", "stage:j1"]);
  });

  it("ідемпотентність за jobId і ліміт паралельності черги", async () => {
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const queue = new InProcessQueue({
      concurrency: { cpu: 1 },
      runPipeline: async () => {},
      runStage: async (_q, job) => {
        started.push(job.jobId);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running--;
      },
    });
    await queue.enqueueStage(stageJob("check", "a"));
    await queue.enqueueStage(stageJob("check", "a"));
    await queue.enqueueStage(stageJob("check", "b"));
    await queue.enqueuePipeline(command("x"), { jobId: "cmd-x" });
    await queue.enqueuePipeline(command("x"), { jobId: "cmd-x" });
    await queue.idle();
    expect(started).toEqual(["a", "b"]);
    expect(peak).toBe(1);
    expect(queue.history.map((j) => j.jobId)).toEqual(["a", "b"]);
  });

  it("фільтр відкидає job, помилки збираються, idle все одно настає", async () => {
    const queue = new InProcessQueue({
      filter: (job) => job.stage !== "render",
      runPipeline: async () => {
        throw new Error("boom");
      },
      runStage: async () => {},
    });
    await queue.enqueueStage(stageJob("render", "r1"));
    await queue.enqueuePipeline(command("c"));
    await queue.idle();
    expect(queue.skipped.map((j) => j.jobId)).toEqual(["r1"]);
    expect(queue.errors).toEqual([{ where: "pipeline", jobId: "cmd.retry.c", error: "Error: boom" }]);
    expect(queue.isIdle()).toBe(true);
  });
});

describe("MemoryEvents", () => {
  it("валідує події, зберігає по проєктах і сповіщає слухачів", async () => {
    const events = new MemoryEvents(() => new Date("2026-10-06T00:00:00Z"));
    const seen: string[] = [];
    const off = events.on((pid, ev) => seen.push(`${pid}:${ev.type}`));
    await events.emitter("p1").message("привіт");
    await events.emitter("p2").progress("crawl", "Сканую сайт…", 1, 25);
    off();
    await events.emitter("p1").message("ще");
    expect(seen).toEqual(["p1:message", "p2:progress"]);
    expect(events.list("p1").map((e) => e.type)).toEqual(["message", "message"]);
    expect(() => events.append("p1", { type: "state" } as never)).toThrow();
  });
});
