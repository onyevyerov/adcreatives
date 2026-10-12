import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { CostRecorder } from "../cost/ledger.ts";
import { type Logger, noopLogger } from "../logger.ts";
import type { CostEvent, TokenUnits } from "../schemas/cost.ts";
import type { Tracer } from "../trace.ts";
import { runAgent } from "./agent.ts";
import type { CacheTtl, Effort, LoadedPrompt, PromptLoader, PromptVars } from "./prompts.ts";
import { toStrictJsonSchema } from "./structured.ts";

type Message = Anthropic.Message;
type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
type StreamParams = Anthropic.MessageStreamParams;
type ContentBlockParam = Anthropic.ContentBlockParam;
type TextBlockParam = Anthropic.TextBlockParam;

/** Опції запиту, які передаємо клієнту (заголовки — для beta-функцій). */
export interface AnthropicRequestOptions {
  signal?: AbortSignal | undefined;
  headers?: Record<string, string>;
}

/** Мінімальний інтерфейс клієнта, щоб у тестах підставляти мок. */
export interface AnthropicLike {
  messages: {
    create(params: CreateParams, options?: AnthropicRequestOptions): Promise<Message>;
    stream(
      params: StreamParams,
      options?: AnthropicRequestOptions,
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
  /**
   * Beta task budgets (`output_config.task_budget`, заголовок `task-budgets-2026-03-13`), мінімум 20 000:
   * модель бачить зворотний відлік і розподіляє thinking і відповідь у межах бюджету.
   */
  taskBudget?: number;
  /** → `CostEvent.detail`, напр. "scene:s3". */
  costDetail?: string;
  /**
   * false — не ставити `cache_control` на userCached (префікс унікальний, запис кешу був би марним).
   * Дефолт true.
   */
  cacheUserPrefix?: boolean;
}

export type LlmWarmOptions = Pick<LlmCallOptions, "model" | "effort" | "signal" | "costDetail">;

export interface LlmWarmResult {
  usd: number;
  /** Записано в кеш на 5 хв. */
  cacheWrite: number;
  /** Записано в кеш на 1 год. */
  cacheWrite1h: number;
  cacheRead: number;
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

/** Інструмент агентного циклу (`Llm.agent`): модель викликає його через `tool_use`. */
export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  /** Схема входу: з неї будується `input_schema` інструмента, нею ж перевіряється вхід перед `run`. */
  input: z.ZodType<I>;
  /** Результат інструмента: текст і/або зображення, що йдуть у tool_result. */
  run(input: I, signal?: AbortSignal): Promise<{ text?: string; images?: ImageInput[] }>;
}

export interface LlmAgentOptions extends Omit<LlmCallOptions, "images" | "onText"> {
  tools: AgentTool[];
  maxIterations: number;
  /** Сумарні токени (input + output + cacheWrite + cacheRead) на весь цикл; при перевищенні — зупинка. */
  tokenBudget: number;
  onIteration?: (info: { iteration: number; tool: string | null; usd: number; tokens: number }) => void;
}

export interface LlmAgentResult extends LlmTextResult {
  iterations: number;
  stoppedBy: "done" | "budget" | "iterations" | "signal";
}

/** Залежності циклу з інструментами (`agent.ts`) — ті самі, що в `createLlm`, з розв'язаними дефолтами. */
export interface AgentRuntime {
  client: AnthropicLike;
  prompts: PromptLoader;
  cost: CostRecorder;
  trace?: Tracer | undefined;
  logger: Logger;
  maxTransportRetries: number;
  sleep: (ms: number) => Promise<void>;
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
  /**
   * Прогрів кешу: `max_tokens: 0`, без стріму й без output format; ті самі model / thinking / effort /
   * system / userCached, що й наступні виклики з тими самими name+vars+opts. Пише витрати
   * (`detail` — `opts.costDetail`, дефолт "warm").
   */
  warm(name: string, vars: PromptVars, opts?: LlmWarmOptions): Promise<LlmWarmResult>;
  /**
   * Цикл з інструментами (стадія `author`): модель викликає `opts.tools`, бачить їхні результати
   * (текст, зображення) і продовжує, доки не завершить сама або не вичерпає ітерації/токени.
   */
  agent(name: string, vars: PromptVars, opts: LlmAgentOptions): Promise<LlmAgentResult>;
}

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    public readonly code:
      | "refusal"
      | "max_tokens"
      | "validation"
      | "prompt"
      | "api"
      | "empty"
      | "agent_not_implemented",
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

/** Beta-заголовок task budgets і мінімальний бюджет. */
export const TASK_BUDGET_BETA = "task-budgets-2026-03-13";
export const MIN_TASK_BUDGET = 20_000;

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

/** Usage → одиниці обліку; запис кешу розбитий за TTL (`cacheWrite` — 5 хв, `cacheWrite1h` — 1 год). */
export function usageToUnits(usage: Anthropic.Usage | undefined | null): TokenUnits {
  const byTtl = usage?.cache_creation;
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheWrite: byTtl ? (byTtl.ephemeral_5m_input_tokens ?? 0) : (usage?.cache_creation_input_tokens ?? 0),
    cacheWrite1h: byTtl?.ephemeral_1h_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
  };
}

function cacheControl(ttl: CacheTtl): Anthropic.CacheControlEphemeral {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** System: `[prefix? (свій TTL), stage (TTL промпта)]`. */
export function systemBlocks(prompt: LoadedPrompt): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];
  if (prompt.prefix) {
    blocks.push({
      type: "text",
      text: prompt.prefix.system,
      cache_control: cacheControl(prompt.prefix.cacheTtl),
    });
  }
  blocks.push({
    type: "text",
    text: prompt.system,
    ...(prompt.cache ? { cache_control: cacheControl(prompt.cacheTtl) } : {}),
  });
  return blocks;
}

/** Блок userCached (з `cache_control` 5 хв, якщо кеш промпта ввімкнено і виклик його не вимкнув). */
function userCachedBlock(prompt: LoadedPrompt, cacheUserPrefix: boolean | undefined): TextBlockParam | null {
  if (!prompt.userCached) return null;
  return {
    type: "text",
    text: prompt.userCached,
    ...(prompt.cache && cacheUserPrefix !== false ? { cache_control: cacheControl("5m") } : {}),
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
 * перевіряє Zod (з тим самим одним повтором). Схеми, що вже не скомпілювались, пам'ятаємо в пам'яті
 * процесу; промпт із відомо великою схемою краще позначити `schema_mode: prompt`.
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
    if (!baseUser && !prompt.userCached) throw new LlmError(`промпт ${name}: немає user-частини`, "prompt");
    if (
      opts.taskBudget !== undefined &&
      !(Number.isInteger(opts.taskBudget) && opts.taskBudget >= MIN_TASK_BUDGET)
    ) {
      throw new LlmError(`${name}: taskBudget має бути цілим ≥ ${MIN_TASK_BUDGET}`, "prompt");
    }
    const requestOptions: AnthropicRequestOptions = {
      signal: opts.signal,
      ...(opts.taskBudget !== undefined ? { headers: { "anthropic-beta": TASK_BUDGET_BETA } } : {}),
    };
    const cachedBlock = userCachedBlock(prompt, opts.cacheUserPrefix);

    const jsonSchema = schema ? toStrictJsonSchema(schema) : null;
    const schemaKey = jsonSchema ? JSON.stringify(jsonSchema) : "";
    // Схема в промпті замість граматики API: за frontmatter або після GRAMMAR_TOO_LARGE.
    let schemaInPrompt =
      jsonSchema !== null && (prompt.schemaMode === "prompt" || promptOnlySchemas.has(schemaKey));
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
            ...(opts.costDetail ? { detail: opts.costDetail } : {}),
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
      const tail = [baseUser, extra].filter(Boolean).join("\n\n");
      const content: ContentBlockParam[] = [
        ...(opts.images ?? []).map(imageBlock),
        ...(cachedBlock ? [cachedBlock] : []),
        ...(tail ? [{ type: "text" as const, text: tail }] : []),
      ];
      const taskBudget =
        opts.taskBudget !== undefined ? { task_budget: { type: "tokens", total: opts.taskBudget } } : {};
      return {
        model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        // task_budget — beta-поле (заголовок у requestOptions); типи не-beta SDK його не знають.
        output_config: { effort, ...(format ? { format } : {}), ...taskBudget } as Anthropic.OutputConfig,
        system: systemBlocks(prompt),
        messages: [{ role: "user", content }],
      };
    };

    const callOnce = async (): Promise<Message> => {
      const params = buildParams();
      attempt += 1;
      if (!useStream) {
        const msg = await client.messages.create(params, requestOptions);
        await record(msg, true);
        return msg;
      }
      const s = client.messages.stream(params, requestOptions);
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

  async function warm(name: string, vars: PromptVars, opts: LlmWarmOptions = {}): Promise<LlmWarmResult> {
    const prompt = prompts.load(name, vars);
    trace?.notePrompt(prompt.name, prompt.hash);
    const model = opts.model ?? prompt.model;
    const effort = opts.effort ?? prompt.effort;
    const cachedBlock = userCachedBlock(prompt, true);
    // Кеш пишеться до останнього breakpoint-а: userCached, а без нього — system. Хвіст потрібен
    // лише тоді, коли userCached немає (API не приймає порожнє повідомлення).
    const content: ContentBlockParam[] = cachedBlock
      ? [cachedBlock]
      : [{ type: "text", text: prompt.user?.trim() || "." }];
    // max_tokens: 0 API приймає лише без стріму і без output_config.format.
    const params: CreateParams = {
      model,
      max_tokens: 0,
      thinking: { type: "adaptive" },
      output_config: { effort },
      system: systemBlocks(prompt),
      messages: [{ role: "user", content }],
    };
    let attempt = 0;
    for (let retry = 0; ; retry++) {
      attempt += 1;
      try {
        const message = await client.messages.create(params, { signal: opts.signal });
        const units = usageToUnits(message.usage);
        let usd = 0;
        try {
          const event = await cost.record({
            provider: "anthropic",
            model,
            units,
            promptName: prompt.name,
            promptHash: prompt.hash,
            effort,
            attempt,
            exact: true,
            detail: opts.costDetail ?? "warm",
          });
          usd = event.usd;
        } catch (err) {
          logger.error("не вдалося записати витрати", { err: String(err), prompt: name });
        }
        return {
          usd,
          cacheWrite: units.cacheWrite,
          cacheWrite1h: units.cacheWrite1h,
          cacheRead: units.cacheRead,
        };
      } catch (err) {
        if (!isRetryableTransportError(err) || retry >= maxTransport) {
          throw new LlmError(`${name}: прогрів кешу: ${(err as Error).message}`, "api", [], { cause: err });
        }
        const wait = retryAfterMs(err) ?? 1000 * 2 ** retry;
        logger.warn("повтор прогріву кешу", {
          prompt: name,
          retry: retry + 1,
          waitMs: wait,
          err: String(err),
        });
        await sleep(wait);
      }
    }
  }

  return {
    structured: <S extends z.ZodType>(name: string, vars: PromptVars, schema: S, opts?: LlmCallOptions) =>
      run<z.output<S>>("structured", name, vars, schema as z.ZodType<z.output<S>>, opts),
    text: (name, vars, opts) => run<undefined>("text", name, vars, null, opts),
    stream: (name, vars, opts) => run<undefined>("stream", name, vars, null, opts),
    warm,
    agent: (name, vars, opts) =>
      runAgent(
        { client, prompts, cost, trace, logger, maxTransportRetries: maxTransport, sleep },
        name,
        vars,
        opts,
      ),
  };
}
