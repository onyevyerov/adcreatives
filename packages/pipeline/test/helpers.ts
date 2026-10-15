import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ChatEvent,
  type ChatIntent,
  type ClaimsReport,
  type CostEvent,
  createMemoryEmitter,
  createMockAnthropic,
  createPromptLoader,
  type Emitter,
  FORMATS,
  type Format,
  LocalStorage,
  loadPrices,
  MemoryQueue,
  type MockReply,
  type PipelineCommand,
  projectPaths,
  type QaReport,
  type ReviewIssue,
  recordCost,
  type StageDoneEvent,
  type StageJob,
  type StageName,
  type StageOutputsMap,
  type Tuning,
} from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile, fixtureStoryboard } from "@adc/shared/fixtures";
import { createChatLlmFactory, createInitialProject, createPipelineDriver } from "../src/driver.ts";
import { intakeKey } from "../src/intake.ts";
import { createMemoryLock } from "../src/lock.ts";

export const PROMPTS_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "prompts");

/** Порожній розбір наміру + перекриття. */
export function intent(over: Partial<ChatIntent> = {}): ChatIntent {
  return {
    kind: "other",
    answers: [],
    formats: null,
    language: null,
    brandEdits: null,
    edits: null,
    facts: [],
    durationSeconds: null,
    question: null,
    ...over,
  };
}

type Outcome<S extends StageName> =
  | Partial<StageOutputsMap[S]>
  | { fail: { code?: string; userMessage?: string; retryable?: boolean } };

/** Поведінка фейкових стадій: функція від job і номера виклику цієї стадії. */
export type Behaviors = { [S in StageName]?: (job: StageJob<S>, n: number) => Outcome<S> | undefined };

export interface HarnessOptions {
  behaviors?: Behaviors;
  /** Непідтверджені твердження в claims.json сценарію. */
  unverified?: Array<{ sceneId: string; text: string; kind: "price" | "percent" }>;
  echoUserMessages?: boolean;
  /**
   * Перемикачі драйвера (`generationMode: "agent"` — сцени пише стадія author; `sfxMode`, `filmReview`,
   * `reviewMaxRounds` — звукорежисер і рецензент). Не задані поля машина бере з env.
   */
  tuning?: () => Pick<Tuning, "speculativeRender"> &
    Partial<Pick<Tuning, "generationMode" | "sfxMode" | "filmReview" | "reviewMaxRounds">>;
  /** Зауваження, які фейковий `review` пише в `review.json` (n — номер виклику стадії). */
  reviewIssues?: (n: number) => ReviewIssue[];
}

/**
 * Обв'язка сценарних тестів: справжній драйвер, LocalStorage у тимчасовій теці,
 * MemoryQueue, in-memory lock і emitter, мок Anthropic для chat-intent/chat-reply,
 * фейкові стадії, що пишуть мінімальні артефакти.
 */
export class Harness {
  readonly dir = mkdtempSync(path.join(tmpdir(), "adc-pipeline-"));
  readonly storage = new LocalStorage(this.dir);
  readonly queue = new MemoryQueue();
  readonly emitters = new Map<string, Emitter & { events: ChatEvent[] }>();
  readonly llmReplies: MockReply[] = [];
  clock = Date.parse("2026-10-06T10:00:00.000Z");
  readonly now = () => new Date(this.clock);
  readonly anthropic = createMockAnthropic(
    Array.from(
      { length: 500 },
      () => () => this.llmReplies.shift() ?? { error: new Error("немає відповіді") },
    ),
  );
  readonly driver;
  /** Індекс першого ще не виконаного job у queue.stages. */
  private done = new Set<string>();
  private calls: Partial<Record<StageName, number>> = {};
  /** Максимум одночасно «запущених» IO-задач (crawl/ingest), зафіксований за тест. */
  maxConcurrentIo = 0;
  readonly projectId = "p1";

  constructor(private readonly opts: HarnessOptions = {}) {
    this.driver = createPipelineDriver({
      storage: this.storage,
      queue: this.queue,
      lock: createMemoryLock(),
      emitter: (id) => this.emitter(id),
      llm: createChatLlmFactory({
        client: this.anthropic,
        prompts: createPromptLoader({ dir: PROMPTS_DIR, reload: false }),
        storage: this.storage,
        prices: loadPrices(),
        now: this.now,
      }),
      now: this.now,
      echoUserMessages: opts.echoUserMessages ?? false,
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
    });
  }

  emitter(id: string) {
    let e = this.emitters.get(id);
    if (!e) {
      e = createMemoryEmitter(this.now);
      this.emitters.set(id, e);
    }
    return e;
  }

  get events(): ChatEvent[] {
    return this.emitter(this.projectId).events;
  }

  eventsOf<T extends ChatEvent["type"]>(type: T): Array<Extract<ChatEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);
  }

  messages(): string[] {
    return this.eventsOf("message").map((m) => m.text);
  }

  checkpoints() {
    return this.eventsOf("checkpoint");
  }

  async project() {
    const s = await this.driver.load(this.projectId);
    if (!s) throw new Error("немає проєкту");
    return s;
  }

  base(): { projectId: string; commandId: string; issuedAt: string } {
    this.clock += 1000;
    return { projectId: this.projectId, commandId: `c${this.clock}`, issuedAt: this.now().toISOString() };
  }

  /** Те, що робить API на `POST /api/projects`: uploads/ + intake.json (без project.json). */
  async create(opts: { url?: string | null; manualText?: string | null; photos?: string[] } = {}) {
    const url = opts.url === undefined ? "https://zerno.example.com/" : opts.url;
    const photos = (opts.photos ?? []).map((p) => projectPaths(this.projectId).upload(p));
    for (const key of photos) await this.storage.write(key, "fake-image");
    await this.storage.writeJson(intakeKey(this.projectId), {
      projectId: this.projectId,
      createdAt: this.now().toISOString(),
      origin: "chat",
      input: { kind: url ? "site" : "manual", url, manualText: opts.manualText ?? null },
      photos,
      startCommandId: "c0",
    });
  }

  /** Альтернатива: project.json уже створено (createInitialProject). */
  async createProjectJson() {
    const project = createInitialProject({
      id: this.projectId,
      url: "https://zerno.example.com/",
      manualText: null,
      now: this.now(),
    });
    await this.storage.writeJson(projectPaths(this.projectId).project, project);
  }

  async command(cmd: PipelineCommand) {
    await this.driver.handleCommand(cmd);
    this.trackIo();
  }

  async start() {
    await this.command({ ...this.base(), type: "start" });
  }

  async approve(rev: number | null = null) {
    await this.command({ ...this.base(), type: "approve", rev });
  }

  async say(text: string, parsed?: ChatIntent | Error) {
    if (parsed instanceof Error) this.llmReplies.push({ error: parsed });
    else if (parsed) this.llmReplies.push({ json: parsed });
    const base = this.base();
    await this.command({ ...base, type: "user_message", text, messageId: `m${this.clock}` });
  }

  /** Невиконані job у порядку постановки. */
  pendingJobs(): StageJob[] {
    return this.queue.stages.filter((j) => !this.done.has(j.jobId));
  }

  jobsOf<S extends StageName>(stage: S): Array<StageJob<S>> {
    return this.queue.stages.filter((j): j is StageJob<S> => j.stage === stage);
  }

  private trackIo() {
    const running = this.pendingJobs().filter((j) => j.stage === "crawl" || j.stage === "ingest").length;
    this.maxConcurrentIo = Math.max(this.maxConcurrentIo, running);
  }

  /** Виконує перший невиконаний job (або першого з указаною стадією). */
  async runNext(stage?: StageName): Promise<StageJob | null> {
    const job = this.pendingJobs().find((j) => !stage || j.stage === stage);
    if (!job) return null;
    this.done.add(job.jobId);
    const n = (this.calls[job.stage] ?? 0) + 1;
    this.calls[job.stage] = n;
    this.clock += 2000;
    const event = await this.simulate(job, n);
    await this.driver.onStageDone(event);
    this.trackIo();
    return job;
  }

  /** Виконує job, поки вони є або поки не досягнуто стану. */
  async runUntilIdle(max = 100): Promise<void> {
    for (let i = 0; i < max; i++) {
      if (!(await this.runNext())) return;
    }
    throw new Error("забагато кроків");
  }

  /** Повторно надсилає подію вже виконаного job (подвійна доставка). */
  async redeliver(job: StageJob) {
    const event = await this.simulate(job, 1);
    await this.driver.onStageDone(event);
  }

  private async writeCost(job: StageJob, usd: number) {
    const event: CostEvent = {
      ts: this.now().toISOString(),
      projectId: job.projectId,
      rev: job.rev,
      stage: job.stage,
      phase: "first_delivery",
      source: "test",
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptName: job.stage,
      promptHash: "h",
      effort: "high",
      attempt: 1,
      units: { input: 1, output: 1, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
      unitPrices: {},
      usd,
      exact: true,
      detail: null,
    };
    await recordCost(this.storage, event);
  }

  private async simulate(job: StageJob, n: number): Promise<StageDoneEvent> {
    const behavior = this.opts.behaviors?.[job.stage] as
      | ((job: StageJob, n: number) => Outcome<StageName> | undefined)
      | undefined;
    const outcome = behavior?.(job, n);
    const common = {
      projectId: job.projectId,
      rev: job.rev,
      stage: job.stage,
      attempt: job.attempt,
      jobId: job.jobId,
      durationMs: 1000,
      ...(job.stage === "render" ? { format: (job.params as { format: Format }).format } : {}),
    };
    if (outcome && "fail" in outcome) {
      return {
        ...common,
        type: "stage_failed",
        error: {
          code: outcome.fail.code ?? "boom",
          message: "технічна помилка",
          userMessage: outcome.fail.userMessage ?? "Сервіс тимчасово недоступний.",
          retryable: outcome.fail.retryable ?? true,
        },
      } as StageDoneEvent;
    }
    await this.writeCost(job, 0.1);
    const outputs = { ...(await this.defaultOutputs(job, n)), ...(outcome ?? {}) };
    return { ...common, type: "stage_done", artifacts: [], outputs, reused: false } as StageDoneEvent;
  }

  private async defaultOutputs(job: StageJob, n: number): Promise<Record<string, unknown>> {
    const pp = projectPaths(job.projectId);
    const rp = pp.rev(job.rev);
    const s = this.storage;
    const state = await this.project();
    switch (job.stage) {
      case "crawl":
        await s.writeJson(pp.assets, fixtureAssets);
        return { mode: "site", partial: false, pages: 3, photos: 1 };
      case "ingest":
        return { assetIds: ["u01"] };
      case "brandkit":
        await s.writeJson(pp.brandkit(1), fixtureBrandKitFile);
        return { version: 1 };
      case "brandkit-patch": {
        const v = (state.project.brandkitVersion ?? 1) + 1;
        await s.writeJson(pp.brandkit(v), { ...fixtureBrandKitFile, version: v, origin: "patch" });
        return { version: v, summary: "колір змінено" };
      }
      case "storyboard":
      case "revise": {
        await s.writeJson(rp.storyboard, fixtureStoryboard);
        const claims: ClaimsReport = {
          checkedAt: this.now().toISOString(),
          brandkitVersion: 1,
          verified: [],
          unverified: (this.opts.unverified ?? []).map((u) => ({
            sceneId: u.sceneId,
            field: "headline",
            itemId: null,
            text: u.text,
            kind: u.kind,
            factId: null,
            matchedContact: false,
            matchedSite: false,
          })),
        };
        await s.writeJson(rp.claims, claims);
        if (job.stage === "storyboard")
          return { unverifiedClaims: claims.unverified.length, totalFrames: 450 };
        return { scenesToRegenerate: ["s2"], musicChanged: false, durationChanged: false };
      }
      case "codegen":
        return { sceneIds: ["s1", "s2", "s3"], guardRejected: [] };
      case "author":
        return { sceneIds: ["s1", "s2", "s3"], iterations: 1, renders: 0, usd: 0, stoppedBy: "done" };
      case "check": {
        const formats = state.project.formats;
        for (const f of FORMATS.filter((x) => formats.includes(x))) {
          for (const sc of fixtureStoryboard.scenes) {
            await s.write(rp.still(f, sc.id, "a"), "png");
            await s.write(rp.still(f, sc.id, "b"), "png");
          }
          await s.write(rp.sheet(f), "png");
        }
        return { failedScenes: [], issueScenes: [] };
      }
      case "fix":
        return { sceneIds: (job.params as { sceneIds: string[] }).sceneIds };
      case "qa": {
        const report: QaReport = {
          verdict: "pass",
          summary: "ok",
          issues: [
            {
              sceneId: "s1",
              format: "vertical",
              severity: "minor",
              kind: "low_contrast",
              description: "трохи блідий підзаголовок",
              fix: "темніший колір",
            },
          ],
        };
        await s.writeJson(rp.qa, report);
        return { verdict: "pass", seriousScenes: [] };
      }
      case "audio": {
        // Фаза music — без зведення (mixed: false); mix і full (без поля) — зі зведенням.
        const phase = (job.params as { phase?: string }).phase ?? "full";
        await s.write(rp.publicFile("music.mp3"), "mp3");
        await s.writeJson(rp.audio, {
          music: { src: "music.mp3", durationMs: 16000, fadeOutMs: 1000, volume: 0.8, planHash: "plan-1" },
          sfx: [],
          totalFrames: 450,
        });
        return { planHash: "plan-1", reusedMusic: false, mixed: phase !== "music" };
      }
      case "render": {
        const format = (job.params as { format: Format }).format;
        await s.write(rp.render(format), "mp4");
        await s.write(rp.poster, "png");
        return { format, out: rp.render(format), durationMs: 1000 };
      }
      case "sfx":
        return { sceneIds: [], changed: 0, muted: 0 };
      case "review": {
        const issues = this.opts.reviewIssues?.(n) ?? [];
        const round = (job.params as { round: number }).round;
        const routes = { fix: [], sfx: [], music: 0 };
        await s.writeJson(rp.review, {
          version: 1,
          round,
          inputsHash: `h${n}`,
          verdict: "pass",
          score: 8,
          issues,
          summary: "Цілісний ролик.",
          routes,
        });
        return { verdict: "pass", score: 8, routes };
      }
    }
  }
}
