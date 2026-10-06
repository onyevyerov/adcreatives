import { EventEmitter } from "node:events";
import { type PipelineDriver, QUEUE_NAMES, type QueueName, type StageJob } from "@adc/shared";
import type { Job, Processor, WorkerOptions } from "bullmq";
import { describe, expect, it } from "vitest";
import { StageFailureReported } from "../src/process.ts";
import { QUEUE_PREFIX } from "../src/queue.ts";
import { startWorkers, type WorkerFactory, type WorkerLike, workerOptions } from "../src/workers.ts";
import { makeDeps, stageJob, tempStorage, writeProject } from "./helpers.ts";

class FakeWorker extends EventEmitter implements WorkerLike {
  closed = false;
  cancelled: string[] = [];
  private release: (() => void) | null = null;
  constructor(
    readonly name: QueueName,
    readonly processor: Processor,
    readonly opts: WorkerOptions,
    private readonly hang = false,
  ) {
    super();
  }
  close(): Promise<void> {
    this.closed = true;
    if (!this.hang) return Promise.resolve();
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
  cancelAllJobs(reason?: string): void {
    this.cancelled.push(reason ?? "");
    this.release?.();
  }
}

function fakeFactory(hang = false) {
  const created = new Map<QueueName, FakeWorker>();
  const factory: WorkerFactory = (name, processor, opts) => {
    const w = new FakeWorker(name, processor, opts, hang);
    created.set(name, w);
    return w;
  };
  return { factory, created };
}

const flush = () => new Promise((r) => setImmediate(r));
const fakeJob = (data: StageJob, processedOn?: number) =>
  ({ id: data.jobId, data, processedOn }) as unknown as Job;

const driver: PipelineDriver = { handleCommand: async () => {}, onStageDone: async () => {} };
const connection = { url: "redis://localhost:6379/9", maxRetriesPerRequest: null };

describe("workerOptions", () => {
  it("concurrency and lockDuration from the frozen maps; maxStalledCount 0 for stage queues", () => {
    const expected = {
      pipeline: [8, 60_000, 1],
      crawl: [2, 300_000, 0],
      llm: [6, 300_000, 0],
      cpu: [1, 600_000, 0],
      audio: [2, 300_000, 0],
      render: [1, 600_000, 0],
    } as const;
    for (const q of QUEUE_NAMES) {
      const o = workerOptions(q, connection);
      expect([o.concurrency, o.lockDuration, o.maxStalledCount]).toEqual(expected[q]);
      expect(o.prefix).toBe(QUEUE_PREFIX);
      expect(o.connection).toBe(connection);
    }
  });
});

describe("startWorkers", () => {
  it("one BullMQ worker per queue; pipeline skipped without a driver", async () => {
    const deps = makeDeps(await tempStorage());
    const a = fakeFactory();
    startWorkers({
      connection,
      queues: QUEUE_NAMES,
      stageDeps: deps,
      driver,
      logger: deps.logger,
      factory: a.factory,
    });
    expect([...a.created.keys()]).toEqual([...QUEUE_NAMES]);
    expect(a.created.get("render")?.opts).toMatchObject({
      concurrency: 1,
      lockDuration: 600_000,
      maxStalledCount: 0,
    });

    const b = fakeFactory();
    startWorkers({
      connection,
      queues: QUEUE_NAMES,
      stageDeps: deps,
      driver: null,
      logger: deps.logger,
      factory: b.factory,
    });
    expect(b.created.has("pipeline")).toBe(false);
    expect(b.created.size).toBe(QUEUE_NAMES.length - 1);
  });

  it("stage processor: runs the stage, reports stage_done; failed stage reports and throws StageFailureReported", async () => {
    const storage = await tempStorage();
    await writeProject(storage);
    const deps = makeDeps(storage, {
      brandkit: async () => ({ artifacts: ["projects/p1/brandkit/v1.json"], outputs: { version: 1 } }),
    });
    const { factory, created } = fakeFactory();
    startWorkers({
      connection,
      queues: ["llm"],
      stageDeps: deps,
      driver: null,
      logger: deps.logger,
      factory,
    });
    const llm = created.get("llm") as FakeWorker;
    expect(llm.processor.length).toBeGreaterThanOrEqual(3); // BullMQ передає AbortSignal лише таким

    const ok = await llm.processor(fakeJob(stageJob("brandkit", {})));
    expect(ok).toMatchObject({ type: "stage_done", stage: "brandkit", outputs: { version: 1 } });

    const failing = llm.processor(fakeJob(stageJob("storyboard", { durationSeconds: null })));
    await expect(failing).rejects.toBeInstanceOf(StageFailureReported);
    expect(deps.queue.pipeline.map((j) => (j.kind === "stage_event" ? j.event.type : null))).toEqual([
      "stage_done",
      "stage_failed",
    ]);

    // BullMQ потім емітить failed з нашою помилкою — повторної події немає
    llm.emit(
      "failed",
      fakeJob(stageJob("storyboard", { durationSeconds: null })),
      new StageFailureReported("x"),
      "active",
    );
    await flush();
    expect(deps.queue.pipeline).toHaveLength(2);
  });

  it("stalled job (failed event from BullMQ) → stage_failed in the pipeline queue, once", async () => {
    const deps = makeDeps(await tempStorage());
    const { factory, created } = fakeFactory();
    startWorkers({
      connection,
      queues: ["render"],
      stageDeps: deps,
      driver: null,
      logger: deps.logger,
      factory,
    });
    const render = created.get("render") as FakeWorker;
    const data = stageJob("render", { format: "vertical" }, { suffix: "vertical" });
    const err = new Error("job stalled more than allowable limit");
    render.emit("failed", fakeJob(data, Date.now() - 5000), err, "active");
    render.emit("failed", fakeJob(data, Date.now() - 5000), err, "active");
    await flush();

    expect(deps.queue.pipeline).toHaveLength(1);
    const job = deps.queue.pipeline[0];
    expect(job?.kind).toBe("stage_event");
    if (job?.kind !== "stage_event") return;
    expect(job.event).toMatchObject({
      type: "stage_failed",
      stage: "render",
      format: "vertical",
      jobId: "p1.render.r1.a1.vertical",
      error: { code: "stalled", retryable: true },
    });
    expect(job.event.durationMs).toBeGreaterThanOrEqual(5000);

    // job без даних (видалено removeOnFail) — лише лог, без падіння
    render.emit("failed", undefined, err, "active");
    await flush();
    expect(deps.queue.pipeline).toHaveLength(1);
  });

  it("pipeline processor dispatches to the injected driver", async () => {
    const deps = makeDeps(await tempStorage());
    const seen: string[] = [];
    const d: PipelineDriver = {
      handleCommand: async (c) => {
        seen.push(c.type);
      },
      onStageDone: async (e) => {
        seen.push(e.stage);
      },
    };
    const { factory, created } = fakeFactory();
    startWorkers({
      connection,
      queues: ["pipeline"],
      stageDeps: deps,
      driver: d,
      logger: deps.logger,
      factory,
    });
    const p = created.get("pipeline") as FakeWorker;
    await p.processor({
      data: { kind: "command", command: { projectId: "p1", commandId: "c", issuedAt: "x", type: "retry" } },
    } as unknown as Job);
    expect(seen).toEqual(["retry"]);
  });

  it("close(): graceful close, cancels active jobs after the grace period", async () => {
    const deps = makeDeps(await tempStorage());
    const quick = fakeFactory();
    const r1 = startWorkers({
      connection,
      queues: ["crawl"],
      stageDeps: deps,
      driver: null,
      logger: deps.logger,
      factory: quick.factory,
    });
    await r1.close(1000);
    expect(quick.created.get("crawl")?.closed).toBe(true);
    expect(quick.created.get("crawl")?.cancelled).toEqual([]);

    const slow = fakeFactory(true);
    const r2 = startWorkers({
      connection,
      queues: ["render"],
      stageDeps: deps,
      driver: null,
      logger: deps.logger,
      factory: slow.factory,
    });
    await r2.close(20);
    expect(slow.created.get("render")?.cancelled).toEqual(["shutdown"]);
  });
});
