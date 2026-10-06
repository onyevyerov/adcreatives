import {
  type Logger,
  type PipelineDriver,
  type PipelineJob,
  QUEUE_CONCURRENCY,
  QUEUE_LOCK_MS,
  type QueueName,
  type StageJob,
} from "@adc/shared";
import { type ConnectionOptions, type Job, type Processor, Worker, type WorkerOptions } from "bullmq";
import {
  handlePipelineJob,
  reportStageEvent,
  runStageJob,
  StageFailureReported,
  type StageJobDeps,
  workerFailureEvent,
} from "./process.ts";
import { QUEUE_PREFIX } from "./queue.ts";

/** Мінімум BullMQ Worker, який нам потрібен (у тестах — фейк). */
export interface WorkerLike {
  on(event: "failed", listener: (job: Job | undefined, err: Error, prev: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "stalled", listener: (jobId: string, prev: string) => void): unknown;
  close(force?: boolean): Promise<void>;
  cancelAllJobs(reason?: string): void;
}

export type WorkerFactory = (name: QueueName, processor: Processor, opts: WorkerOptions) => WorkerLike;

/**
 * Опції BullMQ Worker черги. Стадії: `maxStalledCount: 0` — завислий job не перезапускається
 * мовчки, а стає `stage_failed`. Для `pipeline` дозволено один перезапуск: обробка команд
 * і подій оркестратором ідемпотентна, а втрата команди гірша за повтор.
 */
export function workerOptions(
  queue: QueueName,
  connection: ConnectionOptions,
  prefix = QUEUE_PREFIX,
): WorkerOptions {
  return {
    connection,
    prefix,
    concurrency: QUEUE_CONCURRENCY[queue],
    lockDuration: QUEUE_LOCK_MS[queue],
    maxStalledCount: queue === "pipeline" ? 1 : 0,
    autorun: true,
  };
}

export const defaultWorkerFactory: WorkerFactory = (name, processor, opts) =>
  new Worker(name, processor, opts);

export interface StartWorkersOptions {
  connection: ConnectionOptions;
  /** Черги, які обслуговує процес. */
  queues: readonly QueueName[];
  /** Ресурси стадій: реєстр, продюсер черг, сховище, ціни, LLM, emitter, логер. */
  stageDeps: StageJobDeps;
  /**
   * Оркестратор для черги `pipeline` (B7, `createPipelineDriver`). null — черга `pipeline`
   * у цьому процесі не обслуговується (job чекають у Redis).
   */
  driver: PipelineDriver | null;
  logger: Logger;
  factory?: WorkerFactory;
  prefix?: string;
}

export interface RunningWorkers {
  readonly workers: ReadonlyMap<QueueName, WorkerLike>;
  /** Зупинка: чекаємо активні job до `graceMs`, потім скасовуємо їх (AbortSignal) і закриваємо. */
  close(graceMs?: number): Promise<void>;
}

/** Процесор черги стадій (виноситься окремо для тестів). */
export function stageProcessor(queue: QueueName, deps: StageJobDeps): Processor<StageJob> {
  // Три параметри: BullMQ передає AbortSignal лише процесорам із `length >= 3`.
  return async (job: Job<StageJob>, _token?: string, signal?: AbortSignal) => {
    const event = await runStageJob(queue, job.data, deps, signal);
    if (event.type === "stage_failed") throw new StageFailureReported(event.error.message);
    return event;
  };
}

/** Listener `failed` черги стадій: завислий або збитий job → `stage_failed` (якщо ще не повідомлено). */
export function stageFailedListener(queue: QueueName, deps: StageJobDeps, logger: Logger) {
  return async (job: Job<StageJob> | undefined, err: Error): Promise<void> => {
    if (err instanceof StageFailureReported || err?.name === "StageFailureReported") return;
    if (!job?.data) {
      logger.error("job впав без даних (видалено?)", { queue, err: err?.message });
      return;
    }
    const event = workerFailureEvent(job.data, err, job.processedOn ?? undefined);
    logger.error("job стадії впав поза процесором", {
      queue,
      jobId: job.data.jobId,
      code: event.type === "stage_failed" ? event.error.code : null,
      err: err.message,
    });
    try {
      await reportStageEvent(deps.queue, event);
    } catch (e) {
      logger.error("не вдалося поставити stage_failed", { queue, jobId: job.data.jobId, err: String(e) });
    }
  };
}

export function pipelineProcessor(driver: PipelineDriver): Processor<PipelineJob> {
  return async (job: Job<PipelineJob>) => {
    await handlePipelineJob(job.data, driver);
  };
}

export function startWorkers(options: StartWorkersOptions): RunningWorkers {
  const factory = options.factory ?? defaultWorkerFactory;
  const { logger } = options;
  const workers = new Map<QueueName, WorkerLike>();

  for (const queue of options.queues) {
    const opts = workerOptions(queue, options.connection, options.prefix);
    const log = logger.child({ queue });
    if (queue === "pipeline") {
      if (!options.driver) {
        log.warn("оркестратор не підключено — черга pipeline не обслуговується");
        continue;
      }
      const worker = factory(queue, pipelineProcessor(options.driver), opts);
      worker.on("failed", (job, err) => {
        log.error("job pipeline впав", { jobId: job?.id, attempts: job?.attemptsMade, err: err.message });
      });
      worker.on("error", (err) => log.error("помилка воркера", { err: err.message }));
      workers.set(queue, worker);
      continue;
    }
    const worker = factory(queue, stageProcessor(queue, options.stageDeps), opts);
    const onFailed = stageFailedListener(queue, options.stageDeps, log);
    worker.on("failed", (job, err) => {
      void onFailed(job as Job<StageJob> | undefined, err);
    });
    worker.on("stalled", (jobId) => log.warn("job завис", { jobId }));
    worker.on("error", (err) => log.error("помилка воркера", { err: err.message }));
    workers.set(queue, worker);
  }
  logger.info("воркери запущено", { queues: [...workers.keys()] });

  return {
    workers,
    async close(graceMs = 30_000) {
      const closing = [...workers.entries()].map(async ([queue, worker]) => {
        let timer: NodeJS.Timeout | undefined;
        const graceful = worker.close();
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), graceMs);
        });
        const res = await Promise.race([graceful.then(() => "closed" as const), timeout]);
        if (timer) clearTimeout(timer);
        if (res === "timeout") {
          logger.warn("активні job не завершились — скасовую", { queue });
          worker.cancelAllJobs("shutdown");
          await graceful.catch(() => {});
        }
      });
      await Promise.allSettled(closing);
    },
  };
}
