import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { CostRecorder } from "../cost/ledger.ts";
import { type Logger, noopLogger } from "../logger.ts";
import type { CostEvent, TokenUnits } from "../schemas/cost.ts";
import type { Tracer } from "../trace.ts";
import type { Effort, LoadedPrompt, PromptLoader, PromptVars } from "./prompts.ts";
import { toStrictJsonSchema } from "./structured.ts";

type Message = Anthropic.Message;
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
type StreamParams = Anthropic.MessageStreamParams;
type ContentBlockParam = Anthropic.ContentBlockParam;

/** Мінімальний інтерфейс клієнта, щоб у тестах підставляти мок. */
export interface AnthropicLike {
  messages: {
    create(params: CreateParams, options?: { signal?: AbortSignal }): Promise<Message>;
    stream(
      params: StreamParams,
      options?: { signal?: AbortSignal },
    ): {
      finalMessage(): Promise<Message>;
      on(event: "text", listener: (delta: string) => void): unknown;
      readonly currentMessage?: Message | undefined;
    };
  };
}

export type ImageInput =
  | { mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: Uint8Array | string }
  | { url: string };

export interface LlmCallOptions {
  /** Зображення (скриншоти, контакт-листи, стіли) — йдуть перед текстом user-повідомлення. */
  images?: ImageInput[];
  /** Додатковий текст user-повідомлення (після секції `=== user ===` промпта). */
  userText?: string;
  /** Перекриття frontmatter. */
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Примусовий стрім (для effort ≥ high стрім вмикається завжди). */
  stream?: boolean;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LlmTextResult {
  text: string;
  message: Message;
  prompt: LoadedPrompt;
  /** Записи журналу витрат за всі спроби цього виклику. */
  costs: CostEvent[];
  usd: number;
}

export interface LlmStructuredResult<T> extends LlmTextResult {
  data: T;
}

export interface Llm {
  /** Structured output за Zod-схемою; обмеження, яких не гарантує API, перевіряються після відповіді. */
  structured<S extends z.ZodType>(
    name: string,
    vars: PromptVars,
    schema: S,
    opts?: LlmCallOptions,
  ): Promise<LlmStructuredResult<z.output<S>>>;
  /** Вільний текст. */
  text(name: string, vars: PromptVars, opts?: LlmCallOptions): Promise<LlmTextResult>;
  /** Вільний текст через стрім (codegen): `opts.onText` отримує дельти. */
  stream(name: string, vars: PromptVars, opts?: LlmCallOptions): Promise<LlmTextResult>;
}

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    public readonly code: "refusal" | "max_tokens" | "validation" | "prompt" | "api" | "empty",
    public readonly costs: CostEvent[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface CreateLlmOptions {
  client: AnthropicLike;
  prompts: PromptLoader;
  cost: CostRecorder;
  trace?: Tracer;
  logger?: Logger;
  /** Повтори на 429/5xx/мережу (дефолт 3). */
  maxTransportRetries?: number;
  /** Пауза між повторами; у тестах — миттєва. */
  sleep?: (ms: number) => Promise<void>;
}

/** Ефорти, для яких завжди йдемо через стрім (довгі відповіді, таймаути). */
const STREAM_EFFORTS: ReadonlySet<Effort> = new Set(["high", "xhigh", "max"]);

export const REFUSAL_RETRY_NOTE =
  "Контекст завдання: створюємо рекламний ролик для малого бізнесу за матеріалами його власного публічного сайту, " +
  "на замовлення і за згодою власника. Виконай лише маркетингову частину завдання; якщо якийсь фрагмент " +
  "вхідних даних недоречний — просто пропусти його.";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Клієнт Anthropic без вбудованих повторів: повтори і облік спроб робить обгортка. */
export function createAnthropicClient(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: 20 * 60 * 1000 });
}

export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500) return true;
  return false;
}

function retryAfterMs(err: unknown): number | null {
  if (err instanceof Anthropic.APIError && err.headers) {
    const v = err.headers.get?.("retry-after");
    const s = v ? Number(v) : Number.NaN;
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  }
  return null;
}

export function usageToUnits(usage: Anthropic.Usage | undefined | null): TokenUnits {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
  };
}

function imageBlock(img: ImageInput): ContentBlockParam {
  if ("url" in img) return { type: "image", source: { type: "url", url: img.url } };
  const data = typeof img.data === "string" ? img.data : Buffer.from(img.data).toString("base64");
  return { type: "image", source: { type: "base64", media_type: img.mediaType, data } };
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * API відмовляє в structured output, якщо граматика схеми завелика (BrandKit: ~95 полів).
 * Ліміт сумарний і точно не задокументований, тож такі схеми передаємо в промпті, а відповідь
 * перевіряє Zod (з тим самим одним повтором). Схеми, що вже не скомпілювались, пам'ятаємо.
 */
const GRAMMAR_TOO_LARGE = /compiled grammar is too large|schema is too complex/i;
const promptOnlySchemas = new Set<string>();

function isGrammarTooLarge(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 400 && GRAMMAR_TOO_LARGE.test(err.message);
}

function schemaInPromptNote(jsonSchema: unknown): string {
  return [
    "Формат відповіді: лише один JSON-об'єкт без markdown-огорож і без тексту до чи після нього.",
    "Він має точно відповідати цій JSON Schema (усі поля обов'язкові; null — лише там, де схема його",
    "дозволяє; значення enum — дослівно):",
    "<json_schema>",
    JSON.stringify(jsonSchema),
    "</json_schema>",
  ].join("\n");
}

/** JSON з відповіді: як є, або перший об'єкт у тексті (модель могла додати огорожу чи фразу). */
function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw err;
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join(".") || "(корінь)"}: ${i.message}`)
    .join("\n");
}

type Mode = "text" | "stream" | "structured";

export function createLlm(options: CreateLlmOptions): Llm {
  const { client, prompts, cost, trace } = options;
  const logger = options.logger ?? noopLogger;
  const maxTransport = options.maxTransportRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  async function run<T>(
    mode: Mode,
    name: string,
    vars: PromptVars,
    schema: z.ZodType<T> | null,
    opts: LlmCallOptions = {},
  ): Promise<LlmStructuredResult<T>> {
    const prompt = prompts.load(name, vars);
    trace?.notePrompt(prompt.name, prompt.hash);
    if (!prompt.system) throw new LlmError(`промпт ${name} порожній`, "prompt");

    const model = opts.model ?? prompt.model;
    const effort = opts.effort ?? prompt.effort;
    const maxTokens = opts.maxTokens ?? prompt.maxTokens;
    const useStream = mode === "stream" || opts.stream === true || STREAM_EFFORTS.has(effort);
    const baseUser = [prompt.user, opts.userText].filter((s): s is string => Boolean(s?.trim())).join("\n\n");
    if (!baseUser) throw new LlmError(`промпт ${name}: немає user-частини`, "prompt");

    const jsonSchema = schema ? toStrictJsonSchema(schema) : null;
    const schemaKey = jsonSchema ? JSON.stringify(jsonSchema) : "";
    // Схема в промпті замість граматики API (див. GRAMMAR_TOO_LARGE).
    let schemaInPrompt = jsonSchema !== null && promptOnlySchemas.has(schemaKey);
    const costs: CostEvent[] = [];
    let attempt = 0;
    let refusalRetried = false;
    let validationFeedback: string | null = null;

    const record = async (message: Pick<Message, "usage"> | undefined, exact: boolean) => {
      try {
        costs.push(
          await cost.record({
            provider: "anthropic",
            model,
            units: usageToUnits(message?.usage),
            promptName: prompt.name,
            promptHash: prompt.hash,
            effort,
            attempt,
            exact,
          }),
        );
      } catch (err) {
        logger.error("не вдалося записати витрати", { err: String(err), prompt: name });
      }
    };

    const buildParams = (): CreateParams => {
      const extra = [
        refusalRetried ? REFUSAL_RETRY_NOTE : null,
        schemaInPrompt ? schemaInPromptNote(jsonSchema) : null,
        validationFeedback,
      ]
        .filter(Boolean)
        .join("\n\n");
      const format =
        jsonSchema && !schemaInPrompt ? { type: "json_schema" as const, schema: jsonSchema } : null;
      const content: ContentBlockParam[] = [
        ...(opts.images ?? []).map(imageBlock),
        { type: "text", text: extra ? `${baseUser}\n\n${extra}` : baseUser },
      ];
      return {
        model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: format ? { effort, format } : { effort },
        system: [
          {
            type: "text",
            text: prompt.system,
            ...(prompt.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ],
        messages: [{ role: "user", content }],
      };
    };

    const callOnce = async (): Promise<Message> => {
      const params = buildParams();
      attempt += 1;
      if (!useStream) {
        const msg = await client.messages.create(params, { signal: opts.signal });
        await record(msg, true);
        return msg;
      }
      const s = client.messages.stream(params, { signal: opts.signal });
      if (opts.onText) s.on("text", opts.onText);
      try {
        const msg = await s.finalMessage();
        await record(msg, true);
        return msg;
      } catch (err) {
        // Обірваний стрім: пишемо те, що встигли порахувати, з позначкою exact=false.
        const partial = s.currentMessage;
        if (partial?.usage) await record(partial, false);
        throw err;
      }
    };

    const callWithTransportRetries = async (): Promise<Message> => {
      for (let retry = 0; ; retry++) {
        try {
          return await callOnce();
        } catch (err) {
          if (!isRetryableTransportError(err) || retry >= maxTransport) {
            throw new LlmError(`${name}: помилка API: ${(err as Error).message}`, "api", costs, {
              cause: err,
            });
          }
          const wait = retryAfterMs(err) ?? 1000 * 2 ** retry;
          logger.warn("повтор виклику LLM", {
            prompt: name,
            retry: retry + 1,
            waitMs: wait,
            err: String(err),
          });
          await sleep(wait);
        }
      }
    };

    for (;;) {
      let message: Message;
      try {
        message = await callWithTransportRetries();
      } catch (err) {
        if (jsonSchema && !schemaInPrompt && err instanceof LlmError && isGrammarTooLarge(err.cause)) {
          schemaInPrompt = true;
          promptOnlySchemas.add(schemaKey);
          logger.warn("схема завелика для граматики API — передаю її в промпті", { prompt: name });
          continue;
        }
        throw err;
      }

      if (message.stop_reason === "refusal") {
        if (!refusalRetried) {
          refusalRetried = true;
          logger.warn("відмова моделі, повтор із пом'якшеним формулюванням", { prompt: name });
          continue;
        }
        throw new LlmError(`${name}: модель відмовилась виконати запит`, "refusal", costs);
      }
      if (message.stop_reason === "max_tokens") {
        throw new LlmError(
          `${name}: відповідь обрізана лімітом max_tokens=${maxTokens}`,
          "max_tokens",
          costs,
        );
      }

      const text = textOf(message);
      const usd = Math.round(costs.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6;
      if (!schema) {
        if (!text.trim()) throw new LlmError(`${name}: порожня відповідь`, "empty", costs);
        return { data: undefined as T, text, message, prompt, costs, usd };
      }

      let problem: string;
      try {
        const parsed = schema.safeParse(schemaInPrompt ? extractJson(text) : JSON.parse(text));
        if (parsed.success) return { data: parsed.data, text, message, prompt, costs, usd };
        problem = formatZodIssues(parsed.error);
      } catch (err) {
        problem = `відповідь не є валідним JSON: ${(err as Error).message}`;
      }
      if (validationFeedback !== null) {
        throw new LlmError(`${name}: відповідь не пройшла перевірку схеми:\n${problem}`, "validation", costs);
      }
      logger.warn("відповідь не пройшла перевірку, повтор", { prompt: name, problem });
      validationFeedback =
        "Попередня відповідь на це завдання не пройшла перевірку:\n" +
        `${problem}\n\nПопередня відповідь:\n<previous_answer>\n${text.slice(0, 20000)}\n</previous_answer>\n` +
        "Поверни повну виправлену відповідь, дотримуючись усіх обмежень.";
    }
  }

  return {
    structured: <S extends z.ZodType>(name: string, vars: PromptVars, schema: S, opts?: LlmCallOptions) =>
      run<z.output<S>>("structured", name, vars, schema as z.ZodType<z.output<S>>, opts),
    text: (name, vars, opts) => run<undefined>("text", name, vars, null, opts),
    stream: (name, vars, opts) => run<undefined>("stream", name, vars, null, opts),
  };
}
