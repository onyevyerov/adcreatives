import { audioStage } from "@adc/audio";
import { brandkitPatchStage, brandkitStage } from "@adc/brandkit";
import { crawlStage, ingestStage } from "@adc/crawler";
import { createRenderEngine } from "@adc/render";
import {
  type QueueName,
  type RenderEngine,
  STAGE_NAMES,
  STAGE_QUEUE,
  type Stage,
  StageError,
  type StageName,
} from "@adc/shared";
import { createRenderStage, type PrepareRenderJob, stubPrepareRenderJob } from "./render.ts";

/** Реєстр: назва стадії → функція `Stage` відповідного типу. */
export type StageRegistry = { [S in StageName]: Stage<S> };

/** Стадії режисера (B4, `@adc/director`). */
export type DirectorStageName = "storyboard" | "codegen" | "check" | "fix" | "qa" | "revise";
export type DirectorStages = { [S in DirectorStageName]: Stage<S> };

function notImplemented<S extends StageName>(stage: S): Stage<S> {
  return async () => {
    throw new StageError(
      `стадія ${stage} ще не підключена (@adc/director)`,
      "not_implemented",
      "Цей етап ще не підключено.",
      false,
    );
  };
}

/**
 * Заглушки стадій режисера до злиття B4.
 * TODO(integration): wire @adc/director — замінити на
 *   `{ storyboard: storyboardStage, codegen: codegenStage, check: createCheckStage({ engine }),
 *      fix: fixStage, qa: qaStage, revise: reviseStage }` з `@adc/director`.
 */
export function stubDirectorStages(): DirectorStages {
  return {
    storyboard: notImplemented("storyboard"),
    codegen: notImplemented("codegen"),
    check: notImplemented("check"),
    fix: notImplemented("fix"),
    qa: notImplemented("qa"),
    revise: notImplemented("revise"),
  };
}

export interface StageRegistryDeps {
  /** Стадії режисера; дефолт — заглушки `not_implemented`. */
  director?: DirectorStages;
  /** Підготовка теки рендеру; дефолт — заглушка `not_implemented`. */
  prepareRenderJob?: PrepareRenderJob;
  /** Фабрика рушія рендеру (новий на кожну задачу); дефолт — Remotion з `@adc/render`. */
  createEngine?: () => RenderEngine;
  /** Точкова підміна стадій (тести, eval). */
  overrides?: Partial<StageRegistry>;
}

export function createStageRegistry(deps: StageRegistryDeps = {}): StageRegistry {
  const director = deps.director ?? stubDirectorStages();
  const registry: StageRegistry = {
    crawl: crawlStage,
    ingest: ingestStage,
    brandkit: brandkitStage,
    "brandkit-patch": brandkitPatchStage,
    ...director,
    audio: audioStage,
    render: createRenderStage({
      prepareRenderJob: deps.prepareRenderJob ?? stubPrepareRenderJob,
      createEngine: deps.createEngine ?? (() => createRenderEngine()),
    }),
  };
  return { ...registry, ...deps.overrides } as StageRegistry;
}

/** Черга стадії (мапа `STAGE_QUEUE` з Кроку 0). */
export function queueOf(stage: StageName): QueueName {
  return STAGE_QUEUE[stage];
}

/** Стадії, які обслуговує черга. */
export function stagesForQueue(queue: QueueName): StageName[] {
  return STAGE_NAMES.filter((s) => STAGE_QUEUE[s] === queue);
}

export function isStageName(value: unknown): value is StageName {
  return typeof value === "string" && (STAGE_NAMES as readonly string[]).includes(value);
}

/** Стадія з реєстру, якщо вона належить цій черзі. */
export function resolveStage(registry: StageRegistry, queue: QueueName, stage: unknown): Stage | null {
  if (!isStageName(stage) || queueOf(stage) !== queue) return null;
  return registry[stage] as unknown as Stage;
}
