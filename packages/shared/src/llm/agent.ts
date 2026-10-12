import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { CostEvent } from "../schemas/cost.ts";
import {
  type AgentRuntime,
  type AgentTool,
  type AnthropicRequestOptions,
  type ImageInput,
  isRetryableTransportError,
  type LlmAgentOptions,
  type LlmAgentResult,
  LlmError,
  MIN_TASK_BUDGET,
  REFUSAL_RETRY_NOTE,
  systemBlocks,
  TASK_BUDGET_BETA,
  usageToUnits,
} from "./client.ts";
import type { CacheTtl, PromptVars } from "./prompts.ts";

/**
 * Цикл з інструментами для `Llm.agent` (блок C1 ТЗ 2026-10-12 «паритет із роликом»).
 *
 * Кожна ітерація — один стрім `messages`: модель відповідає текстом і/або блоками `tool_use`,
 * цикл виконує інструменти по черзі (вхід перевіряє `AgentTool.input`) і відсилає `tool_result`
 * (текст і зображення) наступним user-повідомленням. Модель завершує сама (`end_turn` без
 * інструментів) — `done`; інакше зупинка за `maxIterations` (`iterations`), сумою токенів
 * `tokenBudget` (`budget`) або `opts.signal` (`signal`). Інструменти відповіді, на якій вичерпано
 * бюджет, ще виконуються: вони вже оплачені (напр. записаний код сцени).
 *
 * Кеш (≤ 4 breakpoint-и): визначення інструментів (TTL — найдовший із системних), prefix і system
 * промпта (`systemBlocks`), і «ковзний» breakpoint на останньому блоці останнього user-повідомлення —
 * кожна ітерація читає з кешу всю попередню розмову. Тому `userCached` промпта тут без власного
 * `cache_control`. Старі зображення в історії замінюються підписом, коли їх більше `MAX_HISTORY_IMAGES`
 * (API обмежує кількість зображень у запиті; заміна — рідко і пачкою, щоб не ламати кеш щоітерації).
 *
 * Витрати — `CostEvent` на кожну ітерацію (`detail: "<costDetail|name>:iter:<n>"`), повтори
 * транспортних помилок — як у `text()`.
 */

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type StreamParams = Anthropic.MessageStreamParams;

/** Скільки зображень тримати в історії: більше — найстаріші замінюються підписом до `KEEP_HISTORY_IMAGES`. */
export const MAX_HISTORY_IMAGES = 40;
export const KEEP_HISTORY_IMAGES = 20;
const IMAGE_OMITTED = "[older image omitted to save context; render again if you need it]";

const TOOL_RESULT_MAX_CHARS = 30_000;
const MAX_TOKENS_NUDGE =
  "Your previous reply hit the output token limit and was cut off; any unfinished tool call was dropped. " +
  "Continue with smaller steps: one tool call per reply, one scene per write_scene.";

function cacheControl(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** Zod-схема входу → `input_schema` інструмента. */
export function toolInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") {
    throw new LlmError("вхід інструмента має бути об'єктом (z.object)", "prompt");
  }
  return json as Anthropic.Tool.InputSchema;
}

function imageBlock(img: ImageInput): Anthropic.ImageBlockParam {
  if ("url" in img) return { type: "image", source: { type: "url", url: img.url } };
  const data = typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
  return { type: "image", source: { type: "base64", media_type: img.mediaType, data } };
}

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function clip(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n… (обрізано, ${text.length} символів)`
    : text;
}

/** Виконує один `tool_use`: невідомий інструмент, невалідний вхід і виняток — `is_error`, цикл іде далі. */
async function runToolUse(
  tools: readonly AgentTool[],
  use: Anthropic.ToolUseBlock,
  signal: AbortSignal | undefined,
): Promise<ToolResultBlockParam> {
  const base = { type: "tool_result" as const, tool_use_id: use.id };
  const tool = tools.find((t) => t.name === use.name);
  if (!tool) {
    return {
      ...base,
      is_error: true,
      content: `unknown tool ${use.name}; available: ${tools.map((t) => t.name).join(", ")}`,
    };
  }
  const parsed = tool.input.safeParse(use.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { ...base, is_error: true, content: `invalid input:\n${issues}` };
  }
  try {
    const out = await tool.run(parsed.data, signal);
    const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
    if (out.text?.trim()) content.push({ type: "text", text: clip(out.text) });
    for (const img of out.images ?? []) content.push(imageBlock(img));
    if (content.length === 0) content.push({ type: "text", text: "ok" });
    return { ...base, content };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { ...base, is_error: true, content: `tool failed: ${(err as Error).message ?? String(err)}` };
  }
}

/** Кількість зображень у `tool_result` історії. */
function countImages(messages: readonly MessageParam[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image") n++;
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content) if (c.type === "image") n++;
      }
    }
  }
  return n;
}

/** Замінює найстаріші зображення історії підписом, доки їх не лишиться `keep`. Змінює `messages`. */
export function pruneHistoryImages(messages: MessageParam[], keep: number): number {
  let excess = countImages(messages) - keep;
  let pruned = 0;
  for (const m of messages) {
    if (excess <= 0) break;
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (excess <= 0) break;
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      b.content = b.content.map((c) => {
        if (c.type !== "image" || excess <= 0) return c;
        excess--;
        pruned++;
        return { type: "text", text: IMAGE_OMITTED };
      });
    }
  }
  return pruned;
}

/** Копія повідомлень з `cache_control` на останньому блоці останнього повідомлення (ковзний breakpoint). */
function withRollingBreakpoint(messages: readonly MessageParam[]): MessageParam[] {
  const out = messages.slice();
  const last = out.at(-1);
  if (!last || typeof last.content === "string" || last.content.length === 0) return out;
  const blocks = last.content.slice();
  const tail = blocks.at(-1) as ContentBlockParam;
  if (tail.type === "thinking" || tail.type === "redacted_thinking") return out;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as ContentBlockParam;
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

/** Дописує блоки в останнє (user) повідомлення історії. */
function appendToLastUser(messages: MessageParam[], blocks: ContentBlockParam[]): void {
  const prev = messages.at(-1) as MessageParam;
  const content =
    typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content;
  prev.content = [...content, ...blocks];
}

function budgetNote(iteration: number, maxIterations: number, tokens: number, tokenBudget: number): string {
  const left = Math.max(0, maxIterations - iteration);
  const share = tokens / tokenBudget;
  const base = `[budget] iteration ${iteration}/${maxIterations}, tokens ${Math.round(tokens / 1000)}k/${Math.round(tokenBudget / 1000)}k.`;
  if (left <= 3 || share >= 0.85) {
    return `${base} Almost out: make sure every scene has passing code, then call finish.`;
  }
  return base;
}

function abortedError(err: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || err instanceof Anthropic.APIUserAbortError;
}

export async function runAgent(
  runtime: AgentRuntime,
  name: string,
  vars: PromptVars,
  opts: LlmAgentOptions,
): Promise<LlmAgentResult> {
  const { client, prompts, cost, trace, logger } = runtime;
  const prompt = prompts.load(name, vars);
  trace?.notePrompt(prompt.name, prompt.hash);
  if (!prompt.system) throw new LlmError(`промпт ${name} порожній`, "prompt");
  if (opts.tools.length === 0) throw new LlmError(`${name}: агенту не передано інструментів`, "prompt");
  if (
    opts.taskBudget !== undefined &&
    !(Number.isInteger(opts.taskBudget) && opts.taskBudget >= MIN_TASK_BUDGET)
  ) {
    throw new LlmError(`${name}: taskBudget має бути цілим ≥ ${MIN_TASK_BUDGET}`, "prompt");
  }

  const model = opts.model ?? prompt.model;
  const effort = opts.effort ?? prompt.effort;
  const maxTokens = opts.maxTokens ?? prompt.maxTokens;
  const detail = opts.costDetail ?? name;
  const requestOptions: AnthropicRequestOptions = {
    signal: opts.signal,
    ...(opts.taskBudget !== undefined ? { headers: { "anthropic-beta": TASK_BUDGET_BETA } } : {}),
  };

  // Інструменти йдуть першими в префіксі кешу, тож їхній TTL — не коротший за системні.
  const ttl: CacheTtl = prompt.cacheTtl === "1h" || prompt.prefix?.cacheTtl === "1h" ? "1h" : prompt.cacheTtl;
  const tools: Anthropic.Tool[] = opts.tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: toolInputSchema(t.input),
    ...(i === opts.tools.length - 1 && prompt.cache ? { cache_control: cacheControl(ttl) } : {}),
  }));
  const system = systemBlocks(prompt);

  const firstUser = [prompt.user, opts.userText].filter((s): s is string => Boolean(s?.trim())).join("\n\n");
  const first: ContentBlockParam[] = [
    ...(prompt.userCached ? [{ type: "text" as const, text: prompt.userCached }] : []),
    ...(firstUser ? [{ type: "text" as const, text: firstUser }] : []),
  ];
  if (first.length === 0) throw new LlmError(`промпт ${name}: немає user-частини`, "prompt");
  const messages: MessageParam[] = [{ role: "user", content: first }];

  const costs: CostEvent[] = [];
  let iterations = 0;
  let calls = 0;
  let tokens = 0;
  let refusalRetried = false;
  let last: Anthropic.Message | null = null;
  let stoppedBy: LlmAgentResult["stoppedBy"] = "done";

  const usdNow = () => Math.round(costs.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6;

  const record = async (message: Pick<Anthropic.Message, "usage"> | undefined, exact: boolean) => {
    const units = usageToUnits(message?.usage);
    tokens += units.input + units.output + units.cacheWrite + units.cacheWrite1h + units.cacheRead;
    try {
      costs.push(
        await cost.record({
          provider: "anthropic",
          model,
          units,
          promptName: prompt.name,
          promptHash: prompt.hash,
          effort,
          attempt: calls,
          exact,
          detail: `${detail}:iter:${iterations + 1}`,
        }),
      );
    } catch (err) {
      logger.error("не вдалося записати витрати", { err: String(err), prompt: name });
    }
  };

  const callOnce = async (): Promise<Anthropic.Message> => {
    const taskBudget =
      opts.taskBudget !== undefined ? { task_budget: { type: "tokens", total: opts.taskBudget } } : {};
    const params: StreamParams = {
      model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      // task_budget — beta-поле (заголовок у requestOptions); типи не-beta SDK його не знають.
      output_config: { effort, ...taskBudget } as Anthropic.OutputConfig,
      system,
      tools,
      messages: withRollingBreakpoint(messages),
    };
    calls += 1;
    const s = client.messages.stream(params, requestOptions);
    try {
      const msg = await s.finalMessage();
      await record(msg, true);
      return msg;
    } catch (err) {
      const partial = s.currentMessage;
      if (partial?.usage) await record(partial, false);
      throw err;
    }
  };

  const callWithRetries = async (): Promise<Anthropic.Message> => {
    for (let retry = 0; ; retry++) {
      try {
        return await callOnce();
      } catch (err) {
        if (abortedError(err, opts.signal)) throw err;
        if (!isRetryableTransportError(err) || retry >= runtime.maxTransportRetries) {
          throw new LlmError(`${name}: помилка API: ${(err as Error).message}`, "api", costs, { cause: err });
        }
        const wait = 1000 * 2 ** retry;
        logger.warn("повтор виклику агента", {
          prompt: name,
          retry: retry + 1,
          waitMs: wait,
          err: String(err),
        });
        await runtime.sleep(wait);
      }
    }
  };

  for (;;) {
    if (opts.signal?.aborted) {
      stoppedBy = "signal";
      break;
    }
    let message: Anthropic.Message;
    try {
      message = await callWithRetries();
    } catch (err) {
      if (abortedError(err, opts.signal)) {
        stoppedBy = "signal";
        break;
      }
      throw err;
    }
    last = message;

    if (message.stop_reason === "refusal") {
      if (!refusalRetried) {
        refusalRetried = true;
        logger.warn("відмова моделі в циклі агента, повтор із пом'якшеним формулюванням", { prompt: name });
        // Відповідь-відмову в історію не кладемо: та сама розмова + пояснення в останньому user-повідомленні.
        appendToLastUser(messages, [{ type: "text", text: REFUSAL_RETRY_NOTE }]);
        continue;
      }
      throw new LlmError(`${name}: модель відмовилась виконати запит`, "refusal", costs);
    }

    const truncated = message.stop_reason === "max_tokens";
    // Обрізана відповідь: неповний tool_use не виконуємо, у history лишаємо тільки текст.
    const content = truncated ? message.content.filter((b) => b.type === "text") : message.content;
    const toolUses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0 && !truncated) {
      stoppedBy = "done";
      break;
    }

    iterations += 1;
    opts.onIteration?.({ iteration: iterations, tool: toolUses[0]?.name ?? null, usd: usdNow(), tokens });
    if (content.length > 0) messages.push({ role: "assistant", content: content as ContentBlockParam[] });

    const results: ContentBlockParam[] = [];
    try {
      for (const use of toolUses) results.push(await runToolUse(opts.tools, use, opts.signal));
    } catch (err) {
      if (abortedError(err, opts.signal)) {
        stoppedBy = "signal";
        break;
      }
      throw err;
    }
    if (truncated) results.push({ type: "text", text: MAX_TOKENS_NUDGE });
    results.push({
      type: "text",
      text: budgetNote(iterations, opts.maxIterations, tokens, opts.tokenBudget),
    });
    if (content.length === 0) appendToLastUser(messages, results);
    else messages.push({ role: "user", content: results });
    if (countImages(messages) > MAX_HISTORY_IMAGES) {
      const pruned = pruneHistoryImages(messages, KEEP_HISTORY_IMAGES);
      logger.info("агент: старі зображення прибрано з історії", { prompt: name, pruned });
    }

    if (tokens >= opts.tokenBudget) {
      stoppedBy = "budget";
      break;
    }
    if (iterations >= opts.maxIterations) {
      stoppedBy = "iterations";
      break;
    }
  }

  const text = last ? textOf(last.content) : "";
  const message =
    last ??
    ({
      id: "msg_agent_none",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Anthropic.Message);
  logger.info("агент завершив цикл", { prompt: name, iterations, stoppedBy, tokens, usd: usdNow() });
  return { text, message, prompt, costs, usd: usdNow(), iterations, stoppedBy };
}
