import type { PipelineCommand, StageDoneEvent, StageJob } from "./queue.ts";
import type { ChatEventInput } from "./schemas/events.ts";
import type { ProjectState } from "./schemas/project.ts";

/**
 * Оркестратор (реалізація — B7, `packages/pipeline`). Воркер черги `pipeline`
 * викликає його для кожної команди API і кожної завершеної стадії.
 * Лише він пише `project.json` (під Redis-lock `lock:project:<id>`).
 */
export interface PipelineDriver {
  handleCommand(cmd: PipelineCommand): Promise<void>;
  onStageDone(event: StageDoneEvent): Promise<void>;
}

/** Ключ Redis-блокування проєкту. */
export const projectLockKey = (projectId: string) => `lock:project:${projectId}`;

/** Вхід чистої функції переходів: команда або подія стадії (з уже розібраним наміром для user_message). */
export type PipelineInput =
  | { kind: "command"; command: PipelineCommand }
  | { kind: "stage_event"; event: StageDoneEvent };

/** Результат `nextStep(state, input)`: новий стан, job для черг, події для чату. */
export interface NextStepResult {
  state: ProjectState;
  jobs: StageJob[];
  events: ChatEventInput[];
}
