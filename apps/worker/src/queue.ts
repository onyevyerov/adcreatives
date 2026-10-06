import {
  type EnqueueOptions,
  type PipelineJob,
  type Queue,
  type QueueName,
  STAGE_QUEUE,
  type StageJob,
} from "@adc/shared";
import { Queue as BullMQQueue, type ConnectionOptions, type JobsOptions } from "bullmq";

/**
 * BullMQ-реалізація спільного інтерфейсу `Queue` (продюсер). Нею користуються API (команди
 * в `pipeline`), оркестратор (job стадій) і сам воркер (події `stage_done`/`stage_failed`).
 * Імпорт: `import { createBullQueue } from "@adc/worker/queue"`.
 */

/** Префікс ключів BullMQ у Redis — однаковий для продюсерів і воркерів. */
export const QUEUE_PREFIX = "adc";

/** Скільки тримати завершені job (для ідемпотентності за jobId і для діагностики). */
const KEEP_COMPLETED = { age: 7 * 24 * 3600, count: 5000 };
const KEEP_FAILED = { age: 30 * 24 * 3600, count: 5000 };

/** Опції job стадії: без повторів — рішення про повтор приймає оркестратор. */
export const STAGE_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
};

/** Опції job черги `pipeline`: кілька повторів (напр. lock проєкту зайнятий). */
export const PIPELINE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
};

/** ID job події стадії в черзі `pipeline`: одна подія на job стадії (done або failed — що перше). */
export function stageEventJobId(stageJobId: string): string {
  return `${stageJobId}.evt`;
}

/** Мінімум BullMQ Queue, який нам потрібен (у тестах — фейк). */
export interface BullQueueLike {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export type BullQueueFactory = (name: QueueName) => BullQueueLike;

export interface CreateBullQueueOptions {
  /** Підключення до Redis: `{ url }` або інстанс ioredis. */
  connection?: ConnectionOptions;
  /** Підміна фабрики черг (тести). */
  factory?: BullQueueFactory;
  prefix?: string;
}

/** Підключення BullMQ за URL (воркерам потрібен maxRetriesPerRequest: null). */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

export class BullQueue implements Queue {
  private readonly queues = new Map<QueueName, BullQueueLike>();

  constructor(private readonly factory: BullQueueFactory) {}

  private get(name: QueueName): BullQueueLike {
    let q = this.queues.get(name);
    if (!q) {
      q = this.factory(name);
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueueStage(job: StageJob): Promise<void> {
    const queue = STAGE_QUEUE[job.stage];
    if (!queue) throw new Error(`невідома стадія: ${String(job.stage)}`);
    await this.get(queue).add(job.stage, job, { ...STAGE_JOB_OPTIONS, jobId: job.jobId });
  }

  async enqueuePipeline(job: PipelineJob, opts: EnqueueOptions = {}): Promise<void> {
    const name = job.kind === "command" ? `cmd.${job.command.type}` : job.event.type;
    await this.get("pipeline").add(name, job, {
      ...PIPELINE_JOB_OPTIONS,
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    });
  }

  async close(): Promise<void> {
    const all = [...this.queues.values()];
    this.queues.clear();
    await Promise.allSettled(all.map((q) => q.close()));
  }
}

export function createBullQueue(options: CreateBullQueueOptions = {}): BullQueue {
  const prefix = options.prefix ?? QUEUE_PREFIX;
  const factory =
    options.factory ??
    ((name: QueueName) => {
      if (!options.connection) throw new Error("createBullQueue: потрібен connection або factory");
      return new BullMQQueue(name, { connection: options.connection, prefix });
    });
  return new BullQueue(factory);
}
