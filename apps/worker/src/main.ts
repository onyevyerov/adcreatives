import { createChatLlmFactory, createPipelineDriver, createRedisLock } from "@adc/pipeline";
import {
  createAccountStore,
  createAnthropicClient,
  createConsoleLogger,
  createEmitter,
  createPromptLoader,
  LocalStorage,
  loadCredits,
  loadPrices,
  loadRootEnv,
  type PipelineDriver,
  readTuning,
} from "@adc/shared";
import { Redis } from "ioredis";
import { loadWorkerEnv } from "./env.ts";
import { createBullQueue, redisConnection } from "./queue.ts";
import { createStageRegistry } from "./stages.ts";
import { startWorkers } from "./workers.ts";

/** Точка входу воркера: `pnpm --filter @adc/worker start` (або `dev` з перезапуском). */
async function main(): Promise<void> {
  loadRootEnv();
  const env = loadWorkerEnv();
  const logger = createConsoleLogger({ service: "worker" }, env.logLevel);
  // Невалідний перемикач генерації (ADC_CODEGEN_* тощо) — падіння на старті, а не тихий дефолт.
  logger.info("перемикачі генерації", { ...readTuning() });
  const connection = redisConnection(env.redisUrl);

  // Окреме (неблокувальне) з'єднання для подій чату в Redis Stream.
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (err) => logger.error("redis", { err: err.message }));

  const storage = new LocalStorage(env.dataDir);
  const prices = loadPrices();
  const prompts = createPromptLoader();
  const queue = createBullQueue({ connection });
  // Кредити власників: той самий леджер, що в API (lock:user:<id> у Redis), ціни — config/credits.json.
  const credits = loadCredits();

  const registry = createStageRegistry();

  // Оркестратор (B7). Клієнт Anthropic створюється ліниво: без ключа воркер стартує,
  // а chat-intent/chat-reply впадуть лише при реальному виклику.
  let chatLlm: ReturnType<typeof createChatLlmFactory> | null = null;
  const driver: PipelineDriver = createPipelineDriver({
    storage,
    queue,
    lock: createRedisLock(redis),
    billing: {
      store: createAccountStore({ storage, lock: createRedisLock(redis) }),
      prices: credits.prices,
    },
    emitter: (projectId) => createEmitter(redis, projectId),
    llm: (ctx) => {
      chatLlm ??= createChatLlmFactory({ client: createAnthropicClient(), prompts, storage, prices, logger });
      return chatLlm(ctx);
    },
    logger,
  });

  const running = startWorkers({
    connection,
    queues: env.queues,
    driver,
    logger,
    stageDeps: {
      registry,
      queue,
      storage,
      prices,
      prompts,
      anthropic: () => createAnthropicClient(),
      emitterFor: (projectId) => createEmitter(redis, projectId),
      logger,
    },
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      logger.warn("повторний сигнал — примусовий вихід", { signal });
      process.exit(1);
    }
    stopping = true;
    logger.info("зупинка воркера", { signal, graceMs: env.shutdownGraceMs });
    try {
      await running.close(env.shutdownGraceMs);
      await queue.close();
      await redis.quit().catch(() => redis.disconnect());
      logger.info("воркер зупинено");
      process.exit(0);
    } catch (err) {
      logger.error("помилка під час зупинки", { err: String(err) });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
