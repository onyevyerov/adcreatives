import { audioStage } from "@adc/audio";
import { authorStage } from "@adc/author";
import { brandkitPatchStage, brandkitStage } from "@adc/brandkit";
import { crawlStage, ingestStage } from "@adc/crawler";
import {
  codegenStage,
  createCheckStage,
  fixStage,
  prepareRenderJob,
  qaStage,
  reviewStage,
  reviseStage,
  sfxStage,
  storyboardStage,
} from "@adc/director";
import { createRenderEngine } from "@adc/render";
import {
  type QueueName,
  type RenderEngine,
  STAGE_NAMES,
  STAGE_QUEUE,
  type Stage,
  type StageName,
} from "@adc/shared";
import { createRenderStage, type PrepareRenderJob } from "./render.ts";

/** Реєстр: назва стадії → функція `Stage` відповідного типу. */
export type StageRegistry = { [S in StageName]: Stage<S> };

/** Стадії режисера (B4, `@adc/director`). */
export type DirectorStageName =
  | "storyboard"
  | "codegen"
  | "check"
  | "fix"
  | "qa"
  | "revise"
  | "sfx"
  | "review";
export type DirectorStages = { [S in DirectorStageName]: Stage<S> };

/** Стадії режисера з `@adc/director`; check отримує новий рушій рендеру на кожен запуск. */
export function defaultDirectorStages(createEngine: () => RenderEngine): DirectorStages {
  return {
    storyboard: storyboardStage,
    codegen: codegenStage,
    check: createCheckStage({ engine: createEngine }),
    fix: fixStage,
    qa: qaStage,
    sfx: sfxStage,
    review: reviewStage,
    revise: reviseStage,
  };
}

export interface StageRegistryDeps {
  /** Стадії режисера; дефолт — `@adc/director`. */
  director?: DirectorStages;
  /** Підготовка теки рендеру; дефолт — `prepareRenderJob` з `@adc/director`. */
  prepareRenderJob?: PrepareRenderJob;
  /** Фабрика рушія рендеру (новий на кожну задачу); дефолт — Remotion з `@adc/render`. */
  createEngine?: () => RenderEngine;
  /** Точкова підміна стадій (тести, eval). */
  overrides?: Partial<StageRegistry>;
}

export function createStageRegistry(deps: StageRegistryDeps = {}): StageRegistry {
  const createEngine = deps.createEngine ?? (() => createRenderEngine());
  const director = deps.director ?? defaultDirectorStages(createEngine);
  const registry: StageRegistry = {
    crawl: crawlStage,
    ingest: ingestStage,
    brandkit: brandkitStage,
    "brandkit-patch": brandkitPatchStage,
    ...director,
    /** Агентний режим генерації (`ADC_GENERATION_MODE=agent`), `@adc/author`. */
    author: authorStage,
    audio: audioStage,
    render: createRenderStage({
      prepareRenderJob: deps.prepareRenderJob ?? prepareRenderJob,
      createEngine,
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
