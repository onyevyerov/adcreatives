import { dataDir, QUEUE_NAMES, type QueueName } from "@adc/shared";

export interface WorkerEnv {
  redisUrl: string;
  /** Абсолютний шлях DATA_DIR. */
  dataDir: string;
  /** Які черги обслуговує процес (env WORKER_QUEUES="crawl,llm"; дефолт — усі). */
  queues: QueueName[];
  /** Скільки чекати активні job при зупинці, перш ніж їх скасувати (WORKER_SHUTDOWN_GRACE_MS). */
  shutdownGraceMs: number;
  logLevel: "debug" | "info";
}

export function parseQueueList(raw: string | undefined): QueueName[] {
  if (!raw?.trim()) return [...QUEUE_NAMES];
  const out: QueueName[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!(QUEUE_NAMES as readonly string[]).includes(name)) {
      throw new Error(`WORKER_QUEUES: невідома черга "${name}" (є: ${QUEUE_NAMES.join(", ")})`);
    }
    if (!out.includes(name as QueueName)) out.push(name as QueueName);
  }
  return out;
}

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const grace = Number(env.WORKER_SHUTDOWN_GRACE_MS);
  return {
    redisUrl: env.REDIS_URL || "redis://localhost:6379/0",
    dataDir: dataDir(env),
    queues: parseQueueList(env.WORKER_QUEUES),
    shutdownGraceMs: Number.isFinite(grace) && grace >= 0 ? grace : 30_000,
    logLevel: env.LOG_LEVEL === "debug" ? "debug" : "info",
  };
}
