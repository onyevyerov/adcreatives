import type Anthropic from "@anthropic-ai/sdk";
import type {
  AgentTool,
  AnthropicLike,
  AnthropicRequestOptions,
  ImageInput,
  LlmAgentOptions,
  LlmAgentResult,
} from "./client.ts";
import type { LoadedPrompt, PromptLoader, PromptVars } from "./prompts.ts";

/**
 * Мок клієнта Anthropic для unit-тестів усіх блоків.
 * Кожен виклик create/stream бере наступну відповідь із черги. Запит з `max_tokens: 0` (прогрів
 * кешу, `llm.warm`) черги не споживає: повертає порожній content з `MockOptions.warmUsage`.
 */
export type MockReply =
  | {
      /** Текст відповіді або об'єкт (серіалізується в JSON). */
      text?: string;
      json?: unknown;
      /** Виклики інструментів (блоки `tool_use` після тексту); stop_reason за замовчуванням — `tool_use`. */
      toolUses?: Array<{ id?: string; name: string; input: unknown }>;
      stopReason?: Anthropic.StopReason;
      usage?: MockUsage;
    }
  | { error: Error; partialUsage?: { input_tokens: number; output_tokens: number } };

export type MockUsage = Partial<
  Pick<
    Anthropic.Usage,
    | "input_tokens"
    | "output_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
    | "cache_creation"
  >
>;

type MockParams = Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageStreamParams;

export interface MockOptions {
  /** Usage відповіді на прогрів (`max_tokens: 0`); дефолт — 100 вхідних токенів, решта 0. */
  warmUsage?: MockUsage;
}

export interface MockAnthropic extends AnthropicLike {
  /** Параметри кожного виклику по порядку (разом із прогрівами `max_tokens: 0`). */
  calls: Array<{ method: "create" | "stream"; params: MockParams; options?: AnthropicRequestOptions }>;
  /** Скільки відповідей лишилось у черзі. */
  remaining(): number;
}

function toUsage(usage: MockUsage | undefined, outputDefault: number): Anthropic.Usage {
  return {
    input_tokens: usage?.input_tokens ?? 100,
    output_tokens: usage?.output_tokens ?? outputDefault,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    ...(usage?.cache_creation ? { cache_creation: usage.cache_creation } : {}),
  } as Anthropic.Usage;
}

let toolUseSeq = 0;

function toMessage(reply: Exclude<MockReply, { error: Error }>, model: string): Anthropic.Message {
  const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
  const toolUses = reply.toolUses ?? [];
  const content = [
    ...(text || !toolUses.length ? [{ type: "text", text, citations: null }] : []),
    ...toolUses.map((t) => ({
      type: "tool_use",
      id: t.id ?? `toolu_mock_${++toolUseSeq}`,
      name: t.name,
      input: t.input,
    })),
  ];
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reply.stopReason ?? (toolUses.length ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: toUsage(reply.usage, 50),
  } as unknown as Anthropic.Message;
}

function warmMessage(usage: MockUsage | undefined, model: string): Anthropic.Message {
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: "max_tokens",
    stop_sequence: null,
    usage: toUsage(usage, 0),
  } as unknown as Anthropic.Message;
}

export function createMockAnthropic(
  replies: Array<MockReply | ((params: MockParams) => MockReply)>,
  options: MockOptions = {},
): MockAnthropic {
  const queue = [...replies];
  const calls: MockAnthropic["calls"] = [];
  const next = (params: MockParams): MockReply => {
    const item = queue.shift();
    if (!item) throw new Error("MockAnthropic: черга відповідей порожня");
    return typeof item === "function" ? item(params) : item;
  };

  return {
    calls,
    remaining: () => queue.length,
    messages: {
      async create(params, opts) {
        calls.push({ method: "create", params, ...(opts ? { options: opts } : {}) });
        if (params.max_tokens === 0) return warmMessage(options.warmUsage, params.model);
        const reply = next(params);
        if ("error" in reply) throw reply.error;
        return toMessage(reply, params.model);
      },
      stream(params, opts) {
        calls.push({ method: "stream", params, ...(opts ? { options: opts } : {}) });
        const reply = next(params);
        const listeners: Array<(d: string) => void> = [];
        let current: Anthropic.Message | undefined;
        return {
          on(_event: "text", listener: (delta: string) => void) {
            listeners.push(listener);
            return this;
          },
          get currentMessage() {
            return current;
          },
          async finalMessage() {
            if ("error" in reply) {
              if (reply.partialUsage) current = toMessage({ usage: reply.partialUsage }, params.model);
              throw reply.error;
            }
            const msg = toMessage(reply, params.model);
            current = msg;
            for (const block of msg.content) {
              if (block.type === "text") for (const l of listeners) l(block.text);
            }
            return msg;
          },
        };
      },
    },
  };
}

/** Крок сценарію мок-агента: виклик інструмента або завершення з текстом. */
export type MockAgentStep =
  | {
      tool: string;
      input: unknown;
      /** Токени цієї ітерації (для бюджету); дефолт 1000. */
      tokens?: number;
      /** Вартість ітерації, $; дефолт 0. */
      usd?: number;
    }
  | { finish: string };

/** Виклик інструмента, зроблений мок-агентом, і що інструмент повернув. */
export interface MockAgentCall {
  iteration: number;
  tool: string;
  input: unknown;
  /** Текст результату (або помилка валідації / невідомий інструмент). */
  text: string | null;
  images: ImageInput[];
  isError: boolean;
}

export interface MockAgent {
  /** Підставляється замість `Llm.agent`: `ctx.llm = { ...ctx.llm, agent: mock.agent }`. */
  agent(name: string, vars: PromptVars, opts: LlmAgentOptions): Promise<LlmAgentResult>;
  /** Виклики інструментів по порядку (усі запуски `agent`). */
  calls: MockAgentCall[];
  /** Аргументи кожного запуску `agent`. */
  runs: Array<{ name: string; vars: PromptVars; opts: LlmAgentOptions }>;
}

export interface MockAgentOptions {
  /** Якщо задано — промпт реально рендериться (перевірка змінних), інакше в результаті заглушка. */
  prompts?: PromptLoader;
}

function stubPrompt(name: string): LoadedPrompt {
  return {
    name,
    system: "",
    user: null,
    userCached: null,
    model: "mock",
    effort: "high",
    maxTokens: 0,
    cache: false,
    cacheTtl: "5m",
    schemaMode: "grammar",
    prefix: null,
    hash: "mock",
  };
}

/**
 * Мок `Llm.agent` для тестів стадій: виконує задані сценарієм виклики інструментів через справжні
 * `opts.tools` (вхід перевіряється `tool.input`), рахує ітерації й токени і зупиняється так само,
 * як справжній цикл: `finish` → done, вичерпано `maxIterations` → iterations, `tokenBudget` → budget,
 * `opts.signal` → signal. Крок-функція бачить попередні виклики (напр. щоб виправити сцену після помилки).
 */
export function createMockAgent(
  script: Array<MockAgentStep | ((calls: readonly MockAgentCall[]) => MockAgentStep)>,
  options: MockAgentOptions = {},
): MockAgent {
  const queue = [...script];
  const calls: MockAgentCall[] = [];
  const runs: MockAgent["runs"] = [];

  async function agent(name: string, vars: PromptVars, opts: LlmAgentOptions): Promise<LlmAgentResult> {
    runs.push({ name, vars, opts });
    const prompt = options.prompts ? options.prompts.load(name, vars) : stubPrompt(name);
    let iterations = 0;
    let tokens = 0;
    let usd = 0;
    let text = "";
    let stoppedBy: LlmAgentResult["stoppedBy"] = "done";

    for (;;) {
      if (opts.signal?.aborted) {
        stoppedBy = "signal";
        break;
      }
      const item = queue.shift();
      if (!item) break;
      const step = typeof item === "function" ? item(calls) : item;
      if ("finish" in step) {
        text = step.finish;
        break;
      }
      if (iterations >= opts.maxIterations) {
        queue.unshift(step);
        stoppedBy = "iterations";
        break;
      }
      iterations += 1;
      tokens += step.tokens ?? 1000;
      usd += step.usd ?? 0;
      const call = await runTool(opts.tools, step, iterations, opts.signal);
      calls.push(call);
      opts.onIteration?.({ iteration: iterations, tool: step.tool, usd, tokens });
      if (tokens > opts.tokenBudget) {
        stoppedBy = "budget";
        break;
      }
    }

    const message = {
      id: `msg_mock_agent_${runs.length}`,
      type: "message",
      role: "assistant",
      model: prompt.model,
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: toUsage({ input_tokens: tokens, output_tokens: 0 }, 0),
    } as unknown as Anthropic.Message;
    return { text, message, prompt, costs: [], usd, iterations, stoppedBy };
  }

  return { agent, calls, runs };
}

async function runTool(
  tools: AgentTool[],
  step: { tool: string; input: unknown },
  iteration: number,
  signal: AbortSignal | undefined,
): Promise<MockAgentCall> {
  const base = { iteration, tool: step.tool, input: step.input };
  const tool = tools.find((t) => t.name === step.tool);
  if (!tool) return { ...base, text: `невідомий інструмент ${step.tool}`, images: [], isError: true };
  const parsed = tool.input.safeParse(step.input);
  if (!parsed.success) {
    return { ...base, text: `невалідний вхід: ${parsed.error.message}`, images: [], isError: true };
  }
  try {
    const out = await tool.run(parsed.data, signal);
    return { ...base, text: out.text ?? null, images: out.images ?? [], isError: false };
  } catch (err) {
    return { ...base, text: `помилка інструмента: ${(err as Error).message}`, images: [], isError: true };
  }
}
