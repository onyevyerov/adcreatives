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
  type Storage,
  storageFromEnv,
} from "@adc/shared";
import { createElevenLabsClient, type ElevenLabsLike } from "./client.ts";
import { defaultGate, type ElevenLabsGate } from "./gate.ts";
import {
  ensureStandardSfx,
  loadSfxLibrary,
  type SfxDeps,
  type SfxFile,
  sfxHash,
  variantLabel,
} from "./sfx.ts";
import { defaultSfxQc, type SfxQcHook } from "./sfxQc.ts";

export interface WarmSfxCacheOptions {
  storage: Storage;
  prompts: PromptLoader;
  client: () => ElevenLabsLike;
  gate: ElevenLabsGate;
  /** Спільний журнал витрат (`costs-shared.jsonl`). */
  cost: CostRecorder;
  logger?: Logger;
  /** QC щойно згенерованих семплів; дефолт — `defaultSfxQc`. */
  qc?: SfxQcHook;
}

/**
 * Генерує відсутні SFX бібліотеки (усі `SoundCue` × усі варіанти; legacy-cue — це їхні варіанти 1)
 * у `DATA_DIR/cache/sfx/<hash>.mp3`; наявні пропускає. Однаковий запит генерується один раз.
 */
export async function warmSfxCache(opts: WarmSfxCacheOptions): Promise<SfxFile[]> {
  const library = loadSfxLibrary(opts.prompts);
  const deps: SfxDeps = {
    storage: opts.storage,
    client: opts.client,
    gate: opts.gate,
    qc: opts.qc ?? defaultSfxQc,
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
  const jobs = new Map<string, Promise<SfxFile>>();
  for (const [cue, variants] of Object.entries(library)) {
    variants.forEach((def, i) => {
      const hash = sfxHash(def);
      if (!jobs.has(hash)) jobs.set(hash, ensureStandardSfx(deps, opts.cost, variantLabel(cue, i + 1), def));
    });
  }
  return Promise.all(jobs.values());
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
      `${f.generated ? "згенеровано" : "вже в кеші "}  ${f.cue.padEnd(10)} → ${storage.absPath(f.key)}`,
    );
  }
  return 0;
}
