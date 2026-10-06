import {
  type EnqueueOptions,
  type PipelineJob,
  type Queue,
  type QueueName,
  STAGE_QUEUE,
  type StageJob,
} from "@adc/shared";
import { Queue as BullMqQueue, type ConnectionOptions, type JobsOptions } from "bullmq";

/**
 * BullMQ-продюсер, що реалізує спільний інтерфейс `Queue`. API ставить ним команди в чергу
 * `pipeline`; `enqueueStage` реалізовано для повноти контракту (стадії ставить оркестратор).
 *
 * Домовленість із воркером (B8):
 * - імена черг — `QUEUE_NAMES` (`pipeline`, `crawl`, `llm`, `cpu`, `audio`, `render`), prefix BullMQ
 *   за замовчуванням (`bull`), якщо не передано інший;
 * - job стадії: name = назва стадії, data = `StageJob`, jobId = `StageJob.jobId`, черга = `STAGE_QUEUE[stage]`;
 * - job черги `pipeline`: name = `PipelineJob.kind` (`command` | `stage_event`), data = `PipelineJob`,
 *   jobId = `opts.jobId` (для команд — `makeCommandJobId`);
 * - attempts = 1: повтори вирішує оркестратор, а не BullMQ.
 */

/** Мінімум від BullMQ Queue, потрібний продюсеру (у тестах — фейк). */
export interface QueueProducer {
  add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export type ProducerFactory = (name: QueueName) => QueueProducer;

/** Завершені job тримаємо тиждень: однаковий jobId за цей час не поставиться вдруге. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export class BullQueue implements Queue {
  private readonly producers = new Map<QueueName, QueueProducer>();

  constructor(private readonly factory: ProducerFactory) {}

  /** Продюсер на справжньому Redis (з'єднання — ioredis-інстанс або опції). */
  static connect(connection: ConnectionOptions, opts: { prefix?: string } = {}): BullQueue {
    return new BullQueue(
      (name) => new BullMqQueue(name, { connection, ...(opts.prefix ? { prefix: opts.prefix } : {}) }),
    );
  }

  private producer(name: QueueName): QueueProducer {
    let p = this.producers.get(name);
    if (!p) {
      p = this.factory(name);
      this.producers.set(name, p);
    }
    return p;
  }

  async enqueueStage(job: StageJob): Promise<void> {
    await this.producer(STAGE_QUEUE[job.stage]).add(job.stage, job, {
      ...DEFAULT_JOB_OPTIONS,
      jobId: job.jobId,
    });
  }

  async enqueuePipeline(job: PipelineJob, opts: EnqueueOptions = {}): Promise<void> {
    await this.producer("pipeline").add(job.kind, job, {
      ...DEFAULT_JOB_OPTIONS,
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    });
  }

  async close(): Promise<void> {
    const all = [...this.producers.values()];
    this.producers.clear();
    await Promise.all(all.map((p) => p.close()));
  }
}
