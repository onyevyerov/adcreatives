import {
  createAnthropicClient,
  createConsoleLogger,
  createEmitter,
  createPromptLoader,
  LocalStorage,
  loadPrices,
  loadRootEnv,
  type PipelineDriver,
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
  const connection = redisConnection(env.redisUrl);

  // Окреме (неблокувальне) з'єднання для подій чату в Redis Stream.
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (err) => logger.error("redis", { err: err.message }));

  const storage = new LocalStorage(env.dataDir);
  const prices = loadPrices();
  const prompts = createPromptLoader();
  const queue = createBullQueue({ connection });

  const registry = createStageRegistry({
    // TODO(integration): wire @adc/director —
    //   director: { storyboard: storyboardStage, codegen: codegenStage,
    //               check: createCheckStage({ engine: createRenderEngine() }),
    //               fix: fixStage, qa: qaStage, revise: reviseStage },
    //   prepareRenderJob,
  });

  // TODO(integration): wire @adc/pipeline —
  //   const driver = createPipelineDriver({ storage, queue, redis, prompts, prices, logger, ... });
  const driver: PipelineDriver | null = null;

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
