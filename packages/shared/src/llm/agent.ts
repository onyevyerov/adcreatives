import type { AgentRuntime, LlmAgentOptions, LlmAgentResult } from "./client.ts";
import { LlmError } from "./client.ts";
import type { PromptVars } from "./prompts.ts";

/**
 * Цикл з інструментами для `Llm.agent`: `messages` зі стрімом, `tool_use` → `AgentTool.run` →
 * `tool_result`, кеш system + tools, облік витрат на кожну ітерацію, зупинка за бюджетом.
 * Заглушка Кроку 0 (ТЗ 2026-10-12 «паритет із роликом»); реалізація — блок C1.
 */
export async function runAgent(
  _runtime: AgentRuntime,
  name: string,
  _vars: PromptVars,
  _opts: LlmAgentOptions,
): Promise<LlmAgentResult> {
  throw new LlmError(`${name}: агентний цикл ще не реалізовано`, "agent_not_implemented");
}
