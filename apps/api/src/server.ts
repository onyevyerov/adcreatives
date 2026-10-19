import {
  createAccountStore,
  createConsoleLogger,
  createOutboxMailer,
  createRedisLock,
  createSessionStore,
  createStubPayment,
  createTokenStore,
  loadRootEnv,
  storageFromEnv,
} from "@adc/shared";
import { createBullQueue } from "@adc/shared/bullmq";
import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";

/**
 * Точка входу: `pnpm --filter @adc/api start`
 * (PORT, APP_PASSWORD, REDIS_URL, DATA_DIR, COST_TARGET_USD, ADMIN_EMAILS, APP_URL).
 */
loadRootEnv();
const logger = createConsoleLogger({ service: "api" });
const config = configFromEnv();
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/0";
// API — продюсер: якщо Redis недоступний, запит має швидко впасти з 500, а не висіти.
const connect = (name: string) => {
  const r = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  r.on("error", (err) => logger.warn("Redis недоступний", { connection: name, error: err.message }));
  return r;
};
const redis = connect("events");
// Окреме з'єднання для BullMQ, щоб його службові команди не змішувались із SSE/стрімами.
const queue = createBullQueue({ connection: connect("bullmq") });
const storage = storageFromEnv();
const port = Number(process.env.PORT) || 3000;

if (!config.appPassword) logger.warn("APP_PASSWORD порожній — staging-gate вимкнено, доступ лише за сесіями");

const app = createApp({
  storage,
  queue,
  redis,
  config,
  logger,
  accounts: createAccountStore({ storage, lock: createRedisLock(redis) }),
  sessions: createSessionStore(redis),
  tokens: createTokenStore(redis),
  mailer: createOutboxMailer({ storage, logger }),
  payments: createStubPayment(config.appUrl),
});
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info("API запущено", { port: info.port, dataDir: storage.root });
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info("зупинка", { signal });
  server.close();
  await queue.close().catch(() => {});
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
