import type Anthropic from "@anthropic-ai/sdk";
import type { AnthropicLike } from "./client.ts";

/**
 * Мок клієнта Anthropic для unit-тестів усіх блоків.
 * Кожен виклик create/stream бере наступну відповідь із черги.
 */
export type MockReply =
  | {
      /** Текст відповіді або об'єкт (серіалізується в JSON). */
      text?: string;
      json?: unknown;
      stopReason?: Anthropic.StopReason;
      usage?: Partial<
        Pick<
          Anthropic.Usage,
          "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
        >
      >;
    }
  | { error: Error; partialUsage?: { input_tokens: number; output_tokens: number } };

type MockParams = Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageStreamParams;

export interface MockAnthropic extends AnthropicLike {
  /** Параметри кожного виклику по порядку. */
  calls: Array<{ method: "create" | "stream"; params: MockParams }>;
  /** Скільки відповідей лишилось у черзі. */
  remaining(): number;
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
    usage: {
      input_tokens: reply.usage?.input_tokens ?? 100,
      output_tokens: reply.usage?.output_tokens ?? 50,
      cache_creation_input_tokens: reply.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: reply.usage?.cache_read_input_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export function createMockAnthropic(
  replies: Array<MockReply | ((params: MockParams) => MockReply)>,
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
      async create(params) {
        calls.push({ method: "create", params });
        const reply = next(params);
        if ("error" in reply) throw reply.error;
        return toMessage(reply, params.model);
      },
      stream(params) {
        calls.push({ method: "stream", params });
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
