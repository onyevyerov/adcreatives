import {
  classifySource,
  normalizeInputUrl,
  projectPaths,
  type SiteData,
  type Stage,
  type StageContext,
  StageError,
  type StageName,
} from "@adc/shared";
import { writeManifest } from "./assets.ts";
import { CrawlFailedError, type CrawlOptions, crawlSite } from "./crawl.ts";
import {
  type HeicConverter,
  ingestUserPhotos,
  MAX_USER_FILE_BYTES,
  MAX_USER_FILES,
  type SkipReason,
} from "./ingest.ts";
import { buildManualSiteData } from "./manual.ts";

/** Налаштування краулера, які можна підмінити (тести, eval). */
export type CrawlStageOptions = Omit<
  CrawlOptions,
  "storage" | "projectId" | "onProgress" | "signal" | "logger"
>;

/** Записує в трейс тривалість і результат стадії. */
async function traced<S extends StageName, R>(ctx: StageContext<S>, run: () => Promise<R>): Promise<R> {
  const startedAt = new Date();
  const record = async (ok: boolean, error: string | null) => {
    try {
      await ctx.trace.record({
        rev: ctx.rev,
        stage: ctx.stage,
        attempt: ctx.attempt,
        phase: ctx.phase,
        jobId: ctx.jobId,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok,
        error,
      });
    } catch (err) {
      ctx.logger.warn("трейс не записано", { error: (err as Error).message });
    }
  };
  try {
    const result = await run();
    await record(true, null);
    return result;
  } catch (err) {
    await record(false, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    throw err;
  }
}

async function safeProgress<S extends StageName>(
  ctx: StageContext<S>,
  label: string,
  done: number | null = null,
  total: number | null = null,
): Promise<void> {
  try {
    await ctx.emit.progress(ctx.stage, label, done, total);
  } catch (err) {
    ctx.logger.warn("прогрес не надіслано", { error: (err as Error).message });
  }
}

const MSG = {
  unsafe:
    "Цю адресу не можна сканувати (внутрішня або службова мережа). Надішліть адресу публічного сайту або опишіть бізнес текстом і додайте фото.",
  failed:
    "Не вдалося відкрити сайт. Перевірте адресу або опишіть бізнес кількома реченнями й додайте фото — зробимо відео без сайту.",
  unsupported:
    "Поки що працюю лише із сайтами. Надішліть адресу сайту або опишіть бізнес текстом і додайте фото.",
  noInput: "Надішліть адресу сайту або опишіть бізнес текстом і додайте фото.",
};

/**
 * Стадія `crawl`: сайт → `crawl/site.json`, скриншоти, `crawl/assets/`, `crawl/assets.json`.
 * Без URL, для не-сайту або коли сайт недоступний — ручний режим із `params.manualText`.
 */
export function createCrawlStage(options: CrawlStageOptions = {}): Stage<"crawl"> {
  return (ctx) =>
    traced(ctx, async () => {
      const { url, manualText } = ctx.params;
      const paths = projectPaths(ctx.projectId);
      const hasManual = Boolean(manualText?.trim());
      let site: SiteData | null = null;
      let siteAssets: Awaited<ReturnType<typeof crawlSite>>["assets"] = [];

      if (url) {
        const kind = classifySource(normalizeInputUrl(url));
        if (kind !== "site" && !hasManual) {
          throw new StageError(`джерело ${kind}: ${url}`, "unsupported_source", MSG.unsupported, false);
        }
        if (kind === "site") {
          await safeProgress(ctx, "Сканую сайт…");
          try {
            const result = await crawlSite(url, {
              ...options,
              storage: ctx.storage,
              projectId: ctx.projectId,
              logger: ctx.logger,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
              onProgress: (p) =>
                safeProgress(
                  ctx,
                  p.phase === "pages"
                    ? `Сканую сайт… ${p.done}/${p.total}`
                    : `Збираю зображення… ${p.done}/${p.total}`,
                  p.done,
                  p.total,
                ),
            });
            site = result.site;
            siteAssets = result.assets;
            if (result.blocked.length > 0) {
              ctx.logger.info("заблоковано запити до приватних адрес", { count: result.blocked.length });
            }
          } catch (err) {
            if (!(err instanceof CrawlFailedError) || err.reason === "aborted") throw err;
            ctx.logger.warn("краулінг не вдався", { reason: err.reason, error: err.message });
            if (!hasManual) {
              if (err.reason === "unsafe_url") {
                throw new StageError(err.message, "unsafe_url", MSG.unsafe, false, { cause: err });
              }
              throw new StageError(err.message, "crawl_failed", MSG.failed, true, { cause: err });
            }
          }
        }
      } else if (!hasManual) {
        throw new StageError("немає ні URL, ні тексту", "no_input", MSG.noInput, false);
      }

      if (!site) site = buildManualSiteData(manualText ?? "");
      await ctx.storage.writeJson(paths.site, site);
      const manifest = await writeManifest(ctx.storage, ctx.projectId, { site: siteAssets });
      const photos = manifest.assets.filter(
        (a) => a.kind === "photo" || a.kind === "background" || a.kind === "user",
      );
      await safeProgress(ctx, site.source === "site" ? "Сайт проскановано" : "Опис бізнесу збережено");

      return {
        artifacts: [
          paths.site,
          paths.assets,
          ...site.screenshots.map((s) => s.path),
          ...siteAssets.map((a) => a.path),
        ],
        outputs: {
          mode: site.source,
          partial: site.partial,
          pages: site.pages.length,
          photos: photos.length,
        },
      };
    });
}

export const crawlStage: Stage<"crawl"> = createCrawlStage();

const SKIP_TEXT: Record<SkipReason, string> = {
  limit: `понад ${MAX_USER_FILES} файлів`,
  too_large: `більше ${MAX_USER_FILE_BYTES / 1024 / 1024} МБ`,
  not_image: "не схоже на фото",
  duplicate: "таке фото вже є",
  missing: "файл не знайдено",
  convert_failed: "не вдалося відкрити HEIC",
};

/** Стадія `ingest`: фото клієнта → асети з найвищим пріоритетом у `crawl/assets.json`. */
export function createIngestStage(options: { heicConvert?: HeicConverter } = {}): Stage<"ingest"> {
  return (ctx) =>
    traced(ctx, async () => {
      const files = ctx.params.files;
      await safeProgress(ctx, `Обробляю фото… 0/${files.length}`, 0, files.length);
      const result = await ingestUserPhotos({
        storage: ctx.storage,
        projectId: ctx.projectId,
        files,
        logger: ctx.logger,
        ...(options.heicConvert ? { heicConvert: options.heicConvert } : {}),
      });
      await safeProgress(ctx, `Обробляю фото… ${files.length}/${files.length}`, files.length, files.length);
      const details = result.skipped.map((s) => `${s.file.split("/").pop()} — ${SKIP_TEXT[s.reason]}`);
      if (files.length > 0 && result.assets.length === 0) {
        throw new StageError(
          `жодне фото не оброблено: ${details.join("; ")}`,
          "photos_invalid",
          `Не вдалося додати фото: ${details.join("; ")}. Надішліть JPEG, PNG або HEIC до 25 МБ.`,
          false,
        );
      }
      if (details.length > 0) {
        try {
          await ctx.emit.message(`Додав ${result.assets.length} фото. Пропустив: ${details.join("; ")}.`);
        } catch (err) {
          ctx.logger.warn("повідомлення не надіслано", { error: (err as Error).message });
        }
      }
      const paths = projectPaths(ctx.projectId);
      return {
        artifacts: [paths.assets, ...result.assets.map((a) => a.path)],
        outputs: { assetIds: result.assets.map((a) => a.id) },
      };
    });
}

export const ingestStage: Stage<"ingest"> = createIngestStage();
