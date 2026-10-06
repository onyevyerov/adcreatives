import {
  LlmError,
  type PipelineDriver,
  type PipelineJob,
  type Queue,
  type QueueName,
  type StageDoneEvent,
  StageError,
  type StageErrorInfo,
  type StageJob,
} from "@adc/shared";
import { UnrecoverableError } from "bullmq";
import { buildStageContext, type StageRuntime } from "./context.ts";
import { stageEventJobId } from "./queue.ts";
import { resolveStage, type StageRegistry } from "./stages.ts";

export interface StageJobDeps extends StageRuntime {
  registry: StageRegistry;
  /** Продюсер: сюди йдуть події `stage_done`/`stage_failed` (черга `pipeline`). */
  queue: Queue;
}

const MAX_MESSAGE = 2000;

/**
 * Помилку стадії вже повідомлено оркестратору подією `stage_failed`. Кидається з процесора,
 * щоб BullMQ позначив job як failed; listener `failed` такі помилки пропускає.
 */
export class StageFailureReported extends UnrecoverableError {
  override name = "StageFailureReported";
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError");
}

/** Будь-яка помилка стадії → `StageErrorInfo` для оркестратора і чату. */
export function toErrorInfo(err: unknown, signal?: AbortSignal): StageErrorInfo {
  const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, MAX_MESSAGE);
  if (err instanceof StageError) {
    return { code: err.code, message, userMessage: err.userMessage, retryable: err.retryable };
  }
  if (isAbort(err, signal)) {
    return { code: "aborted", message, userMessage: "Етап перервано: воркер зупинявся.", retryable: true };
  }
  if (err instanceof LlmError) {
    return {
      code: `llm_${err.code}`,
      message,
      userMessage:
        err.code === "refusal" ? "Модель відмовилась виконати запит." : "Модель не змогла виконати запит.",
      retryable: true,
    };
  }
  return { code: "internal", message, userMessage: "Внутрішня помилка етапу.", retryable: true };
}

type EventBase = Omit<StageDoneEvent, "type" | "artifacts" | "outputs" | "reused" | "error">;

function eventBase(job: StageJob, durationMs: number): EventBase {
  const format =
    job.stage === "render" ? (job.params as StageJob<"render">["params"] | undefined)?.format : undefined;
  return {
    projectId: job.projectId,
    rev: job.rev,
    stage: job.stage,
    attempt: job.attempt,
    jobId: job.jobId,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(format ? { format } : {}),
  };
}

export function stageFailedEvent(job: StageJob, error: StageErrorInfo, durationMs: number): StageDoneEvent {
  return { ...eventBase(job, durationMs), type: "stage_failed", error } as StageDoneEvent;
}

/**
 * Подія для job, який упав поза нашим процесором: завис (lock не продовжено, `maxStalledCount: 0`)
 * або впав сам воркер. Завислий job не перезапускається мовчки — він стає `stage_failed`.
 */
export function workerFailureEvent(
  job: StageJob,
  err: Error,
  processedOn: number | undefined,
  now: number = Date.now(),
): StageDoneEvent {
  const stalled = /stalled/i.test(err.message);
  const info: StageErrorInfo = stalled
    ? {
        code: "stalled",
        message: err.message.slice(0, MAX_MESSAGE),
        userMessage: "Етап завис і був зупинений.",
        retryable: true,
      }
    : {
        code: "worker_error",
        message: `${err.name}: ${err.message}`.slice(0, MAX_MESSAGE),
        userMessage: "Збій воркера під час етапу.",
        retryable: true,
      };
  return stageFailedEvent(job, info, processedOn ? now - processedOn : 0);
}

/** Ставить подію стадії в чергу `pipeline` (jobId = `<jobId стадії>.evt` — одна подія на job). */
export async function reportStageEvent(queue: Queue, event: StageDoneEvent): Promise<void> {
  await queue.enqueuePipeline({ kind: "stage_event", event }, { jobId: stageEventJobId(event.jobId) });
}

/**
 * Виконує job стадії: будує контекст, запускає стадію з реєстру, пише трейс (якщо стадія не
 * записала сама) і ставить `stage_done`/`stage_failed` у чергу `pipeline`. Не кидає помилок стадії.
 */
export async function runStageJob(
  queueName: QueueName,
  job: StageJob,
  deps: StageJobDeps,
  signal?: AbortSignal,
): Promise<StageDoneEvent> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const elapsed = () => now().getTime() - startedAt.getTime();
  const log = deps.logger.child({
    queue: queueName,
    jobId: job.jobId,
    projectId: job.projectId,
    stage: job.stage,
  });

  let event: StageDoneEvent;
  const stage = resolveStage(deps.registry, queueName, job.stage);
  if (!stage) {
    event = stageFailedEvent(
      job,
      {
        code: "unknown_stage",
        message: `стадія "${String(job.stage)}" не обслуговується чергою ${queueName}`,
        userMessage: "Внутрішня помилка: невідомий етап.",
        retryable: false,
      },
      0,
    );
  } else {
    // Трейс пише воркер, якщо стадія не записала свій рядок сама (crawler пише сам).
    let traceEntry: (ok: boolean, error: string | null) => Promise<void> = async () => {};
    try {
      const { ctx, tracer } = await buildStageContext(job, deps, signal);
      traceEntry = async (ok, error) => {
        if (tracer.recorded) return;
        await tracer.record({
          rev: job.rev,
          stage: job.stage,
          attempt: job.attempt,
          phase: ctx.phase,
          jobId: job.jobId,
          startedAt: startedAt.toISOString(),
          durationMs: Math.max(0, Math.round(elapsed())),
          ok,
          error,
        });
      };
      const result = await stage(ctx);
      event = {
        ...eventBase(job, elapsed()),
        type: "stage_done",
        artifacts: result.artifacts,
        outputs: result.outputs,
        reused: result.reused ?? false,
      } as StageDoneEvent;
    } catch (err) {
      const info = toErrorInfo(err, signal);
      log.error("стадія впала", { code: info.code, err: info.message });
      event = stageFailedEvent(job, info, elapsed());
    }
    try {
      await traceEntry(
        event.type === "stage_done",
        event.type === "stage_failed" ? event.error.message : null,
      );
    } catch (err) {
      log.warn("трейс не записано", { err: String(err) });
    }
  }

  await reportStageEvent(deps.queue, event);
  log.info(event.type === "stage_done" ? "стадія завершена" : "стадія не вдалась", {
    durationMs: event.durationMs,
  });
  return event;
}

/** Процесор черги `pipeline`: команди API і події стадій → оркестратор. */
export async function handlePipelineJob(job: PipelineJob, driver: PipelineDriver): Promise<void> {
  switch (job?.kind) {
    case "command":
      await driver.handleCommand(job.command);
      return;
    case "stage_event":
      await driver.onStageDone(job.event);
      return;
    default:
      throw new UnrecoverableError(`невідомий job черги pipeline: ${JSON.stringify(job)?.slice(0, 200)}`);
  }
}
