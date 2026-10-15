import {
  type AnthropicLike,
  type BrandKitFile,
  type ChatIntent,
  type CostPhase,
  createCostRecorder,
  createLlm,
  type Emitter,
  FilmReview,
  type Format,
  type Llm,
  type Logger,
  noopLogger,
  type PipelineCommand,
  type PipelineDriver,
  type Prices,
  ProjectState,
  type PromptLoader,
  projectLockKey,
  projectPaths,
  type Queue,
  type RunSource,
  readTuning,
  type StageDoneEvent,
  type Storage,
  type Tuning,
  t,
} from "@adc/shared";
import { parseIntent, replyToQuestion } from "./chat.ts";
import {
  buildBrandCheckpoint,
  buildCostEvent,
  buildDelivery,
  buildScriptCheckpoint,
  buildStageCostEvent,
  buildStoryboardCheckpoint,
  readBrandkit,
  readClaims,
  readStoryboard,
} from "./checkpoints.ts";
import { preparseIntent, readIntake } from "./intake.ts";
import { CLAIM_TO_FACT_KIND } from "./labels.ts";
import type { ProjectLock } from "./lock.ts";
import {
  acceptsPending,
  type Effect,
  type MachineState,
  needsIntent,
  nextStep,
  type StepContext,
  type StepInput,
  type StepResult,
} from "./machine.ts";
import { emptyPipe, PipeState } from "./pipe.ts";

/** Контекст витрат для викликів LLM самого оркестратора. */
export interface ChatLlmContext {
  projectId: string;
  rev: number;
  stage: "chat-intent" | "chat-reply";
  phase: CostPhase;
  source: RunSource;
}

export interface PipelineDriverDeps {
  storage: Storage;
  /** Черги стадій (BullMQ у проді, `MemoryQueue` у тестах). */
  queue: Queue;
  /** Блокування `lock:project:<id>` (`createRedisLock` у проді, `createMemoryLock` у тестах). */
  lock: ProjectLock;
  /** Emitter подій чату проєкту (`createEmitter(redis, projectId)` → Redis Stream `events:<id>`). */
  emitter: (projectId: string) => Emitter;
  /** LLM для `chat-intent`/`chat-reply` з журналом витрат цього проєкту (див. `createChatLlmFactory`). */
  llm: (ctx: ChatLlmContext) => Llm;
  logger?: Logger;
  now?: () => Date;
  /** Писати репліку клієнта в стрім (`role: "user"`). Дефолт false — це робить API. */
  echoUserMessages?: boolean;
  /**
   * Перемикачі (`speculativeRender`, `generationMode`, `sfxMode`, `filmReview`, `reviewMaxRounds`);
   * дефолт — `readTuning()` з env на кожен крок. Режими генерації і звуку читаються на кожен крок, тож
   * зміна `ADC_GENERATION_MODE`/`ADC_SFX_MODE` діє з наступного старту режисури (поточна ревізія
   * доходить тим самим шляхом: обробник `author` не залежить від env, режим звуку — у `pipe.sfxMode`).
   * Не задане поле — машина бере його з `readTuning()`.
   */
  tuning?: () => Pick<Tuning, "speculativeRender"> &
    Partial<Pick<Tuning, "generationMode" | "sfxMode" | "filmReview" | "reviewMaxRounds">>;
}

export interface PipelineDriverImpl extends PipelineDriver {
  /** Стан проєкту: project.json + pipeline.json поточної ревізії (null — проєкту немає). */
  load(projectId: string): Promise<MachineState | null>;
}

/** Фабрика LLM для оркестратора: витрати пишуться в `projects/<id>/costs.jsonl` зі stage chat-*. */
export function createChatLlmFactory(opts: {
  client: AnthropicLike;
  prompts: PromptLoader;
  storage: Storage;
  prices: Prices;
  logger?: Logger;
  now?: () => Date;
}): (ctx: ChatLlmContext) => Llm {
  return (ctx) =>
    createLlm({
      client: opts.client,
      prompts: opts.prompts,
      cost: createCostRecorder(opts.storage, opts.prices, { ...ctx, attempt: 1 }, opts.now),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
}

/**
 * Початковий `project.json` (стан `intake`). Його пише API при створенні проєкту
 * (або драйвер на `start`, якщо файлу ще немає); далі файл змінює лише оркестратор.
 */
export function createInitialProject(input: {
  id: string;
  url: string | null;
  manualText: string | null;
  origin?: RunSource;
  formats?: Format[];
  now?: Date;
}): ProjectState {
  const at = (input.now ?? new Date()).toISOString();
  return ProjectState.parse({
    id: input.id,
    createdAt: at,
    updatedAt: at,
    status: "intake",
    origin: input.origin ?? "chat",
    input: {
      kind: input.url ? "site" : "manual",
      url: input.url,
      manualText: input.manualText,
    },
    formats: input.formats && input.formats.length > 0 ? input.formats : ["vertical"],
    language: null,
    answers: {},
    durationSeconds: null,
    rev: 1,
    revisions: [{ n: 1, createdAt: at, basedOn: null, reason: "initial", at: null, instruction: null }],
    brandkitVersion: null,
    phase: "first_delivery",
    pendingMessages: [],
    branches: { video: "idle", audio: "idle" },
    audioPlanHash: null,
    failure: null,
    restartRequested: false,
    firstDeliveredAt: null,
    deliveredAt: null,
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPipelineDriver(deps: PipelineDriverDeps): PipelineDriverImpl {
  const { storage, queue, lock } = deps;
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? (() => new Date());
  const tuning = deps.tuning ?? (() => readTuning());

  async function load(projectId: string): Promise<MachineState | null> {
    const paths = projectPaths(projectId);
    if (!(await storage.exists(paths.project))) return null;
    const project = await storage.readJson(paths.project, (v) => ProjectState.parse(v));
    const pk = paths.rev(project.rev).pipeline;
    const pipe = (await storage.exists(pk))
      ? await storage.readJson(pk, (v) => PipeState.parse(v))
      : emptyPipe();
    return { project, pipe };
  }

  async function emitAll(projectId: string, events: StepResult["events"]): Promise<void> {
    if (events.length === 0) return;
    const emitter = deps.emitter(projectId);
    for (const ev of events) {
      try {
        await emitter.emit(ev);
      } catch (err) {
        logger.error("подію чату не записано", { projectId, type: ev.type, err: String(err) });
      }
    }
  }

  function llmFor(project: ProjectState, stage: ChatLlmContext["stage"]): Llm {
    return deps.llm({
      projectId: project.id,
      rev: project.rev,
      stage,
      phase: project.phase,
      source: project.origin,
    });
  }

  async function chatCostEvent(projectId: string, stage: "chat-intent" | "chat-reply", usd: number) {
    try {
      await emitAll(projectId, [await buildCostEvent(storage, projectId, stage, usd)]);
    } catch (err) {
      logger.warn("витрати не пораховано", { projectId, err: String(err) });
    }
  }

  /** Події `cost` для завершених стадій; курсор журналу оновлюється в res.pipe до запису стану. */
  async function stageCostEvents(res: StepResult): Promise<StepResult["events"]> {
    const out: StepResult["events"] = [];
    for (const effect of res.effects) {
      if (effect.type !== "cost") continue;
      const key = `${effect.stage}@${effect.rev}`;
      try {
        const { event, seen } = await buildStageCostEvent(
          storage,
          res.state.id,
          effect.stage,
          effect.rev,
          res.pipe.costSeen[key] ?? 0,
        );
        res.pipe.costSeen[key] = seen;
        out.push(event);
      } catch (err) {
        logger.warn("витрати не пораховано", { projectId: res.state.id, err: String(err) });
      }
    }
    return out;
  }

  /** Розбір репліки; null — LLM не впорався. */
  async function intentFor(state: MachineState, text: string, deferred: boolean): Promise<ChatIntent | null> {
    const { project } = state;
    const quick = preparseIntent(text);
    if (quick) return quick;
    try {
      const brand = project.brandkitVersion !== null ? await readBrandkit(storage, project) : null;
      const res = await parseIntent(llmFor(project, "chat-intent"), project, text, { brand, deferred });
      await chatCostEvent(project.id, "chat-intent", res.usd);
      return res.intent;
    } catch (err) {
      logger.warn("chat-intent не вдався", { projectId: project.id, err: String(err) });
      return null;
    }
  }

  /** Зауваження `review.json` для маршруту sfx; без файлу (чи зламаний) — порожньо, коло йде без інструкцій. */
  async function reviewIssues(ev: StageDoneEvent): Promise<StepContext["reviewIssues"]> {
    const key = projectPaths(ev.projectId).rev(ev.rev).review;
    try {
      if (!(await storage.exists(key))) return [];
      return (await storage.readJson(key, (v) => FilmReview.parse(v))).issues;
    } catch (err) {
      logger.warn("review.json не прочитано", { projectId: ev.projectId, err: String(err) });
      return [];
    }
  }

  async function buildContext(state: MachineState, input: StepInput): Promise<StepContext> {
    const ctx: StepContext = { now: now().toISOString() };
    const tun = tuning();
    if (tun.speculativeRender) ctx.speculativeRender = true;
    if (tun.generationMode === "agent") ctx.generationMode = "agent";
    if (tun.sfxMode !== undefined) ctx.sfxMode = tun.sfxMode;
    if (tun.filmReview !== undefined) ctx.filmReview = tun.filmReview;
    if (tun.reviewMaxRounds !== undefined) ctx.reviewMaxRounds = tun.reviewMaxRounds;
    if (input.kind === "stage_event") {
      const ev = input.event;
      if (ev.stage === "review" && ev.type === "stage_done") ctx.reviewIssues = await reviewIssues(ev);
      return ctx;
    }
    const { project } = state;
    const cmd = input.command;
    if (cmd.type === "start") {
      // Фото заявки (intake.json від API); без заявки — усе, що лежить в uploads/.
      const intake = await readIntake(storage, project.id);
      ctx.uploads = intake ? intake.photos : await storage.list(projectPaths(project.id).uploadsDir);
    }
    const mayApprove = cmd.type === "approve" || cmd.type === "user_message";
    if (mayApprove && project.status === "awaiting_brand") {
      const kit = await readBrandkit(storage, project);
      ctx.brand = kit
        ? {
            language: kit.identity.language,
            languageVersions: kit.languageVersions.length,
            questions: kit.questions.map((q) => ({ id: q.id, default: q.default })),
          }
        : null;
    }
    if (mayApprove && project.status === "awaiting_script") {
      const claims = await readClaims(storage, project);
      const seen = new Set<string>();
      ctx.unverifiedClaims = [];
      for (const c of claims?.unverified ?? []) {
        if (seen.has(c.text)) continue;
        seen.add(c.text);
        ctx.unverifiedClaims.push({ kind: CLAIM_TO_FACT_KIND[c.kind], text: c.text });
      }
    }
    return ctx;
  }

  async function runEffect(res: StepResult, effect: Effect): Promise<void> {
    const project = res.state;
    switch (effect.type) {
      case "cost":
        return; // пораховано в stageCostEvents до запису стану
      case "checkpoint": {
        let events: StepResult["events"];
        if (effect.checkpoint === "brand") events = await buildBrandCheckpoint(storage, project, effect.rev);
        else if (effect.checkpoint === "script")
          events = await buildScriptCheckpoint(storage, project, effect.rev, now().toISOString());
        else
          events = await buildStoryboardCheckpoint(storage, project, effect.rev, {
            templateScenes: res.pipe.templateScenes,
            changedScenes: effect.changedScenes,
          });
        await emitAll(project.id, events);
        return;
      }
      case "delivery":
        await emitAll(project.id, await buildDelivery(storage, project, effect.rev, effect.formats));
        return;
      case "reply": {
        let text: string;
        try {
          const brand: BrandKitFile | null = await readBrandkit(storage, project);
          const storyboard = await readStoryboard(storage, project);
          const reply = await replyToQuestion(llmFor(project, "chat-reply"), project, effect.question, {
            brand,
            storyboard,
          });
          text = reply.text;
          await chatCostEvent(project.id, "chat-reply", reply.usd);
        } catch (err) {
          logger.warn("chat-reply не вдався", { projectId: project.id, err: String(err) });
          text = t("replyFailed");
        }
        await emitAll(project.id, [{ type: "message", role: "assistant", text }]);
        return;
      }
    }
  }

  /** Один крок: контекст → nextStep → черги → запис стану → події → ефекти. */
  async function step(state: MachineState, input: StepInput): Promise<MachineState> {
    const ctx = await buildContext(state, input);
    const res = nextStep(state, input, ctx);
    const costEvents = await stageCostEvents(res);
    const unchanged =
      res.jobs.length === 0 && sameJson(res.state, state.project) && sameJson(res.pipe, state.pipe);
    if (!unchanged) {
      // Спершу черги (jobId ідемпотентні): якщо запис стану впаде, повтор команди дасть ті самі jobId.
      for (const job of res.jobs) await queue.enqueueStage(job);
      const paths = projectPaths(res.state.id);
      await storage.writeJson(paths.rev(res.state.rev).pipeline, res.pipe);
      await storage.writeJson(paths.project, res.state);
    }
    await emitAll(res.state.id, [...res.events, ...costEvents]);
    for (const effect of res.effects) {
      try {
        await runEffect(res, effect);
      } catch (err) {
        logger.error("ефект оркестратора не виконано", {
          projectId: res.state.id,
          effect: effect.type,
          err: String(err),
        });
        if (effect.type === "checkpoint" || effect.type === "delivery") {
          await emitAll(res.state.id, [
            { type: "error", stage: null, message: "Не вдалося показати результат кроку.", retryable: false },
          ]);
        }
      }
    }
    return { project: res.state, pipe: res.pipe };
  }

  /** Повідомлення, що прийшли під час роботи, — на найближчому чекпоінті (ніколи як затвердження). */
  async function drainPending(state: MachineState): Promise<MachineState> {
    let cur = state;
    for (let guard = 0; guard < 3; guard++) {
      const { project } = cur;
      if (!acceptsPending(project.status) || project.pendingMessages.length === 0) break;
      const msgs = project.pendingMessages;
      const first = msgs[0];
      if (!first) break;
      const text = msgs.map((m) => m.text).join("\n\n");
      const intent = await intentFor(cur, text, true);
      const command: PipelineCommand = {
        type: "user_message",
        projectId: project.id,
        commandId: `pending.${first.id}`,
        issuedAt: now().toISOString(),
        text,
        messageId: first.id,
      };
      cur = await step(cur, { kind: "command", command, intent, deferred: true });
    }
    return cur;
  }

  /** Створює project.json на `start`: з intake.json (контракт API), інакше з полів самої команди. */
  async function initFromStart(cmd: PipelineCommand): Promise<MachineState | null> {
    const intake = await readIntake(storage, cmd.projectId);
    if (intake) {
      const project = createInitialProject({
        id: cmd.projectId,
        url: intake.input.url,
        manualText: intake.input.manualText,
        origin: intake.origin,
        now: now(),
      });
      project.input = { ...intake.input };
      await storage.writeJson(projectPaths(cmd.projectId).project, project);
      return { project, pipe: emptyPipe() };
    }
    const extra = cmd as unknown as { url?: unknown; manualText?: unknown; origin?: unknown };
    const url = typeof extra.url === "string" && extra.url ? extra.url : null;
    const manualText = typeof extra.manualText === "string" && extra.manualText ? extra.manualText : null;
    if (!url && !manualText) return null;
    const origin = extra.origin === "eval" || extra.origin === "test" ? extra.origin : "chat";
    const project = createInitialProject({ id: cmd.projectId, url, manualText, origin, now: now() });
    await storage.writeJson(projectPaths(cmd.projectId).project, project);
    return { project, pipe: emptyPipe() };
  }

  return {
    load,

    async handleCommand(cmd) {
      await lock.withLock(projectLockKey(cmd.projectId), async () => {
        let state = await load(cmd.projectId);
        if (!state && cmd.type === "start") state = await initFromStart(cmd);
        if (!state) {
          logger.warn("команда для невідомого проєкту", { projectId: cmd.projectId, type: cmd.type });
          return;
        }
        let input: StepInput = { kind: "command", command: cmd };
        if (cmd.type === "user_message") {
          if (deps.echoUserMessages) {
            await emitAll(cmd.projectId, [{ type: "message", role: "user", text: cmd.text }]);
          }
          if (needsIntent(state.project)) {
            input = { ...input, intent: await intentFor(state, cmd.text, false) };
          }
        }
        state = await step(state, input);
        await drainPending(state);
      });
    },

    async onStageDone(event: StageDoneEvent) {
      await lock.withLock(projectLockKey(event.projectId), async () => {
        const state = await load(event.projectId);
        if (!state) {
          logger.warn("подія стадії для невідомого проєкту", {
            projectId: event.projectId,
            stage: event.stage,
          });
          return;
        }
        if (event.type === "stage_failed" && (event.stage === "sfx" || event.stage === "review")) {
          // Ці збої не зупиняють ревізію (машина йде далі без них) — лишаємо слід у журналі.
          logger.warn("стадію пропущено після збою", {
            projectId: event.projectId,
            stage: event.stage,
            rev: event.rev,
            code: event.error.code,
            err: event.error.message,
          });
        }
        const next = await step(state, { kind: "stage_event", event });
        await drainPending(next);
      });
    },
  };
}
