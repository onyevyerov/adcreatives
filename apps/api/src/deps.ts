import type { Logger, Queue, Storage } from "@adc/shared";
import type { Redis } from "ioredis";
import type { ApiConfig } from "./config.ts";

/** Залежності застосунку (у тестах — LocalStorage у тимчасовій теці, MemoryQueue, ioredis-mock). */
export interface ApiDeps {
  storage: Storage;
  queue: Queue;
  /** З'єднання для XADD/XRANGE; для XREAD BLOCK кожне SSE-підключення робить `redis.duplicate()`. */
  redis: Redis;
  config: ApiConfig;
  logger?: Logger;
}

/** Помилка у відповіді API: машинний код + текст українською для чату. */
export interface ApiError {
  error: string;
  message: string;
}
