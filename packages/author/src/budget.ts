import type { LlmAgentResult, StageOutputs, Tuning } from "@adc/shared";

/**
 * Бюджет стадії `author` (`Tuning`): токени (input + output + cache) і ітерації рахує цикл агента
 * (`Llm.agent`), час — ця стадія: після `authorMaxMinutes` спрацьовує власний сигнал, і цикл
 * зупиняється перед наступним викликом моделі (або перериває поточний).
 */

export interface AuthorLimits {
  tokenBudget: number;
  maxIterations: number;
  maxMinutes: number;
}

export function authorLimits(
  tuning: Pick<Tuning, "authorTokenBudget" | "authorMaxIterations" | "authorMaxMinutes">,
): AuthorLimits {
  return {
    tokenBudget: tuning.authorTokenBudget,
    maxIterations: tuning.authorMaxIterations,
    maxMinutes: tuning.authorMaxMinutes,
  };
}

export interface Deadline {
  /** Сигнал для `Llm.agent`: спрацьовує за часом або разом із сигналом стадії. */
  signal: AbortSignal;
  /** Чи спрацював саме ліміт часу. */
  timedOut(): boolean;
  dispose(): void;
}

/** Сигнал з лімітом часу, прив'язаний до сигналу стадії (скасування job). */
export function createDeadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`author: ліміт часу ${Math.round(ms / 60_000)} хв`));
  }, ms);
  timer.unref?.();
  const onParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParent();
  else parent?.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

export type AuthorStop = StageOutputs<"author">["stoppedBy"];

/** Причина зупинки агента → `StageOutputs.author.stoppedBy` (сигнал без ліміту часу сюди не доходить). */
export function stopReason(stoppedBy: LlmAgentResult["stoppedBy"], timedOut: boolean): AuthorStop {
  if (stoppedBy === "signal") return timedOut ? "time" : "done";
  return stoppedBy;
}

/** Текст бюджету для промпта. */
export function budgetText(limits: AuthorLimits): string {
  const tokens = `${Math.round(limits.tokenBudget / 100_000) / 10}M`;
  return `${limits.maxIterations} tool turns, about ${tokens} tokens (input, output and cache reads together), ${limits.maxMinutes} minutes`;
}
