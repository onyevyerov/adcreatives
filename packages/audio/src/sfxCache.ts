import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type CostRecorder,
  createConsoleLogger,
  createCostRecorder,
  createPromptLoader,
  isLive,
  type Logger,
  loadPrices,
  loadRootEnv,
  noopLogger,
  type PromptLoader,
  RunSource,
  type Storage,
  sharedPaths,
  storageFromEnv,
} from "@adc/shared";
import { createElevenLabsClient, type ElevenLabsLike } from "./client.ts";
import { SFX_MODEL_ID } from "./constants.ts";
import { defaultGate, type ElevenLabsGate } from "./gate.ts";
import {
  type CueDefinition,
  ensureStandardSfx,
  loadSfxLibrary,
  SfxCacheMeta,
  type SfxDeps,
  type SfxFile,
  sfxHash,
  variantLabel,
} from "./sfx.ts";
import { defaultSfxQc, type SfxQc, type SfxQcHook } from "./sfxQc.ts";

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
  /** Куди друкувати таблицю QC після прогріву (CLI — `console.log`); немає — без таблиці. */
  print?: (line: string) => void;
}

/** Варіант бібліотеки: мітка (`pop.2`), опис і хеш запиту. Однаковий хеш — один рядок. */
interface LibraryEntry {
  label: string;
  def: CueDefinition;
  hash: string;
}

function libraryEntries(prompts: PromptLoader): LibraryEntry[] {
  const out = new Map<string, LibraryEntry>();
  for (const [cue, variants] of Object.entries(loadSfxLibrary(prompts))) {
    variants.forEach((def, i) => {
      const hash = sfxHash(def);
      if (!out.has(hash)) out.set(hash, { label: variantLabel(cue, i + 1), def, hash });
    });
  }
  return [...out.values()];
}

/**
 * Генерує відсутні SFX бібліотеки (усі `SoundCue` × усі варіанти; legacy-cue — це їхні варіанти 1)
 * у `DATA_DIR/cache/sfx/<hash>.mp3`; наявні пропускає. Однаковий запит генерується один раз.
 * Щойно згенеровані проходять QC (до `SFX_QC_MAX_RETRIES` повторів); з `print` — таблиця QC.
 */
export async function warmSfxCache(opts: WarmSfxCacheOptions): Promise<SfxFile[]> {
  const deps: SfxDeps = {
    storage: opts.storage,
    client: opts.client,
    gate: opts.gate,
    qc: opts.qc ?? defaultSfxQc,
    ...(opts.logger ? { logger: opts.logger } : {}),
  };
  const entries = libraryEntries(opts.prompts);
  const files = await Promise.all(entries.map((e) => ensureStandardSfx(deps, opts.cost, e.label, e.def)));
  if (opts.print) {
    const rows: SfxQcRow[] = await Promise.all(
      files.map(async (f) => ({
        label: f.cue,
        hash: f.hash,
        key: f.key,
        status: f.generated ? "generated" : "cached",
        qc: (await readMeta(opts.storage, f.hash))?.qc ?? null,
        error: null,
      })),
    );
    for (const line of formatSfxQcTable(rows)) opts.print(line);
  }
  return files;
}

/** Рядок звіту QC по кешу. */
export interface SfxQcRow {
  label: string;
  hash: string;
  /** Ключ аудіофайлу в сховищі; null — файлу немає. */
  key: string | null;
  /** generated — щойно згенеровано; cached — уже був; missing — немає в кеші. */
  status: "generated" | "cached" | "missing";
  /** QC з `<hash>.json` (після `recheck` — щойно перерахований); null — без QC. */
  qc: SfxQc | null;
  /** Хук QC упав (не декодується, немає ffmpeg); null — ні. */
  error: string | null;
}

/** Рядок не пройшов QC (немає в кеші чи QC упав — не провал: їх не перегенеровуємо). */
export const sfxQcFailed = (row: SfxQcRow) => row.qc !== null && !row.qc.ok;

const STATUS_LABEL: Record<SfxQcRow["status"], string> = {
  generated: "згенеровано",
  cached: "у кеші",
  missing: "немає",
};

const cell = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

/** Таблиця QC: cue, hash, стан, QC, спроби, пік, onset, кореляція, тон, причини; внизу — підсумок. */
export function formatSfxQcTable(rows: readonly SfxQcRow[]): string[] {
  const header = [
    "cue",
    "hash",
    "стан",
    "QC",
    "спроб",
    "пік dBFS",
    "onset мс",
    "corr",
    "pitch Гц",
    "причини",
  ];
  const body = [...rows]
    .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }))
    .map((r) => [
      r.label,
      r.hash,
      STATUS_LABEL[r.status],
      r.error ? "помилка" : r.qc ? (r.qc.ok ? "ok" : "✗") : "—",
      cell(r.qc?.attempts),
      cell(r.qc?.peakDb),
      cell(r.qc?.onsetMs),
      cell(r.qc?.correlation),
      cell(r.qc?.pitchHz),
      r.error ?? r.qc?.reasons.join("; ") ?? "",
    ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((c) => (c[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  const failed = rows.filter(sfxQcFailed).length;
  const missing = rows.filter((r) => r.status === "missing").length;
  const errors = rows.filter((r) => r.error !== null).length;
  return [
    line(header),
    ...body.map(line),
    `QC: ${rows.length} семплів, не пройшли ${failed}, немає в кеші ${missing}, QC не вдався ${errors}`,
  ];
}

async function readMeta(storage: Storage, hash: string): Promise<SfxCacheMeta | null> {
  const key = sharedPaths.sfxCacheMeta(hash);
  if (!(await storage.exists(key))) return null;
  try {
    return await storage.readJson(key, (v) => SfxCacheMeta.parse(v));
  } catch {
    return null;
  }
}

const posixKey = (key: string) => key.replaceAll("\\", "/");

/**
 * Аудіофайли кешу за хешем: `cache/sfx/<hash>.mp3` і/або `.wav` (PCM-формат), відсортовані;
 * без метаданих `.json` і без підтек (`rejected/`).
 */
async function cachedAudio(storage: Storage): Promise<Map<string, string[]>> {
  const dir = posixKey(sharedPaths.sfxCacheDir);
  const out = new Map<string, string[]>();
  for (const key of await storage.list(sharedPaths.sfxCacheDir)) {
    const k = posixKey(key);
    if (path.posix.dirname(k) !== dir) continue;
    const ext = path.posix.extname(k);
    if (ext === ".json" || ext === "") continue;
    const hash = path.posix.basename(k, ext);
    out.set(hash, [...(out.get(hash) ?? []), key]);
  }
  return out;
}

export interface RecheckSfxCacheOptions {
  storage: Storage;
  prompts: PromptLoader;
  /** Дефолт — `defaultSfxQc`. */
  qc?: SfxQcHook;
  logger?: Logger;
  signal?: AbortSignal;
}

/**
 * QC наявного кешу без платних викликів: кожен варіант бібліотеки, що вже є в кеші, декодується
 * й перевіряється заново; результат пишеться в `qc` його `<hash>.json` (спроби — з попереднього QC).
 * Старі файли (тексти змінились — інший хеш) не перевіряються: зведення їх уже не бере.
 */
export async function recheckSfxCache(opts: RecheckSfxCacheOptions): Promise<SfxQcRow[]> {
  const qc = opts.qc ?? defaultSfxQc;
  const logger = opts.logger ?? noopLogger;
  const audio = await cachedAudio(opts.storage);
  const rows: SfxQcRow[] = [];
  for (const { label, def, hash } of libraryEntries(opts.prompts)) {
    const key = audio.get(hash)?.[0] ?? null;
    if (!key) {
      rows.push({ label, hash, key, status: "missing", qc: null, error: null });
      continue;
    }
    const meta = await readMeta(opts.storage, hash);
    let result: SfxQc;
    try {
      result = await qc(await opts.storage.read(key), label, def, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      logger.warn("QC семпла SFX не вдався", { cue: label, err: String(err) });
      rows.push({ label, hash, key, status: "cached", qc: meta?.qc ?? null, error: String(err) });
      continue;
    }
    const checked: SfxQc = { ...result, attempts: meta?.qc?.attempts ?? 1 };
    const next: SfxCacheMeta = meta
      ? { ...meta, qc: checked }
      : SfxCacheMeta.parse({
          cue: label,
          text: def.text,
          durationSeconds: def.durationSeconds,
          modelId: SFX_MODEL_ID,
          createdAt: new Date().toISOString(),
          qc: checked,
        });
    await opts.storage.writeJson(sharedPaths.sfxCacheMeta(hash), next);
    rows.push({ label, hash, key, status: "cached", qc: checked, error: null });
  }
  return rows;
}

export interface RegenerateFailedSfxOptions extends WarmSfxCacheOptions {
  /** Мітка теки відбракованих файлів; дефолт — поточний час. */
  now?: () => Date;
}

/**
 * Платно. `recheckSfxCache`, далі файли, що не пройшли QC, переносяться з кешу в
 * `cache/sfx/rejected/<час>/` (разом із `.json`), і `warmSfxCache` генерує їх заново з QC
 * (до `SFX_QC_MAX_RETRIES` повторів). Відсутні у кеші теж генеруються; QC, що впав, — не провал.
 */
export async function regenerateFailedSfx(
  opts: RegenerateFailedSfxOptions,
): Promise<{ rejected: SfxQcRow[]; files: SfxFile[] }> {
  const rows = await recheckSfxCache({
    storage: opts.storage,
    prompts: opts.prompts,
    ...(opts.qc ? { qc: opts.qc } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const rejected = rows.filter(sfxQcFailed);
  // Усі файли хешу (і .mp3, і .wav): інакше `ensureStandardSfx` знайде залишок і не перегенерує.
  const audio = await cachedAudio(opts.storage);
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const rejectedDir = path.posix.join(posixKey(sharedPaths.sfxCacheDir), "rejected", stamp);
  for (const row of rejected) {
    for (const key of [...(audio.get(row.hash) ?? []), sharedPaths.sfxCacheMeta(row.hash)]) {
      if (!(await opts.storage.exists(key))) continue;
      await opts.storage.copy(key, path.posix.join(rejectedDir, path.posix.basename(posixKey(key))));
      // Storage свідомо без remove: відбраковане вже скопійовано в rejected/, тож прибираємо з кешу напряму.
      await rm(opts.storage.absPath(key), { force: true });
    }
  }
  return { rejected, files: await warmSfxCache(opts) };
}

const KNOWN_FLAGS = ["--recheck", "--regenerate-failed"];

/**
 * CLI `pnpm sfx-cache` (раз на деплой). Платні виклики — лише з LIVE=1.
 * - без прапорців — генерує відсутні (з QC) і друкує таблицю QC;
 * - `--recheck` — безкоштовно: QC по наявному кешу, друкує, які файли не проходять;
 * - `--regenerate-failed` — платно: файли, що не проходять QC, генеруються заново.
 * Прапорець `--source=chat|eval|test` (дефолт chat) — джерело у спільному журналі витрат.
 */
export async function runSfxCacheCli(argv: readonly string[]): Promise<number> {
  loadRootEnv();
  const unknown = argv.filter(
    (a) => a.startsWith("--") && !a.startsWith("--source=") && !KNOWN_FLAGS.includes(a),
  );
  if (unknown.length > 0) {
    console.error(`Невідомі прапорці: ${unknown.join(" ")} (--recheck | --regenerate-failed | --source=…)`);
    return 1;
  }
  const recheck = argv.includes("--recheck");
  const regenerate = argv.includes("--regenerate-failed");
  if (recheck && regenerate) {
    console.error("--recheck і --regenerate-failed — окремі запуски.");
    return 1;
  }

  if (recheck) {
    const storage = storageFromEnv();
    const rows = await recheckSfxCache({
      storage,
      prompts: createPromptLoader(),
      logger: createConsoleLogger({ run: "sfx-cache" }),
    });
    for (const line of formatSfxQcTable(rows)) console.log(line);
    const failed = rows.filter(sfxQcFailed);
    if (failed.length > 0) {
      console.log("\nНе проходять QC:");
      for (const r of failed) console.log(`  ${r.label.padEnd(10)} ${storage.absPath(r.key as string)}`);
      console.log("Перегенерувати (платно): LIVE=1 pnpm sfx-cache --regenerate-failed");
    }
    return 0;
  }

  if (!isLive()) {
    console.log(
      regenerate
        ? "Перегенерація SFX платна і вимкнена. Запуск: LIVE=1 pnpm sfx-cache --regenerate-failed"
        : "Генерація кешу SFX платна і вимкнена. Запуск: LIVE=1 pnpm sfx-cache",
    );
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
  const opts: WarmSfxCacheOptions = {
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
    print: (line) => console.log(line),
  };
  if (regenerate) {
    const { rejected } = await regenerateFailedSfx(opts);
    console.log(
      rejected.length > 0
        ? `\nПерегенеровано (не пройшли QC): ${rejected.map((r) => r.label).join(", ")}`
        : "\nУсі семпли кешу пройшли QC — перегенерувати нічого.",
    );
  } else {
    await warmSfxCache(opts);
  }
  console.log(`Кеш: ${storage.absPath(sharedPaths.sfxCacheDir)}`);
  return 0;
}
