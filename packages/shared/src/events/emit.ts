import type { Redis } from "ioredis";
import { ChatEvent, type ChatEventInput } from "../schemas/events.ts";
import type { CostStage } from "../schemas/project.ts";

/** Ключ Redis Stream із подіями чату проєкту. */
export const eventsKey = (projectId: string) => `events:${projectId}`;

/** Поле запису стріму, у якому лежить JSON події. */
export const EVENT_FIELD = "data";

export interface Emitter {
  /** Пише подію в стрім проєкту; повертає ID запису (він же SSE `id`). */
  emit(event: ChatEventInput): Promise<string>;
  progress(
    stage: CostStage,
    label: string,
    done?: number | null,
    total?: number | null,
    step?: string,
  ): Promise<string>;
  message(
    text: string,
    opts?: {
      role?: "assistant" | "system";
      buttons?: Array<"approve" | "edit" | "retry" | "restart_confirm">;
    },
  ): Promise<string>;
}

export async function appendEvent(redis: Redis, projectId: string, event: ChatEvent): Promise<string> {
  const valid = ChatEvent.parse(event);
  const id = await redis.xadd(eventsKey(projectId), "*", EVENT_FIELD, JSON.stringify(valid));
  if (!id) throw new Error("XADD не повернув ID");
  return id;
}

export function createEmitter(redis: Redis, projectId: string, now: () => Date = () => new Date()): Emitter {
  const emit = (event: ChatEventInput) =>
    appendEvent(redis, projectId, { ...event, at: now().toISOString() } as ChatEvent);
  return {
    emit,
    progress: (stage, label, done = null, total = null, step) =>
      emit({ type: "progress", stage, label, done, total, ...(step ? { step } : {}) }),
    message: (text, opts = {}) =>
      emit({
        type: "message",
        role: opts.role ?? "assistant",
        text,
        ...(opts.buttons ? { buttons: opts.buttons } : {}),
      }),
  };
}

/** Emitter, що збирає події в масив (тести, eval). */
export function createMemoryEmitter(now: () => Date = () => new Date()): Emitter & { events: ChatEvent[] } {
  const events: ChatEvent[] = [];
  const emit = async (event: ChatEventInput) => {
    events.push(ChatEvent.parse({ ...event, at: now().toISOString() }));
    return `${Date.now()}-${events.length - 1}`;
  };
  return {
    events,
    emit,
    progress: (stage, label, done = null, total = null, step) =>
      emit({ type: "progress", stage, label, done, total, ...(step ? { step } : {}) }),
    message: (text, opts = {}) =>
      emit({
        type: "message",
        role: opts.role ?? "assistant",
        text,
        ...(opts.buttons ? { buttons: opts.buttons } : {}),
      }),
  };
}
