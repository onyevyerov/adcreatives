import type { Format } from "./schemas/common.ts";
import type { StageName } from "./schemas/project.ts";
import type { StageOutputsMap, StageParamsMap } from "./stage.ts";

export const QUEUE_NAMES = ["pipeline", "crawl", "llm", "cpu", "audio", "render"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** У яку чергу йде кожна стадія (за типом ресурсу). */
export const STAGE_QUEUE = {
  crawl: "crawl",
  ingest: "crawl",
  brandkit: "llm",
  "brandkit-patch": "llm",
  storyboard: "llm",
  codegen: "llm",
  /** Та сама черга режисера, що й codegen. */
  author: "llm",
  fix: "llm",
  qa: "llm",
  sfx: "llm",
  review: "llm",
  revise: "llm",
  check: "cpu",
  audio: "audio",
  render: "render",
} as const satisfies Record<StageName, QueueName>;

export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  pipeline: 8,
  crawl: 2,
  llm: 6,
  cpu: 1,
  audio: 2,
  render: 1,
};

/** lockDuration BullMQ, мс: довгі CPU-задачі й рендер — 10 хв. */
export const QUEUE_LOCK_MS: Record<QueueName, number> = {
  pipeline: 60_000,
  crawl: 5 * 60_000,
  llm: 5 * 60_000,
  cpu: 10 * 60_000,
  audio: 5 * 60_000,
  render: 10 * 60_000,
};

/**
 * Пріоритет BullMQ спекулятивних render-job (відео-превʼю ЧП3). У BullMQ 6.x job без пріоритету
 * (`0`) беруться раніше за будь-який prioritized, серед prioritized — менше число раніше. Тож
 * звичайні (оплачені) рендери йдуть без пріоритету й обганяють превʼю в єдиному слоті черги `render`.
 */
export const SPECULATIVE_RENDER_PRIORITY = 100;

/**
 * ID job стадії: `<projectId>.<stage>.r<rev>.a<attempt>[.<format>]`.
 * (BullMQ 6 не приймає `:` у власних ID, тому роздільник — крапка; nanoid крапок не містить.)
 * Однаковий ID = BullMQ не поставить job удруге (захист від подвійних кліків).
 */
export function makeJobId(
  projectId: string,
  stage: StageName,
  rev: number,
  attempt: number,
  suffix?: string,
): string {
  return [projectId, stage, `r${rev}`, `a${attempt}`, ...(suffix ? [suffix] : [])].join(".");
}

export function makeCommandJobId(projectId: string, commandId: string): string {
  return `${projectId}.cmd.${commandId}`;
}

/** Job стадії в черзі ресурсу. */
export interface StageJob<S extends StageName = StageName> {
  jobId: string;
  projectId: string;
  rev: number;
  stage: S;
  attempt: number;
  params: StageParamsMap[S];
}

/** Команди від API до оркестратора. */
export type PipelineCommand = { projectId: string; commandId: string; issuedAt: string } & (
  | { type: "start" }
  | { type: "user_message"; text: string; messageId: string }
  | { type: "approve"; rev: number | null }
  | { type: "set_logo"; assetId: string }
  | { type: "photos_added"; files: string[] }
  | { type: "retry" }
  | { type: "restart_confirmed" }
);
export type PipelineCommandType = PipelineCommand["type"];

/** Команди, які API приймає через POST /api/projects/:id/commands. */
export const API_COMMAND_TYPES = ["approve", "set_logo", "retry", "restart_confirmed"] as const;

export interface StageErrorInfo {
  code: string;
  message: string;
  userMessage: string;
  retryable: boolean;
}

/** Подія, яку воркер ставить у чергу `pipeline` після стадії. */
export type StageDoneEvent<S extends StageName = StageName> = {
  projectId: string;
  rev: number;
  stage: S;
  attempt: number;
  jobId: string;
  durationMs: number;
  /** Для render — формат. */
  format?: Format;
} & (
  | { type: "stage_done"; artifacts: string[]; outputs: StageOutputsMap[S]; reused: boolean }
  | { type: "stage_failed"; error: StageErrorInfo }
);

/** Дані job у черзі `pipeline`. */
export type PipelineJob =
  | { kind: "command"; command: PipelineCommand }
  | { kind: "stage_event"; event: StageDoneEvent };

export interface EnqueueOptions {
  jobId?: string;
  delayMs?: number;
}

/** Абстракція над BullMQ: API і оркестратор ставлять задачі через неї (у тестах — MemoryQueue). */
export interface Queue {
  enqueueStage(job: StageJob): Promise<void>;
  enqueuePipeline(job: PipelineJob, opts?: EnqueueOptions): Promise<void>;
  close(): Promise<void>;
}

/** Фейкова черга для тестів: просто складає задачі в масиви. */
export class MemoryQueue implements Queue {
  readonly stages: StageJob[] = [];
  readonly pipeline: PipelineJob[] = [];
  private readonly seen = new Set<string>();

  async enqueueStage(job: StageJob): Promise<void> {
    if (this.seen.has(job.jobId)) return;
    this.seen.add(job.jobId);
    this.stages.push(job);
  }

  async enqueuePipeline(job: PipelineJob, opts: EnqueueOptions = {}): Promise<void> {
    if (opts.jobId) {
      if (this.seen.has(opts.jobId)) return;
      this.seen.add(opts.jobId);
    }
    this.pipeline.push(job);
  }

  async close(): Promise<void> {}
}
