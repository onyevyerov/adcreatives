import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  createChatLlmFactory,
  createInitialProject,
  createMemoryLock,
  createPipelineDriver,
  type PipelineDriverImpl,
} from "@adc/pipeline";
import {
  type AnthropicLike,
  ChatEvent,
  type ChatEventInput,
  createPromptLoader,
  type Emitter,
  type EnqueueOptions,
  type Format,
  IntakeFile,
  LocalStorage,
  type Logger,
  loadPrices,
  makeCommandJobId,
  noopLogger,
  type PipelineCommand,
  type PipelineJob,
  type Prices,
  ProjectState,
  type ProjectStatus,
  type PromptLoader,
  projectPaths,
  QUEUE_CONCURRENCY,
  QUEUE_NAMES,
  type Queue,
  type QueueName,
  type RunSource,
  STAGE_QUEUE,
  type StageJob,
  type StageName,
} from "@adc/shared";
import { createStageRegistry, handlePipelineJob, runStageJob, type StageRegistry } from "@adc/worker";

/**
 * In-process рантайм пайплайна: той самий оркестратор (B7), ті самі стадії (реєстр B8) і той самий
 * `runStageJob`, що й у воркері, але замість BullMQ/Redis — черга в пам'яті процесу, а замість
 * Redis Stream — події в пам'яті. На ньому працюють інтеграційний тест, `pnpm eval` і `scripts/cli.ts`.
 *
 * Порядок як у проді: кроки оркестратора виконуються строго по одному, а job стадій стартують лише
 * після того, як крок, що їх поставив, записав `project.json` (у проді між ними — мережа до Redis).
 */

/** Стадія, у межах якої зараз виконується код (моки LLM маршрутизують відповіді за нею). */
export interface StageScope {
  projectId: string;
  stage: StageName;
  rev: number;
  attempt: number;
}

const scope = new AsyncLocalStorage<StageScope>();

/** Поточна стадія (null — код оркестратора: chat-intent/chat-reply). */
export function currentStage(): StageScope | null {
  return scope.getStore() ?? null;
}

export type EventListener = (projectId: string, event: ChatEvent) => void;

/** Події чату проєктів у пам'яті (замість Redis Stream). */
export class MemoryEvents {
  private readonly byProject = new Map<string, ChatEvent[]>();
  private readonly listeners = new Set<EventListener>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(projectId: string): ChatEvent[] {
    return this.byProject.get(projectId) ?? [];
  }

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(projectId: string, input: ChatEventInput): string {
    const event = ChatEvent.parse({ ...input, at: this.now().toISOString() });
    let list = this.byProject.get(projectId);
    if (!list) {
      list = [];
      this.byProject.set(projectId, list);
    }
    list.push(event);
    const id = `${Date.now()}-${this.seq++}`;
    for (const l of this.listeners) l(projectId, event);
    return id;
  }

  emitter(projectId: string): Emitter {
    const emit = async (event: ChatEventInput) => this.append(projectId, event);
    return {
      emit,
      progress: (stage, label, done = null, total = null) =>
        emit({ type: "progress", stage, label, done, total }),
      message: (text, opts = {}) =>
        emit({
          type: "message",
          role: opts.role ?? "assistant",
          text,
          ...(opts.buttons ? { buttons: opts.buttons } : {}),
        }),
    };
  }
}

/** Помилка, яку в проді поглинув би BullMQ (job впав) — тут її видно тестам і eval. */
export interface HarnessError {
  where: "pipeline" | QueueName;
  jobId: string | null;
  error: string;
}

type Waiter = () => void;

/**
 * Черга в пам'яті з тим самим контрактом, що й `BullQueue`: ідемпотентність за jobId, ліміти
 * паралельності за `QUEUE_CONCURRENCY`, кроки оркестратора — послідовно.
 */
export class InProcessQueue implements Queue {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<QueueName, StageJob[]>();
  private readonly running = new Map<QueueName, number>();
  private readonly pipelineJobs: PipelineJob[] = [];
  private pipelineBusy = false;
  private closed = false;
  private idleWaiters: Waiter[] = [];
  private idlePromise: Promise<void> | null = null;
  readonly errors: HarnessError[] = [];
  /** Усі поставлені job стадій (для тестів і звітів). */
  readonly history: StageJob[] = [];
  /** Job, відкинуті фільтром (режим `--only` в eval). */
  readonly skipped: StageJob[] = [];

  constructor(
    private readonly handlers: {
      runStage: (queue: QueueName, job: StageJob) => Promise<void>;
      runPipeline: (job: PipelineJob) => Promise<void>;
      filter?: (job: StageJob) => boolean;
      concurrency?: Partial<Record<QueueName, number>>;
      logger?: Logger;
    },
  ) {
    for (const q of QUEUE_NAMES) {
      this.pending.set(q, []);
      this.running.set(q, 0);
    }
  }

  async enqueueStage(job: StageJob): Promise<void> {
    if (this.closed || this.seen.has(job.jobId)) return;
    this.seen.add(job.jobId);
    this.history.push(job);
    if (this.handlers.filter && !this.handlers.filter(job)) {
      this.skipped.push(job);
      return;
    }
    this.pending.get(STAGE_QUEUE[job.stage])?.push(job);
    // Старт — після поточного кроку оркестратора (див. pump).
    queueMicrotask(() => this.pump());
  }

  async enqueuePipeline(job: PipelineJob, opts: EnqueueOptions = {}): Promise<void> {
    if (this.closed) return;
    if (opts.jobId) {
      if (this.seen.has(opts.jobId)) return;
      this.seen.add(opts.jobId);
    }
    const run = () => {
      this.pipelineJobs.push(job);
      this.pump();
    };
    if (opts.delayMs) setTimeout(run, opts.delayMs).unref?.();
    else run();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Чи нічого не виконується і не чекає. */
  isIdle(): boolean {
    if (this.pipelineBusy || this.pipelineJobs.length > 0) return false;
    for (const q of QUEUE_NAMES) {
      if ((this.running.get(q) ?? 0) > 0 || (this.pending.get(q)?.length ?? 0) > 0) return false;
    }
    return true;
  }

  /** Резолвиться, коли черга спорожніла (усі кроки й стадії завершились). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    this.idlePromise ??= new Promise((resolve) => this.idleWaiters.push(resolve));
    return this.idlePromise;
  }

  private limit(queue: QueueName): number {
    return this.handlers.concurrency?.[queue] ?? QUEUE_CONCURRENCY[queue];
  }

  private pump(): void {
    if (!this.pipelineBusy) {
      const next = this.pipelineJobs.shift();
      if (next) {
        this.pipelineBusy = true;
        void this.handlers
          .runPipeline(next)
          .catch((err: unknown) => {
            const jobId =
              next.kind === "command"
                ? `cmd.${next.command.type}.${next.command.commandId}`
                : next.event.jobId;
            this.errors.push({ where: "pipeline", jobId, error: String(err) });
            this.handlers.logger?.error("крок оркестратора впав", { jobId, err: String(err) });
          })
          .finally(() => {
            this.pipelineBusy = false;
            this.pump();
          });
        return;
      }
      // Стадії стартують лише між кроками оркестратора — коли project.json уже записано.
      for (const q of QUEUE_NAMES) {
        const list = this.pending.get(q) ?? [];
        while (list.length > 0 && (this.running.get(q) ?? 0) < this.limit(q)) {
          const job = list.shift() as StageJob;
          this.running.set(q, (this.running.get(q) ?? 0) + 1);
          void this.handlers
            .runStage(q, job)
            .catch((err: unknown) => {
              this.errors.push({ where: q, jobId: job.jobId, error: String(err) });
              this.handlers.logger?.error("job стадії впав поза runStageJob", {
                jobId: job.jobId,
                err: String(err),
              });
            })
            .finally(() => {
              this.running.set(q, (this.running.get(q) ?? 1) - 1);
              this.pump();
            });
        }
      }
    }
    if (this.isIdle() && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      this.idlePromise = null;
      for (const w of waiters) w();
    }
  }
}

export interface HarnessOptions {
  /** Абсолютний шлях DATA_DIR цього прогону. */
  dataDir: string;
  /** Клієнт Anthropic для стадій (або лінива фабрика — ключ потрібен лише при реальному виклику). */
  anthropic: AnthropicLike | (() => AnthropicLike);
  /** Клієнт для chat-intent/chat-reply оркестратора; дефолт — той самий, що й для стадій. */
  chatAnthropic?: AnthropicLike | (() => AnthropicLike);
  /** Реєстр стадій; дефолт — справжній з `@adc/worker`. */
  registry?: StageRegistry;
  prices?: Prices;
  prompts?: PromptLoader;
  logger?: Logger;
  concurrency?: Partial<Record<QueueName, number>>;
  /** Які job стадій виконувати (решта відкидається). */
  filter?: (job: StageJob) => boolean;
  now?: () => Date;
}

export interface CreateProjectInput {
  url?: string | null;
  manualText?: string | null;
  /** Фото клієнта: ім'я файлу + байти (як multipart у API). */
  photos?: Array<{ name: string; data: Buffer | Uint8Array }>;
  origin?: RunSource;
  /** ID проєкту (дефолт — випадковий). */
  id?: string;
  /**
   * Тривалість ролика, с (15–30), заздалегідь — як eval-кейс із фіксованою тривалістю. У чаті її
   * називає власник реплікою (chat-intent); тут `project.json` пишеться одразу таким, яким його
   * створив би драйвер на `start`, плюс тривалість — без LLM. null/не задано — як зараз.
   */
  durationSeconds?: number | null;
}

export interface Harness {
  readonly storage: LocalStorage;
  readonly queue: InProcessQueue;
  readonly driver: PipelineDriverImpl;
  readonly events: MemoryEvents;
  /** Створює проєкт як API: uploads/ + intake.json + команда `start`. */
  createProject(input: CreateProjectInput): Promise<string>;
  /** Ставить команду оркестратору (commandId і issuedAt — автоматично). */
  command(projectId: string, command: CommandInput): Promise<void>;
  /** Репліка клієнта в чат (як `POST /messages`). */
  say(projectId: string, text: string): Promise<void>;
  /** Поточний статус з `project.json` (null — проєкту ще немає). */
  status(projectId: string): Promise<ProjectStatus | null>;
  /**
   * Чекає, поки проєкт дійде до одного зі статусів. Якщо черга спорожніла, а статус не той —
   * повертає поточний (пайплайн зупинився сам).
   */
  waitForStatus(
    projectId: string,
    statuses: readonly ProjectStatus[],
    timeoutMs?: number,
  ): Promise<ProjectStatus | null>;
  close(): Promise<void>;
}

/** Команда без службових полів. */
export type CommandInput = PipelineCommand extends infer C
  ? C extends PipelineCommand
    ? Omit<C, "projectId" | "commandId" | "issuedAt">
    : never
  : never;

export function newProjectId(): string {
  // Як nanoid: 21 символ з [A-Za-z0-9_-].
  return randomBytes(16).toString("base64url").slice(0, 21);
}

function safeFileName(name: string, index: number): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
  return `${String(index + 1).padStart(2, "0")}-${base || "photo"}`;
}

export function createHarness(options: HarnessOptions): Harness {
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const storage = new LocalStorage(options.dataDir);
  const prices = options.prices ?? loadPrices();
  const prompts = options.prompts ?? createPromptLoader();
  const registry = options.registry ?? createStageRegistry();
  const events = new MemoryEvents(now);
  let seq = 0;

  const resolveClient = (src: AnthropicLike | (() => AnthropicLike)): (() => AnthropicLike) => {
    if (typeof src !== "function") return () => src;
    let client: AnthropicLike | null = null;
    return () => {
      client ??= src();
      return client;
    };
  };
  const chatClient = resolveClient(options.chatAnthropic ?? options.anthropic);
  let chatLlm: ReturnType<typeof createChatLlmFactory> | null = null;

  // Драйвер і черга посилаються одне на одного — драйвер створюється після черги.
  let driver!: PipelineDriverImpl;
  const queue: InProcessQueue = new InProcessQueue({
    logger,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    runPipeline: (job) => handlePipelineJob(job, driver),
    runStage: async (queueName, job) => {
      await scope.run(
        { projectId: job.projectId, stage: job.stage, rev: job.rev, attempt: job.attempt },
        () =>
          runStageJob(queueName, job, {
            registry,
            queue,
            storage,
            prices,
            prompts,
            anthropic: options.anthropic,
            emitterFor: (projectId) => events.emitter(projectId),
            logger,
            now,
          }),
      );
    },
  });

  driver = createPipelineDriver({
    storage,
    queue,
    lock: createMemoryLock(),
    emitter: (projectId) => events.emitter(projectId),
    llm: (ctx) => {
      chatLlm ??= createChatLlmFactory({ client: chatClient(), prompts, storage, prices, logger, now });
      return chatLlm(ctx);
    },
    logger,
    now,
  });

  async function command(projectId: string, input: CommandInput): Promise<void> {
    const commandId = `h${Date.now().toString(36)}${(seq++).toString(36)}`;
    const cmd = { ...input, projectId, commandId, issuedAt: now().toISOString() } as PipelineCommand;
    await queue.enqueuePipeline(
      { kind: "command", command: cmd },
      { jobId: makeCommandJobId(projectId, commandId) },
    );
  }

  async function status(projectId: string): Promise<ProjectStatus | null> {
    const state = await driver.load(projectId);
    return state?.project.status ?? null;
  }

  return {
    storage,
    queue,
    driver,
    events,

    async createProject(input) {
      const id = input.id ?? newProjectId();
      const url = input.url?.trim() || null;
      const manualText = input.manualText?.trim() || null;
      if (!url && !manualText) throw new Error("createProject: потрібен url або manualText");
      const photos: string[] = [];
      for (const [i, photo] of (input.photos ?? []).entries()) {
        const key = projectPaths(id).upload(safeFileName(photo.name, i));
        await storage.write(key, Buffer.from(photo.data));
        photos.push(key);
      }
      const commandId = `start${(seq++).toString(36)}`;
      const createdAt = now().toISOString();
      const intake = IntakeFile.parse({
        projectId: id,
        createdAt,
        origin: input.origin ?? "chat",
        input: { kind: url ? "site" : "manual", url, manualText },
        photos,
        startCommandId: commandId,
      });
      await storage.writeJson(projectPaths(id).intake, intake);
      if (input.durationSeconds != null) {
        const initial = createInitialProject({
          id,
          url,
          manualText,
          origin: intake.origin,
          now: now(),
        });
        await storage.writeJson(
          projectPaths(id).project,
          ProjectState.parse({ ...initial, durationSeconds: input.durationSeconds }),
        );
      }
      events.append(id, {
        type: "message",
        role: "user",
        text: [url ?? manualText ?? "", photos.length > 0 ? `Фото: ${photos.length}` : ""]
          .filter(Boolean)
          .join("\n"),
      });
      await queue.enqueuePipeline(
        { kind: "command", command: { projectId: id, commandId, issuedAt: createdAt, type: "start" } },
        { jobId: makeCommandJobId(id, commandId) },
      );
      return id;
    },

    command,

    async say(projectId, text) {
      events.append(projectId, { type: "message", role: "user", text });
      await command(projectId, {
        type: "user_message",
        text,
        messageId: `m${Date.now().toString(36)}${seq++}`,
      });
    },

    status,

    async waitForStatus(projectId, statuses, timeoutMs = 60 * 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const current = await status(projectId);
        if (current && statuses.includes(current)) return current;
        if (Date.now() > deadline) {
          throw new Error(
            `проєкт ${projectId}: за ${Math.round(timeoutMs / 1000)} с не дійшов до ${statuses.join("|")} (зараз ${current})`,
          );
        }
        // Чекаємо на подію стану або на спорожнілу чергу (пайплайн зупинився, напр. на чекпоінті).
        const changed = await new Promise<"state" | "idle" | "tick">((resolve) => {
          let off: () => void = () => {};
          const timer = setTimeout(() => {
            off();
            resolve("tick");
          }, 1000);
          off = events.on((pid, ev) => {
            if (pid === projectId && ev.type === "state") {
              clearTimeout(timer);
              off();
              resolve("state");
            }
          });
          void queue.idle().then(() => {
            clearTimeout(timer);
            off();
            resolve("idle");
          });
        });
        if (changed === "idle") {
          // Дати автозатверджувачу поставити команду (він реагує на події синхронно, але асинхронно ставить).
          await new Promise((r) => setTimeout(r, 50));
          if (queue.isIdle()) return status(projectId);
        }
      }
    },

    async close() {
      await queue.idle();
      await queue.close();
    },
  };
}

// ───────────────────────────── автозатвердження ─────────────────────────────

export const FORMAT_LABEL: Record<Format, string> = { vertical: "9:16", square: "1:1", landscape: "16:9" };

export interface AutoApproveOptions {
  /** Формати, які обрати на чекпоінті 1 (null — лишити дефолт). */
  formats?: Format[] | null;
  /** Мова відео, якщо сайт має кілька мовних версій (null — дефолт бренд-кіта). */
  language?: "uk" | "en" | null;
  /** Обмежити проєктами (дефолт — усі). */
  projects?: (projectId: string) => boolean;
  /** Колбек для журналу: що й коли затверджено. */
  onApprove?: (projectId: string, checkpoint: string, rev: number) => void;
}

/**
 * Автоматично проходить чекпоінти: на першому — формати й мова службовою реплікою
 * (розбирається без LLM), далі «Затвердити» на кожному чекпоінті. Повертає функцію відписки.
 */
export function autoApprove(harness: Harness, options: AutoApproveOptions = {}): () => void {
  const handled = new Set<string>();
  return harness.events.on((projectId, event) => {
    if (event.type !== "checkpoint") return;
    if (options.projects && !options.projects(projectId)) return;
    const key = `${projectId}:${event.checkpoint}:${event.rev}:${event.at}`;
    if (handled.has(key)) return;
    handled.add(key);
    void (async () => {
      if (event.payload.checkpoint === "brand") {
        const lines: string[] = [];
        const formats = options.formats ?? null;
        if (formats && formats.length > 0 && formats.join() !== event.payload.formats.join()) {
          lines.push(`Формати: ${formats.map((f) => FORMAT_LABEL[f]).join(", ")}`);
        }
        if (options.language && event.payload.brandkit.languageVersions.length > 1) {
          lines.push(`Мова відео: ${options.language}`);
        }
        if (lines.length > 0) await harness.say(projectId, lines.join("\n"));
      }
      options.onApprove?.(projectId, event.checkpoint, event.rev);
      await harness.command(projectId, { type: "approve", rev: event.rev });
    })();
  });
}
