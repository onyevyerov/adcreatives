import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadCodegenContext } from "@adc/director";
import {
  computeTimeline,
  type Format,
  inputsHash,
  type MainProps,
  PipelineCounters,
  ProjectState,
  primaryFormat,
  projectPaths,
  type RenderEngine,
  RenderMeta,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  sha256,
  stillFrames,
  t,
} from "@adc/shared";

/** Аргументи підготовки теки рендеру (реалізація — B4, `@adc/director`). */
export interface PrepareRenderJobArgs {
  storage: Storage;
  projectId: string;
  rev: number;
  format: Format;
  /** Сцени, які малюються `TemplateScene` (з `rev/<n>/pipeline.json`). */
  templateScenes: string[];
}

/** Готує `rev/<n>/video` (сцени, index.ts, public/) і повертає абсолютний jobDir + MainProps. */
export type PrepareRenderJob = (
  args: PrepareRenderJobArgs,
) => Promise<{ jobDir: string; mainProps: MainProps }>;

export interface RenderStageDeps {
  prepareRenderJob: PrepareRenderJob;
  /** Новий рушій на кожну задачу: браузер переюзується в її межах і закривається в кінці. */
  createEngine: () => RenderEngine;
  /** Хеш контексту motion-kit (входить у хеш входів рендеру); дефолт — `loadCodegenContext().hash`. */
  motionKitHash?: () => string;
}

export const FORMAT_LABEL: Record<Format, string> = {
  vertical: "9:16",
  square: "1:1",
  landscape: "16:9",
};

/**
 * Кадр постера: 50% сцени з `purpose: "cta"` (якщо немає — останньої сцени), глобальний кадр
 * композиції `Main` за `computeTimeline`.
 */
export function posterFrame(storyboard: MainProps["storyboard"]): { sceneId: string; frame: number } {
  const timeline = computeTimeline(storyboard);
  const idx = storyboard.scenes.findIndex((s) => s.purpose === "cta");
  const ts = timeline.scenes[idx >= 0 ? idx : timeline.scenes.length - 1];
  if (!ts) throw new Error("розкадровка без сцен");
  const [local = 0] = stillFrames(ts.durationInFrames, [0.5]);
  return { sceneId: ts.id, frame: ts.from + local };
}

async function readProject(storage: Storage, projectId: string): Promise<ProjectState> {
  const key = projectPaths(projectId).project;
  if (!(await storage.exists(key))) {
    throw new StageError(`немає ${key}`, "project_missing", "Не знайдено дані проєкту.", false);
  }
  return storage.readJson(key, (v) => ProjectState.parse(v));
}

async function readTemplateScenes(storage: Storage, projectId: string, rev: number): Promise<string[]> {
  const key = projectPaths(projectId).rev(rev).pipeline;
  if (!(await storage.exists(key))) return [];
  const counters = await storage.readJson(key, (v) => PipelineCounters.parse(v));
  return counters.templateScenes;
}

/**
 * Хеш входів рендеру формату: код сцен і `scenes/index.ts`, розкадровка, аудіо-маніфест, бренд, асети,
 * `templateScenes`, формат і хеш контексту motion-kit. Рахується після `prepareRenderJob` (той пише index).
 */
export async function renderInputsHash(args: {
  storage: Storage;
  projectId: string;
  rev: number;
  inputProps: MainProps;
  templateScenes: readonly string[];
  motionKitHash: string;
}): Promise<string> {
  const { storage, inputProps } = args;
  const scenesDir = projectPaths(args.projectId).rev(args.rev).scenesDir;
  const code: Record<string, string> = {};
  for (const key of await storage.list(scenesDir)) {
    code[key.slice(scenesDir.length + 1)] = sha256(await storage.read(key));
  }
  return inputsHash({
    code,
    storyboard: inputProps.storyboard,
    audio: inputProps.audio,
    brand: inputProps.brand,
    assets: inputProps.assets,
    templateScenes: [...args.templateScenes],
    format: inputProps.format,
    motionKit: args.motionKitHash,
  });
}

async function readRenderMeta(storage: Storage, key: string): Promise<RenderMeta | null> {
  if (!(await storage.exists(key))) return null;
  try {
    return await storage.readJson(key, (v) => RenderMeta.parse(v));
  } catch {
    return null;
  }
}

/**
 * Стадія `render`: один job на формат → `rev/<n>/renders/<format>.mp4` (+ постер в основному форматі).
 * Якщо `renders/<format>.meta.json` має той самий хеш входів і mp4 (і постер) на місці — рендер
 * перевикористовується (`reused: true`, без витрат Remotion). Спекулятивний рендер (до «Затвердити»)
 * не пише прогрес у чат, а для застарілої ревізії падає з `superseded` без рендеру.
 */
export function createRenderStage(deps: RenderStageDeps): Stage<"render"> {
  return async (ctx: StageContext<"render">) => {
    const { format } = ctx.params;
    const { storage, projectId, rev } = ctx;
    const paths = projectPaths(projectId).rev(rev);
    const project = await readProject(storage, projectId);
    const speculative = ctx.params.speculative === true;
    // Превʼю старої ревізії (після «Правки» job уже стояв у черзі) не рендеримо: слот черги один,
    // а результат машина однаково проігнорує.
    if (speculative && project.rev !== rev) {
      throw new StageError(
        "спекулятивний рендер застарілої ревізії",
        "superseded",
        "Превʼю застаріло.",
        false,
      );
    }
    const isPrimary = primaryFormat(project.formats) === format;
    const templateScenes = await readTemplateScenes(storage, projectId, rev);

    const { jobDir, mainProps } = await deps.prepareRenderJob({
      storage,
      projectId,
      rev,
      format,
      templateScenes,
    });
    const inputProps: MainProps = { ...mainProps, format };

    const hash = await renderInputsHash({
      storage,
      projectId,
      rev,
      inputProps,
      templateScenes,
      motionKitHash: (deps.motionKitHash ?? (() => loadCodegenContext().hash))(),
    });
    const outKey = paths.render(format);
    const metaKey = paths.renderMeta(format);
    const artifacts = isPrimary ? [outKey, paths.poster] : [outKey];

    const label = FORMAT_LABEL[format];
    const quiet = speculative;
    // Прогрес у чат — не частіше ніж кожні 10% (крок 0 — стартове повідомлення).
    let lastStep = 0;
    let progressChain: Promise<unknown> = Promise.resolve();
    const progress = (percent: number) => {
      if (quiet) return;
      progressChain = progressChain
        .then(() =>
          ctx.emit.progress("render", t("renderProgress", { format: label, percent }), percent, 100),
        )
        .catch((err: unknown) => ctx.logger.warn("прогрес рендеру не записано", { err: String(err) }));
    };

    const meta = await readRenderMeta(storage, metaKey);
    if (
      meta?.inputsHash === hash &&
      (await storage.exists(outKey)) &&
      (!isPrimary || (await storage.exists(paths.poster)))
    ) {
      progress(100);
      await progressChain;
      return { artifacts, outputs: { format, out: outKey, durationMs: 0 }, reused: true, inputsHash: hash };
    }

    const out = storage.absPath(outKey);
    const engine = deps.createEngine();
    try {
      progress(0);
      const { serveUrl } = await engine.bundleJob({ jobDir, signal: ctx.signal });
      await mkdir(path.dirname(out), { recursive: true });
      const { durationMs } = await engine.renderMedia({
        serveUrl,
        inputProps,
        format,
        out,
        signal: ctx.signal,
        onProgress: (p) => {
          const percent = Math.max(0, Math.min(100, Math.round(p * 100)));
          const step = Math.floor(percent / 10);
          if (step > lastStep) {
            lastStep = step;
            progress(percent);
          }
        },
      });
      // Витрати пишемо одразу після рендеру — збій постера їх не губить. Спекулятивний — як «preview».
      await ctx.cost.record({
        provider: "remotion",
        renders: 1,
        detail: `${speculative ? "preview" : "render"} ${format}`,
      });

      if (isPrimary) {
        const { frame } = posterFrame(inputProps.storyboard);
        const posterOut = storage.absPath(paths.poster);
        await mkdir(path.dirname(posterOut), { recursive: true });
        await engine.renderStill({
          serveUrl,
          composition: "Main",
          inputProps,
          frame,
          format,
          out: posterOut,
          signal: ctx.signal,
        });
      }
      // Meta — останнім: є лише тоді, коли mp4 (і постер) цих входів дописано.
      try {
        await storage.writeJson(metaKey, { inputsHash: hash } satisfies RenderMeta);
      } catch (err) {
        ctx.logger.warn("meta рендеру не записано", { err: String(err) });
      }
      await progressChain;
      return { artifacts, outputs: { format, out: outKey, durationMs }, inputsHash: hash };
    } finally {
      await progressChain;
      try {
        await engine.close();
      } catch (err) {
        ctx.logger.warn("не вдалося закрити рушій рендеру", { err: String(err) });
      }
    }
  };
}
