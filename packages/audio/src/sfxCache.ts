import {
  type CostRecorder,
  createConsoleLogger,
  createCostRecorder,
  createPromptLoader,
  isLive,
  type Logger,
  loadPrices,
  loadRootEnv,
  type PromptLoader,
  RunSource,
  STANDARD_SFX_CUES,
  type Storage,
  storageFromEnv,
} from "@adc/shared";
import { createElevenLabsClient, type ElevenLabsLike } from "./client.ts";
import { defaultGate, type ElevenLabsGate } from "./gate.ts";
import { ensureStandardSfx, loadStandardCues, type SfxFile } from "./sfx.ts";

export interface WarmSfxCacheOptions {
  storage: Storage;
  prompts: PromptLoader;
  client: () => ElevenLabsLike;
  gate: ElevenLabsGate;
  /** Спільний журнал витрат (`costs-shared.jsonl`). */
  cost: CostRecorder;
  logger?: Logger;
}

/** Генерує відсутні стандартні SFX у `DATA_DIR/cache/sfx/<hash>.mp3` (наявні пропускає). */
export async function warmSfxCache(opts: WarmSfxCacheOptions): Promise<SfxFile[]> {
  const library = loadStandardCues(opts.prompts);
  const deps = {
    storage: opts.storage,
    client: opts.client,
    gate: opts.gate,
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
  return Promise.all(STANDARD_SFX_CUES.map((cue) => ensureStandardSfx(deps, opts.cost, cue, library[cue])));
}

/**
 * CLI `pnpm sfx-cache` (раз на деплой). Платні виклики — лише з LIVE=1.
 * Прапорець `--source=chat|eval|test` (дефолт chat) — джерело у спільному журналі витрат.
 */
export async function runSfxCacheCli(argv: readonly string[]): Promise<number> {
  loadRootEnv();
  if (!isLive()) {
    console.log("Генерація кешу SFX платна і вимкнена. Запуск: LIVE=1 pnpm sfx-cache");
    return 0;
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("Немає ELEVENLABS_API_KEY (кореневий .env або змінна середовища).");
    return 1;
  }
  const sourceArg = argv.find((a) => a.startsWith("--source="))?.slice("--source=".length) ?? "chat";
  const source = RunSource.safeParse(sourceArg);
  if (!source.success) {
    console.error(`Невідоме джерело: ${sourceArg} (chat|eval|test)`);
    return 1;
  }

  const storage = storageFromEnv();
  const logger = createConsoleLogger({ run: "sfx-cache" });
  const client = createElevenLabsClient();
  const files = await warmSfxCache({
    storage,
    prompts: createPromptLoader(),
    client: () => client,
    gate: defaultGate(logger),
    cost: createCostRecorder(storage, loadPrices(), {
      projectId: null,
      rev: null,
      stage: "sfx-cache",
      phase: "first_delivery",
      source: source.data,
      attempt: 1,
    }),
    logger,
  });
  for (const f of files) {
    console.log(
      `${f.generated ? "згенеровано" : "вже в кеші "}  ${f.cue.padEnd(8)} → ${storage.absPath(f.key)}`,
    );
  }
  return 0;
}
