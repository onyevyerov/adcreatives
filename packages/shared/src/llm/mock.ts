import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike, AnthropicRequestOptions } from "./client.ts";

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

function toMessage(reply: Exclude<MockReply, { error: Error }>, model: string): Anthropic.Message {
  const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: reply.stopReason ?? "end_turn",
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
            const block = msg.content[0];
            if (block?.type === "text") for (const l of listeners) l(block.text);
            return msg;
          },
        };
      },
    },
  };
}
