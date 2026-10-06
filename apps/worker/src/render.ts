import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  computeTimeline,
  type Format,
  type MainProps,
  PipelineCounters,
  ProjectState,
  primaryFormat,
  projectPaths,
  type RenderEngine,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
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

/** Стадія `render`: один job на формат → `rev/<n>/renders/<format>.mp4` (+ постер в основному форматі). */
export function createRenderStage(deps: RenderStageDeps): Stage<"render"> {
  return async (ctx: StageContext<"render">) => {
    const { format } = ctx.params;
    const { storage, projectId, rev } = ctx;
    const paths = projectPaths(projectId).rev(rev);
    const project = await readProject(storage, projectId);
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

    const label = FORMAT_LABEL[format];
    // Прогрес у чат — не частіше ніж кожні 10% (крок 0 — стартове повідомлення).
    let lastStep = 0;
    let progressChain: Promise<unknown> = Promise.resolve();
    const progress = (percent: number) => {
      progressChain = progressChain
        .then(() =>
          ctx.emit.progress("render", t("renderProgress", { format: label, percent }), percent, 100),
        )
        .catch((err: unknown) => ctx.logger.warn("прогрес рендеру не записано", { err: String(err) }));
    };

    const outKey = paths.render(format);
    const out = storage.absPath(outKey);
    const artifacts = [outKey];
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
      // Витрати пишемо одразу після рендеру — збій постера їх не губить.
      await ctx.cost.record({ provider: "remotion", renders: 1, detail: `render ${format}` });

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
        artifacts.push(paths.poster);
      }
      await progressChain;
      return { artifacts, outputs: { format, out: outKey, durationMs } };
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
