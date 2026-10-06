/**
 * Живий прогін Кроку 0 (один раз, вручну):
 *   LIVE=1 pnpm --filter @adc/shared live
 *
 * Перевіряє: усі LLM-схеми приймаються API як structured output; стрім з effort xhigh
 * повертає валідну відповідь; витрати пишуться в журнал (DATA_DIR/costs-shared.jsonl, source=test).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { createCostRecorder, readCosts, sumUsd } from "../src/cost/ledger.ts";
import { loadPrices } from "../src/cost/prices.ts";
import { isLive, loadRootEnv } from "../src/env.ts";
import { createAnthropicClient, createLlm } from "../src/llm/client.ts";
import { createPromptLoader } from "../src/llm/prompts.ts";
import { createConsoleLogger } from "../src/logger.ts";
import {
  AudioPlan,
  BrandKit,
  BrandKitPatch,
  ChatIntent,
  QaReport,
  RevisionPlan,
  Storyboard,
} from "../src/schemas/index.ts";
import { storageFromEnv } from "../src/storage/local.ts";
import { createNoopTracer } from "../src/trace.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  loadRootEnv();
  if (!isLive()) {
    console.log("Живий прогін вимкнено. Запуск: LIVE=1 pnpm --filter @adc/shared live");
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Немає ANTHROPIC_API_KEY (кореневий .env або змінна середовища).");
    return 1;
  }

  const storage = storageFromEnv();
  const before = (await readCosts(storage, null)).length;
  const logger = createConsoleLogger({ run: "live-step0" });
  const llm = createLlm({
    client: createAnthropicClient(),
    prompts: createPromptLoader({ dir: path.join(here, "prompts"), reload: true }),
    cost: createCostRecorder(storage, loadPrices(), {
      projectId: null,
      rev: null,
      stage: "live",
      phase: "first_delivery",
      source: "test",
      attempt: 1,
    }),
    trace: createNoopTracer(),
    logger,
  });

  const schemas: Record<string, z.ZodType> = {
    BrandKit,
    BrandKitPatch,
    Storyboard,
    AudioPlan,
    QaReport,
    RevisionPlan,
    ChatIntent,
  };

  let failed = 0;
  for (const [name, schema] of Object.entries(schemas)) {
    const started = Date.now();
    try {
      const res = await llm.structured("schema-check", { schemaName: name }, schema);
      console.log(`✓ ${name}: прийнято і валідно (${Date.now() - started} мс, $${res.usd.toFixed(4)})`);
    } catch (err) {
      failed++;
      console.error(`✗ ${name}: ${(err as Error).message}`);
    }
  }

  try {
    const started = Date.now();
    let chars = 0;
    const res = await llm.structured(
      "stream-check",
      { text: "Все добре, але в другій сцені напишіть знижку 15%, і зробіть ролик на 20 секунд." },
      ChatIntent,
      { onText: (d) => (chars += d.length) },
    );
    console.log(
      `✓ стрім xhigh: kind=${res.data.kind}, ${chars} символів у дельтах (${Date.now() - started} мс, $${res.usd.toFixed(4)})`,
    );
  } catch (err) {
    failed++;
    console.error(`✗ стрім xhigh: ${(err as Error).message}`);
  }

  const all = await readCosts(storage, null);
  const fresh = all.slice(before);
  console.log(
    `Записів витрат: ${fresh.length}, разом $${sumUsd(fresh).toFixed(4)} → ${storage.absPath("costs-shared.jsonl")}`,
  );
  if (fresh.length === 0) {
    console.error("✗ витрати не записались");
    failed++;
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
