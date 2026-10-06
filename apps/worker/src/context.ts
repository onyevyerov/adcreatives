import {
  type AnthropicLike,
  type CostPhase,
  createCostRecorder,
  createLlm,
  createTracer,
  type Emitter,
  type Logger,
  type Prices,
  ProjectState,
  type PromptLoader,
  projectPaths,
  type RunSource,
  type StageContext,
  type StageJob,
  type Storage,
  type Tracer,
} from "@adc/shared";

/** Спільні ресурси процесу воркера, з яких будується `StageContext` кожного job. */
export interface StageRuntime {
  storage: Storage;
  prices: Prices;
  prompts: PromptLoader;
  /** Клієнт Anthropic; фабрика викликається ліниво — лише при першому реальному виклику LLM. */
  anthropic: AnthropicLike | (() => AnthropicLike);
  /** Emitter у Redis Stream `events:<projectId>`. */
  emitterFor: (projectId: string) => Emitter;
  logger: Logger;
  now?: () => Date;
}

/** Tracer, що пам'ятає, чи стадія сама записала свій рядок трейсу. */
export interface TrackingTracer extends Tracer {
  readonly recorded: boolean;
}

export function trackingTracer(inner: Tracer): TrackingTracer {
  let recorded = false;
  return {
    get recorded() {
      return recorded;
    },
    notePrompt: (name, hash) => inner.notePrompt(name, hash),
    prompts: () => inner.prompts(),
    async record(entry) {
      recorded = true;
      await inner.record(entry);
    },
  };
}

/** Лінивий проксі клієнта: ключ API потрібен лише стадіям, що реально кличуть LLM. */
export function lazyAnthropic(source: AnthropicLike | (() => AnthropicLike)): AnthropicLike {
  if (typeof source !== "function") return source;
  let client: AnthropicLike | null = null;
  const get = () => {
    client ??= source();
    return client;
  };
  return {
    messages: {
      create: (params, options) => get().messages.create(params, options),
      stream: (params, options) => get().messages.stream(params, options),
    },
  };
}

/** Фаза витрат і джерело запуску — з `project.json` (пише оркестратор). */
export async function readRunInfo(
  storage: Storage,
  projectId: string,
  logger: Logger,
): Promise<{ phase: CostPhase; source: RunSource }> {
  const key = projectPaths(projectId).project;
  try {
    if (await storage.exists(key)) {
      const project = await storage.readJson(key, (v) => ProjectState.parse(v));
      return { phase: project.phase, source: project.origin };
    }
    logger.warn("немає project.json — фаза і джерело за замовчуванням", { projectId });
  } catch (err) {
    logger.warn("project.json не прочитано — фаза і джерело за замовчуванням", {
      projectId,
      err: String(err),
    });
  }
  return { phase: "first_delivery", source: "chat" };
}

export interface BuiltContext {
  ctx: StageContext;
  tracer: TrackingTracer;
}

/** Будує `StageContext` для job: сховище, трейс, облік витрат, emitter, LLM, промпти, логер, signal. */
export async function buildStageContext(
  job: StageJob,
  runtime: StageRuntime,
  signal?: AbortSignal,
): Promise<BuiltContext> {
  const logger = runtime.logger.child({
    projectId: job.projectId,
    rev: job.rev,
    stage: job.stage,
    attempt: job.attempt,
    jobId: job.jobId,
  });
  const { phase, source } = await readRunInfo(runtime.storage, job.projectId, logger);
  const tracer = trackingTracer(createTracer(runtime.storage, job.projectId));
  const cost = createCostRecorder(
    runtime.storage,
    runtime.prices,
    { projectId: job.projectId, rev: job.rev, stage: job.stage, phase, source, attempt: job.attempt },
    runtime.now,
  );
  const llm = createLlm({
    client: lazyAnthropic(runtime.anthropic),
    prompts: runtime.prompts,
    cost,
    trace: tracer,
    logger,
  });
  const ctx: StageContext = {
    projectId: job.projectId,
    rev: job.rev,
    stage: job.stage,
    attempt: job.attempt,
    jobId: job.jobId,
    phase,
    source,
    params: job.params,
    storage: runtime.storage,
    trace: tracer,
    cost,
    emit: runtime.emitterFor(job.projectId),
    llm,
    prompts: runtime.prompts,
    logger,
    ...(signal ? { signal } : {}),
  };
  return { ctx, tracer };
}
