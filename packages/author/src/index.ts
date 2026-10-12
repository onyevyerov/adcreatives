/**
 * `@adc/author` — агентний режим генерації (стадія `author`): один агент пише сцени, рендерить
 * стрипи, дивиться їх і править сам у межах бюджету (ТЗ 2026-10-12 «паритет із роликом», блок C1).
 *
 * Воркер реєструє `authorStage` (Крок 0); оркестратор ставить її замість `codegen`, коли
 * `ADC_GENERATION_MODE=agent` (блок C2). Далі `check` → `qa` → `fix` працюють як після codegen.
 */

export { type AuthorLimits, authorLimits, createDeadline, stopReason } from "./budget.ts";
export type { AuthorSession, EngineSource } from "./session.ts";
export {
  AUTHOR_PROMPT,
  AuthorReport,
  type AuthorStageDeps,
  authorReportKey,
  authorStage,
  createAuthorStage,
} from "./stage.ts";
export { authorLogKey, authorTools } from "./tools/index.ts";
export { audioEventsTable } from "./tools/meta.ts";
