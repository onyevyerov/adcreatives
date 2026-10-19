import type {
  AccountStore,
  Logger,
  Mailer,
  PaymentProvider,
  Queue,
  SessionStore,
  Storage,
  TokenStore,
} from "@adc/shared";
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
  /** Користувачі, леджер кредитів, поповнення (файли в DATA_DIR). */
  accounts: AccountStore;
  /** Сесії `adc_session` (Redis). */
  sessions: SessionStore;
  /** Одноразові токени активації/скидання пароля (Redis). */
  tokens: TokenStore;
  /** Листи — у макеті outbox у DATA_DIR + лог. */
  mailer: Mailer;
  /** Оплата поповнень — у макеті заглушка з фейковим checkout. */
  payments: PaymentProvider;
}

/** Помилка у відповіді API: машинний код + текст українською для чату. */
export interface ApiError {
  error: string;
  message: string;
}
