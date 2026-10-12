import { dataDir, QUEUE_NAMES, type QueueName } from "@adc/shared";

/**
 * Оточення процесу воркера. Перемикачі генерації (`ADC_*`) читає `readTuning()` з `@adc/shared` на
 * старті (`main.ts`: невалідне значення — падіння на старті) і стадії — на кожен запуск:
 * - `ADC_GENERATION_MODE` — `pipeline` (дефолт: codegen → check ↔ fix → qa) або `agent` (стадія `author`:
 *   один агент пише сцени, рендерить стрипи, дивиться їх і править сам; далі check → fix і одне коло QA
 *   як страховка). Оркестратор читає режим на кожен крок, тож він діє з наступного старту режисури.
 * - `ADC_AUTHOR_TOKEN_BUDGET` (дефолт 3 000 000, мін. 500 000) — сумарні токени стадії `author`
 *   (input + output + запис і читання кешу); `ADC_AUTHOR_MAX_ITERATIONS` (5–80, дефолт 40) — відповіді
 *   моделі з викликами інструментів; `ADC_AUTHOR_MAX_MINUTES` (5–60, дефолт 25) — час стадії. Після
 *   будь-якого ліміту сцени без робочого коду лагодить звичайний fix.
 * Стадія `author` іде в чергу `llm` (як codegen), але рендерить кадри Chromium-ом у тому самому процесі:
 * воркер черги `llm` в agent-режимі має мати браузер Remotion (`pnpm --filter @adc/render browser`).
 */
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
