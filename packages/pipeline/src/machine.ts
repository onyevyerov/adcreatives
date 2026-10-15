import {
  type Button,
  type ChatEventInput,
  type ChatIntent,
  type Checkpoint,
  type CostStage,
  checkpointOf,
  type FactKind,
  type Format,
  intentHasEdits,
  isBusy,
  type Language,
  makeJobId,
  type NextStepResult,
  normalizeFormats,
  type PipelineCommand,
  type PipelineInput,
  type ProjectState,
  type ProjectStatus,
  projectPaths,
  readTuning,
  type StageDoneEvent,
  type StageJob,
  type StageName,
  type StageParamsMap,
  t,
} from "@adc/shared";
import { FORMAT_LABEL, formatsLabel, LANGUAGE_LABEL_UK, STAGE_LABEL_UK } from "./labels.ts";
import {
  branchOf,
  emptyPipe,
  type IoTask,
  isIoStage,
  type JobRecord,
  MAX_FIX_ROUNDS,
  type PipeState,
  type RevisionAt,
} from "./pipe.ts";

/**
 * Чиста машина станів оркестратора: `nextStep(state, input, ctx) → {state, pipe, jobs, events, effects}`.
 * Жодного I/O: усе, що треба прочитати зі сховища (бренд-кіт, claims, список завантажень),
 * драйвер кладе в `ctx`; усе, що треба зібрати з артефактів (картки чекпоінтів, витрати,
 * відповіді chat-reply), повертається як `effects` і виконується драйвером.
 */

export interface MachineState {
  project: ProjectState;
  /** `rev/<project.rev>/pipeline.json`. */
  pipe: PipeState;
}

/** Вхід машини: команда (для user_message — з розібраним наміром) або подія стадії. */
export type StepInput = PipelineInput & {
  /** Результат `chat-intent` для `user_message` на чекпоінті; null — розбір не вдався. */
  intent?: ChatIntent | null;
  /** Повідомлення, відкладені під час роботи (обробляються на чекпоінті; ніколи не затверджують). */
  deferred?: boolean;
};

export interface BrandSnapshot {
  language: Language;
  /** Скільки мовних версій має сайт (>1 — мову питаємо). */
  languageVersions: number;
  questions: Array<{ id: string; default: string }>;
}

export interface StepContext {
  /** ISO-час «зараз». */
  now: string;
  /** Поточний бренд-кіт (для затвердження чекпоінта 1). */
  brand?: BrandSnapshot | null;
  /** Непідтверджені твердження поточної ревізії (для затвердження чекпоінта 2). */
  unverifiedClaims?: Array<{ kind: FactKind; text: string }>;
  /** Ключі файлів у `uploads/` на момент `start`. */
  uploads?: string[];
  /**
   * `Tuning.speculativeRender` (драйвер читає `readTuning`): на вході в `awaiting_storyboard`
   * рендер кожного формату стартує до «Затвердити», а звичайний рендер потім його перевикористовує.
   */
  speculativeRender?: boolean;
  /**
   * `Tuning.qaMaxRounds`: скільки кіл QA → fix до чекпоінта 3 (0 — без фіксів після QA).
   * Не задано — `readTuning().qaMaxRounds` з env (`ADC_QA_MAX_ROUNDS`, дефолт 2); у ревізії, яку
   * писав агент (`author`), — не більше `AGENT_QA_MAX_ROUNDS`.
   */
  qaMaxRounds?: number;
  /**
   * `Tuning.generationMode` (драйвер читає `readTuning`): `agent` — сцени пише стадія `author`
   * (один агент пише, рендерить і дивиться) замість `codegen`. Не задано — `pipeline`.
   */
  generationMode?: GenerationMode;
}

export type GenerationMode = "pipeline" | "agent";

/** Кіл QA → fix після агента за замовчуванням: агент уже дивився свої кадри, QA — страховка. */
export const AGENT_QA_MAX_ROUNDS = 1;

export type Effect =
  /** Зібрати картку чекпоінта з артефактів і надіслати в чат. */
  | { type: "checkpoint"; checkpoint: Checkpoint; rev: number; changedScenes: string[] | null }
  /** Відповісти на питання клієнта через chat-reply. */
  | { type: "reply"; question: string }
  /** Подія `cost` після стадії. */
  | { type: "cost"; stage: CostStage; rev: number; durationMs: number }
  /** Видача: відео + постер кожного формату і розбивка витрат. */
  | { type: "delivery"; rev: number; formats: Format[] };

export interface StepResult extends NextStepResult {
  pipe: PipeState;
  effects: Effect[];
}

type RenderParams = StageParamsMap["render"];

/** Спекулятивний рендер: збій не міняє статус і не йде у failedJobs, успіх не робить видачу. */
function isSpeculative(job: JobRecord): boolean {
  return job.stage === "render" && (job.params as Partial<RenderParams>).speculative === true;
}

/** Мутабельна чернетка кроку: усі зміни — над копіями вхідного стану. */
class Draft {
  readonly project: ProjectState;
  pipe: PipeState;
  readonly jobs: StageJob[] = [];
  readonly events: ChatEventInput[] = [];
  readonly effects: Effect[] = [];

  constructor(
    state: MachineState,
    readonly ctx: StepContext,
  ) {
    this.project = structuredClone(state.project);
    this.pipe = structuredClone(state.pipe);
  }

  get status(): ProjectStatus {
    return this.project.status;
  }

  setStatus(status: ProjectStatus): void {
    const prev = this.project.status;
    if (prev === status) return;
    this.project.status = status;
    this.events.push({ type: "state", status, prev, rev: this.project.rev });
  }

  say(text: string, buttons?: Button[]): void {
    this.events.push({ type: "message", role: "assistant", text, ...(buttons ? { buttons } : {}) });
  }

  progress(stage: CostStage, label: string): void {
    this.events.push({ type: "progress", stage, label, done: null, total: null });
  }

  /** Ставить job стадії; attempt — порядковий номер запуску цієї стадії в ревізії. */
  enqueue<S extends StageName>(stage: S, params: StageParamsMap[S], suffix?: string): StageJob<S> {
    const key = suffix ? `${stage}:${suffix}` : stage;
    const attempt = (this.pipe.attempts[key] ?? 0) + 1;
    this.pipe.attempts[key] = attempt;
    const job: StageJob<S> = {
      jobId: makeJobId(this.project.id, stage, this.project.rev, attempt, suffix),
      projectId: this.project.id,
      rev: this.project.rev,
      stage,
      attempt,
      params,
    };
    this.jobs.push(job as StageJob);
    this.pipe.outstanding.push(job as unknown as JobRecord);
    return job;
  }

  hasOutstanding(pred: (j: JobRecord) => boolean): boolean {
    return this.pipe.outstanding.some(pred);
  }

  // ── IO-смуга: crawl і ingest ніколи не йдуть одночасно (обидві пишуть assets.json) ──

  ioBusy(): boolean {
    return this.hasOutstanding((j) => isIoStage(j.stage));
  }

  ioRequest(task: IoTask): void {
    if (this.ioBusy()) this.pipe.ioQueue.push(task);
    else this.ioStart(task);
  }

  ioStart(task: IoTask): void {
    if (task.stage === "crawl") this.enqueue("crawl", task.params);
    else this.enqueue("ingest", task.params);
  }

  ioNext(): void {
    if (this.ioBusy()) return;
    const next = this.pipe.ioQueue.shift();
    if (next) this.ioStart(next);
  }

  ioIdle(): boolean {
    return !this.ioBusy() && this.pipe.ioQueue.length === 0;
  }

  /** Нова ревізія: нова тека rev/<n>/ і новий pipeline.json (IO-смуга і завантаження переносяться). */
  newRevision(reason: "edit" | "restart", at: RevisionAt | null, instruction: string | null): void {
    const prevRev = this.project.rev;
    const n = prevRev + 1;
    this.project.rev = n;
    this.project.revisions.push({
      n,
      createdAt: this.ctx.now,
      basedOn: reason === "restart" ? null : prevRev,
      reason,
      at,
      instruction,
    });
    this.project.branches = { video: "idle", audio: "idle" };
    const old = this.pipe;
    this.pipe = {
      ...emptyPipe(),
      outstanding: old.outstanding.filter((j) => isIoStage(j.stage)),
      ioQueue: old.ioQueue,
      knownUploads: old.knownUploads,
      costSeen: old.costSeen,
      templateScenes: reason === "restart" ? [] : old.templateScenes,
    };
  }

  result(): StepResult {
    return {
      state: this.project,
      pipe: this.pipe,
      jobs: this.jobs,
      events: this.events,
      effects: this.effects,
    };
  }
}

function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function uploadKey(projectId: string, file: string): string {
  return file.includes("/") ? file : projectPaths(projectId).upload(file);
}

/** Стани, у яких user_message розбирається chat-intent (інакше — відкладається). */
export function needsIntent(project: ProjectState): boolean {
  if (checkpointOf(project.status) !== null || project.status === "delivered") return true;
  return project.status === "failed" && project.failure?.stage !== "crawl";
}

/** Стани, на яких обробляються відкладені повідомлення. */
export function acceptsPending(status: ProjectStatus): boolean {
  return checkpointOf(status) !== null || status === "delivered";
}

// ────────────────────────────── команди ──────────────────────────────

function onStart(d: Draft): void {
  if (d.status !== "intake") return; // повторний start — ігноруємо
  const { input } = d.project;
  d.setStatus("crawling");
  d.ioRequest({
    stage: "crawl",
    params: { url: input.kind === "site" ? input.url : null, manualText: input.manualText },
  });
  queuePhotos(d, d.ctx.uploads ?? []);
}

function queuePhotos(d: Draft, files: readonly string[]): number {
  const keys = uniq(files.map((f) => uploadKey(d.project.id, f))).filter(
    (k) => !d.pipe.knownUploads.includes(k),
  );
  if (keys.length === 0) return 0;
  d.pipe.knownUploads.push(...keys);
  d.ioRequest({ stage: "ingest", params: { files: keys } });
  return keys.length;
}

function onPhotosAdded(d: Draft, files: readonly string[]): void {
  const added = queuePhotos(d, files);
  if (added > 0 && d.status === "crawling" && d.pipe.ioQueue.some((t) => t.stage === "ingest")) {
    d.say(t("photosPending"));
  }
}

function onSetLogo(d: Draft, assetId: string): void {
  if (d.status !== "awaiting_brand") {
    if (isBusy(d.status)) d.say(t("busy"));
    else d.say(t("logoLocked"));
    return;
  }
  d.project.restartRequested = false;
  d.pipe.afterPatch = "brand";
  d.setStatus("brandkit");
  d.enqueue("brandkit-patch", { instruction: null, logoAssetId: assetId, facts: [] });
}

function onApprove(d: Draft, rev: number | null): void {
  const cp = checkpointOf(d.status);
  if (cp === null) return; // подвійний клік / застаріла кнопка — ігноруємо мовчки
  if (rev !== null && rev !== d.project.rev) {
    d.say(t("approveIgnored"));
    return;
  }
  d.project.restartRequested = false;
  if (cp === "brand") approveBrand(d);
  else if (cp === "script") approveScript(d);
  else approveStoryboard(d);
}

function approveBrand(d: Draft): void {
  const brand = d.ctx.brand ?? null;
  if (brand) {
    for (const q of brand.questions) {
      if (!(q.id in d.project.answers)) d.project.answers[q.id] = q.default;
    }
    d.project.language ??= brand.language;
  }
  d.setStatus("scripting");
  d.progress("storyboard", t("scriptProgress"));
  d.enqueue("storyboard", { durationSeconds: d.project.durationSeconds });
}

function approveScript(d: Draft): void {
  const claims = d.ctx.unverifiedClaims ?? [];
  d.setStatus("directing");
  if (claims.length > 0) {
    // «Затвердити» підтверджує непідтверджені твердження: вони стають фактами від клієнта.
    d.pipe.afterPatch = "script_facts";
    d.enqueue("brandkit-patch", { instruction: null, logoAssetId: null, facts: claims });
    return;
  }
  startDirecting(d, null, []);
}

/**
 * Відео- і аудіогілка ревізії. Сцени пише `codegen` або, в агентному режимі, `author` з тими самими
 * `sceneIds`/`instructions` (перша генерація — усі сцени, правка після стілів/видачі — підмножина).
 */
function startDirecting(
  d: Draft,
  sceneIds: string[] | null,
  instructions: Array<{ sceneId: string; instruction: string }>,
): void {
  const stage = d.ctx.generationMode === "agent" ? "author" : "codegen";
  d.project.branches = { video: "running", audio: "running" };
  d.pipe.videoPhase = "build";
  d.progress(stage, t("directingStarted"));
  d.enqueue(stage, { sceneIds, instructions });
  d.enqueue("audio", {});
}

/** Чи писав сцени цієї ревізії агент (стадія `author` уже ставилась у цій ревізії). */
function authoredByAgent(d: Draft): boolean {
  return (d.pipe.attempts.author ?? 0) > 0;
}

function approveStoryboard(d: Draft): void {
  d.setStatus("rendering");
  d.progress("render", t("renderStarted", { formats: formatsLabel(d.project.formats) }));
  for (const format of d.project.formats) {
    d.enqueue("render", { format } satisfies RenderParams, format);
  }
}

function onRetry(d: Draft): void {
  if (d.status !== "failed" || !d.project.failure) return;
  const failure = d.project.failure;
  const jobs = d.pipe.failedJobs;
  d.pipe.failedJobs = [];
  d.project.failure = null;
  d.setStatus(failure.resumeStatus);
  d.say(t("retryStarted"));
  for (const job of jobs) {
    const branch = branchOf(job.stage);
    if (branch) d.project.branches[branch] = "running";
    if (job.stage === "crawl" || job.stage === "ingest") {
      d.ioRequest({ stage: job.stage, params: job.params } as IoTask);
    } else if (job.stage === "render") {
      const params = job.params as RenderParams;
      d.enqueue("render", params, params.format);
    } else {
      d.enqueue(job.stage, job.params as never);
    }
  }
}

function requestRestart(d: Draft): void {
  d.project.restartRequested = true;
  d.say(t("restartConfirm"), ["restart_confirm"]);
}

function onRestartConfirmed(d: Draft): void {
  if (!d.project.restartRequested) return; // restart — лише після підтвердження кнопкою
  const p = d.project;
  d.newRevision("restart", null, null);
  p.restartRequested = false;
  p.answers = {};
  p.durationSeconds = null;
  p.language = null;
  p.failure = null;
  p.pendingMessages = [];
  p.branches = { video: "idle", audio: "idle" };
  d.setStatus("crawling");
  d.say(t("restarted"));
  d.ioRequest({
    stage: "crawl",
    params: { url: p.input.kind === "site" ? p.input.url : null, manualText: p.input.manualText },
  });
}

// ─────────────────────────── повідомлення клієнта ───────────────────────────

function onUserMessage(
  d: Draft,
  cmd: Extract<PipelineCommand, { type: "user_message" }>,
  intent: ChatIntent | null | undefined,
  deferred: boolean,
): void {
  const status = d.status;

  if (deferred) {
    // Відкладені повідомлення обробляються один раз — навіть якщо розбір не вдався.
    d.project.pendingMessages = [];
    d.say(t("pendingApplied"));
  }

  if (!deferred && (isBusy(status) || status === "intake")) {
    d.project.pendingMessages.push({
      id: cmd.messageId,
      text: cmd.text,
      receivedAt: cmd.issuedAt,
      receivedIn: status,
    });
    d.say(t("busy"));
    return;
  }

  if (status === "failed") {
    const failure = d.project.failure;
    if (failure?.stage === "crawl" && cmd.text.trim()) {
      // Сайт не відкрився — повідомлення клієнта стає описом бізнесу (ручний режим).
      d.project.input = { ...d.project.input, kind: "manual", manualText: cmd.text.trim() };
      d.project.failure = null;
      d.pipe.failedJobs = d.pipe.failedJobs.filter((j) => j.stage !== "crawl");
      d.setStatus("crawling");
      d.say(t("manualAccepted"));
      d.ioRequest({ stage: "crawl", params: { url: null, manualText: cmd.text.trim() } });
      return;
    }
    if (intent?.kind === "restart" && !intentHasEdits(intent)) {
      requestRestart(d);
      return;
    }
    d.project.pendingMessages.push({
      id: cmd.messageId,
      text: cmd.text,
      receivedAt: cmd.issuedAt,
      receivedIn: status,
    });
    d.say(t("failedHint"), ["retry"]);
    return;
  }

  if (!intent) {
    d.say(t("intentFailed"));
    return;
  }
  const before = d.events.length + d.jobs.length + d.effects.length;
  applyIntent(d, intent, cmd.text, deferred);
  // Нічого не змінилось і нічого не сказано — хай відповість chat-reply.
  if (d.events.length + d.jobs.length + d.effects.length === before) {
    d.effects.push({ type: "reply", question: cmd.text });
  }
}

/** Зберігає відповіді, формати, мову. Повертає людський перелік того, що записано. */
function applyAnswers(d: Draft, intent: ChatIntent): { saved: string[]; formatsChanged: boolean } {
  const p = d.project;
  const saved: string[] = [];
  let formatsChanged = false;
  for (const a of intent.answers) {
    if (!a.answer.trim()) continue;
    p.answers[a.questionId] = a.answer.trim();
    saved.push(`відповідь «${a.answer.trim()}»`);
  }
  if (intent.formats && intent.formats.length > 0) {
    const next = normalizeFormats(intent.formats);
    formatsChanged = next.join() !== p.formats.join();
    p.formats = next;
    saved.push(`формати ${next.map((f) => FORMAT_LABEL[f]).join(", ")}`);
  }
  if (intent.language) {
    p.language = intent.language;
    saved.push(`мова — ${LANGUAGE_LABEL_UK[intent.language]}`);
  }
  return { saved, formatsChanged };
}

function applyIntent(d: Draft, intent: ChatIntent, text: string, deferred: boolean): void {
  const p = d.project;
  const cp = checkpointOf(p.status);
  const atDelivered = p.status === "delivered";
  const hasEdits = intentHasEdits(intent);

  if (intent.kind === "restart" && !hasEdits) {
    requestRestart(d);
    return;
  }
  p.restartRequested = false;

  const { saved, formatsChanged } = applyAnswers(d, intent);
  const wantsApprove = intent.kind === "approve";
  // Змішане повідомлення ніколи не вважається затвердженням.
  if (wantsApprove && hasEdits) d.say(t("mixedMessageNotApproval"));
  const approve = wantsApprove && !hasEdits;
  if (approve && deferred) d.say(t("deferredApproveIgnored"));

  if (intent.kind === "question" || intent.question) {
    d.effects.push({ type: "reply", question: intent.question ?? text });
  } else if (intent.kind === "other" && !hasEdits && saved.length === 0) {
    d.effects.push({ type: "reply", question: text });
  }

  if (cp === "brand") {
    if (intent.durationSeconds !== null) {
      p.durationSeconds = intent.durationSeconds;
      saved.push(`тривалість ${intent.durationSeconds} с`);
    }
    if (intent.edits) {
      // Побажання до сценарію до його появи — зберігаємо як нотатку для storyboard.
      const prev = p.answers.notes;
      p.answers.notes = prev ? `${prev}\n${intent.edits}` : intent.edits;
      saved.push("побажання до сценарію");
    }
    if (intent.brandEdits || intent.facts.length > 0) {
      d.pipe.afterPatch = "brand";
      d.setStatus("brandkit");
      d.say(t("revisionStarted"));
      d.enqueue("brandkit-patch", {
        instruction: intent.brandEdits,
        logoAssetId: null,
        facts: intent.facts,
      });
      return;
    }
    if (approve && !deferred) {
      approveBrand(d);
      return;
    }
    if (saved.length > 0) d.say(t("answersSaved", { what: saved.join("; ") }));
    return;
  }

  if (cp === "script") {
    if (hasEdits) {
      startRevision(d, "script", text, intent);
      return;
    }
    if (approve && !deferred) {
      approveScript(d);
      return;
    }
    if (saved.length > 0) d.say(t("answersSaved", { what: saved.join("; ") }));
    return;
  }

  if (cp === "storyboard" || atDelivered) {
    // Після стілів зміна форматів — теж правка: потрібні стіли й перевірка нових форматів.
    if (hasEdits || formatsChanged) {
      startRevision(d, atDelivered ? "delivered" : "storyboard", text, intent);
      return;
    }
    if (approve && !deferred && cp === "storyboard") {
      approveStoryboard(d);
      return;
    }
    if (saved.length > 0) d.say(t("answersSaved", { what: saved.join("; ") }));
  }
}

function startRevision(d: Draft, at: RevisionAt, text: string, intent: ChatIntent): void {
  if (intent.durationSeconds !== null) d.project.durationSeconds = intent.durationSeconds;
  d.newRevision("edit", at, text);
  d.setStatus("revising");
  d.say(t("revisionStarted"));
  if (intent.brandEdits || intent.facts.length > 0) {
    // Числа, які клієнт сам написав, — одразу факти клієнта: спершу патч бренд-кіта, потім revise.
    d.pipe.afterPatch = "revise";
    d.pipe.pendingRevise = { text, at };
    d.enqueue("brandkit-patch", { instruction: intent.brandEdits, logoAssetId: null, facts: intent.facts });
    return;
  }
  d.enqueue("revise", { text, at });
}

// ───────────────────────────── події стадій ─────────────────────────────

function onStageEvent(d: Draft, ev: StageDoneEvent): void {
  const idx = d.pipe.outstanding.findIndex((j) => j.jobId === ev.jobId);
  if (idx < 0) return; // застаріла ревізія або подвійна подія — ігноруємо
  const [job] = d.pipe.outstanding.splice(idx, 1) as [JobRecord];
  d.effects.push({ type: "cost", stage: ev.stage, rev: ev.rev, durationMs: ev.durationMs });
  // Готовий mp4 перевикористає звичайний job після «Затвердити»; тут лише знімаємо job з обліку.
  if (isSpeculative(job)) return;

  if (ev.type === "stage_failed") {
    onStageFailed(d, job, ev);
    return;
  }

  const handlers: { [S in StageName]: (ev: StageDoneOk<S>) => void } = {
    crawl: (e) => onCrawlDone(d, e),
    ingest: (e) => onIngestDone(d, e),
    brandkit: (e) => onBrandkitDone(d, e),
    "brandkit-patch": (e) => onPatchDone(d, e),
    storyboard: () => onStoryboardDone(d),
    revise: (e) => onReviseDone(d, e),
    codegen: () => onCodegenDone(d),
    author: (e) => onAuthorDone(d, e),
    check: (e) => onCheckDone(d, e),
    fix: (e) => onFixDone(d, e, job),
    qa: (e) => onQaDone(d, e),
    // Крок 0: sfx і review ще не керують потоком — реальна логіка в блоці B4.
    sfx: () => {},
    review: () => {},
    audio: (e) => onAudioDone(d, e),
    render: () => onRenderDone(d),
  };
  (handlers[ev.stage] as (e: StageDoneEvent) => void)(ev);
}

type StageDoneOk<S extends StageName> = Extract<StageDoneEvent<S>, { type: "stage_done" }>;
type StageFailed = Extract<StageDoneEvent, { type: "stage_failed" }>;

function onStageFailed(d: Draft, job: JobRecord, ev: StageFailed): void {
  if (ev.stage === "ingest") {
    // Невдалі фото не зупиняють проєкт: пояснюємо і йдемо далі.
    d.say(ev.error.userMessage);
    d.ioNext();
    maybeStartBrandkit(d);
    return;
  }
  d.pipe.failedJobs.push(job);
  const branch = branchOf(ev.stage);
  if (branch) d.project.branches[branch] = "failed";
  if (ev.stage === "crawl") d.ioNext();

  if (d.status !== "failed") {
    d.project.failure = {
      stage: ev.stage,
      message: ev.error.message,
      userMessage: ev.error.userMessage,
      at: d.ctx.now,
      retryable: ev.error.retryable,
      resumeStatus: d.status,
    };
    d.setStatus("failed");
  }
  d.events.push({
    type: "error",
    stage: ev.stage,
    message: ev.error.userMessage,
    retryable: ev.error.retryable,
  });
  d.say(
    t("stageFailed", { stage: STAGE_LABEL_UK[ev.stage], reason: ev.error.userMessage }),
    ev.error.retryable ? ["retry"] : undefined,
  );
  if (ev.stage === "crawl" && !ev.error.retryable) d.say(t("manualModePrompt"));
}

function maybeStartBrandkit(d: Draft): void {
  if (d.status !== "crawling" || !d.ioIdle()) return;
  d.setStatus("brandkit");
  d.enqueue("brandkit", {});
}

function onCrawlDone(d: Draft, ev: StageDoneOk<"crawl">): void {
  if (ev.outputs.partial) d.say(t("crawlPartial"));
  d.ioNext();
  maybeStartBrandkit(d);
}

function onIngestDone(d: Draft, ev: StageDoneOk<"ingest">): void {
  d.ioNext();
  const count = ev.outputs.assetIds.length;
  if (count > 0) d.say(t("photosAdded", { count }));
  maybeStartBrandkit(d);
}

function onBrandkitDone(d: Draft, ev: StageDoneOk<"brandkit">): void {
  d.project.brandkitVersion = ev.outputs.version;
  if (d.status !== "brandkit") return;
  d.setStatus("awaiting_brand");
  d.effects.push({ type: "checkpoint", checkpoint: "brand", rev: d.project.rev, changedScenes: null });
}

function onPatchDone(d: Draft, ev: StageDoneOk<"brandkit-patch">): void {
  d.project.brandkitVersion = ev.outputs.version;
  const after = d.pipe.afterPatch;
  d.pipe.afterPatch = null;
  if (after === "script_facts") {
    if (d.status === "directing") startDirecting(d, null, []);
    return;
  }
  d.say(t("brandkitUpdated", { summary: ev.outputs.summary }));
  if (after === "revise") {
    const pending = d.pipe.pendingRevise;
    d.pipe.pendingRevise = null;
    if (pending) d.enqueue("revise", pending);
    return;
  }
  if (d.status === "brandkit") {
    d.setStatus("awaiting_brand");
    d.effects.push({ type: "checkpoint", checkpoint: "brand", rev: d.project.rev, changedScenes: null });
  }
}

function onStoryboardDone(d: Draft): void {
  if (d.status !== "scripting") return;
  d.setStatus("awaiting_script");
  d.effects.push({ type: "checkpoint", checkpoint: "script", rev: d.project.rev, changedScenes: null });
}

function currentRevisionAt(d: Draft): RevisionAt | null {
  const info = d.project.revisions.find((r) => r.n === d.project.rev);
  const at = info?.at ?? null;
  return at === "brand" ? null : at;
}

function onReviseDone(d: Draft, ev: StageDoneOk<"revise">): void {
  if (d.status !== "revising") return;
  const at = currentRevisionAt(d);
  if (at === "script" || at === null) {
    d.setStatus("awaiting_script");
    d.effects.push({ type: "checkpoint", checkpoint: "script", rev: d.project.rev, changedScenes: null });
    return;
  }
  // Після стілів/видачі — перегенеровуємо лише зачеплені сцени.
  const regen = uniq(ev.outputs.scenesToRegenerate);
  const instruction = d.project.revisions.find((r) => r.n === d.project.rev)?.instruction ?? "";
  d.pipe.templateScenes = d.pipe.templateScenes.filter((s) => !regen.includes(s));
  d.pipe.changedScenes = ev.outputs.durationChanged || regen.length === 0 ? null : regen;
  d.setStatus("directing");
  startDirecting(
    d,
    regen,
    regen.map((sceneId) => ({ sceneId, instruction })),
  );
}

function onCodegenDone(d: Draft): void {
  d.enqueue("check", { sceneIds: d.pipe.changedScenes });
}

/**
 * Після агента — `check` написаних ним сцен, далі як після codegen (check ↔ fix, QA як страховка).
 * Перша генерація (і правка зі зміною тривалості) перевіряє всі сцени, як після codegen.
 */
function onAuthorDone(d: Draft, ev: StageDoneOk<"author">): void {
  const written = uniq(ev.outputs.sceneIds);
  const scope = d.pipe.changedScenes === null || written.length === 0 ? null : written;
  d.enqueue("check", { sceneIds: scope });
}

function onCheckDone(d: Draft, ev: StageDoneOk<"check">): void {
  const pipe = d.pipe;
  const failed = uniq(ev.outputs.failedScenes).filter((s) => !pipe.templateScenes.includes(s));
  const toFix = failed.filter((s) => (pipe.fixRounds[s] ?? 0) < MAX_FIX_ROUNDS);
  const exhausted = failed.filter((s) => !toFix.includes(s));
  // Сцена, що не запрацювала після 2 кіл фіксів, замінюється на TemplateScene.
  if (exhausted.length > 0) pipe.templateScenes = uniq([...pipe.templateScenes, ...exhausted]);
  if (toFix.length > 0) {
    for (const s of toFix) pipe.fixRounds[s] = (pipe.fixRounds[s] ?? 0) + 1;
    d.enqueue("fix", { sceneIds: toFix, reason: "check" });
    return;
  }
  if (pipe.videoPhase === "qa_fix") {
    const scope = pipe.dirtyScenes.filter((s) => !pipe.templateScenes.includes(s));
    if (scope.length === 0) videoDone(d);
    else d.enqueue("qa", { sceneIds: scope });
    return;
  }
  d.enqueue("qa", { sceneIds: pipe.changedScenes });
}

function onFixDone(d: Draft, ev: StageDoneOk<"fix">, job: JobRecord): void {
  const requested = (job.params as StageParamsMap["fix"]).sceneIds;
  const fixed = ev.outputs.sceneIds.length > 0 ? ev.outputs.sceneIds : requested;
  d.enqueue("check", { sceneIds: uniq(fixed) });
}

function onQaDone(d: Draft, ev: StageDoneOk<"qa">): void {
  const pipe = d.pipe;
  const maxRounds =
    d.ctx.qaMaxRounds ??
    (authoredByAgent(d) ? Math.min(AGENT_QA_MAX_ROUNDS, readTuning().qaMaxRounds) : readTuning().qaMaxRounds);
  if (ev.outputs.verdict === "fix" && pipe.qaRounds < maxRounds) {
    // Наступні кола — лише по сценах, які щойно виправляли (QA бачив лише їх).
    const targets = uniq(ev.outputs.seriousScenes).filter(
      (s) =>
        !pipe.templateScenes.includes(s) && (pipe.videoPhase === "build" || pipe.dirtyScenes.includes(s)),
    );
    if (targets.length > 0) {
      pipe.qaRounds += 1;
      pipe.videoPhase = "qa_fix";
      pipe.dirtyScenes = targets;
      d.enqueue("fix", { sceneIds: targets, reason: "qa" });
      return;
    }
  }
  // Що лишилось після останнього кола — попередження на чекпоінті 3.
  videoDone(d);
}

function videoDone(d: Draft): void {
  d.project.branches.video = "done";
  maybeJoin(d);
}

function onAudioDone(d: Draft, ev: StageDoneOk<"audio">): void {
  // Від цього хешу залежить повторне використання треку в наступних ревізіях.
  d.project.audioPlanHash = ev.outputs.planHash;
  d.project.branches.audio = "done";
  maybeJoin(d);
}

function maybeJoin(d: Draft): void {
  const { branches } = d.project;
  if (d.status !== "directing" || branches.video !== "done" || branches.audio !== "done") return;
  if (d.hasOutstanding((j) => !isIoStage(j.stage)) || d.pipe.failedJobs.length > 0) return;
  d.setStatus("awaiting_storyboard");
  d.effects.push({
    type: "checkpoint",
    checkpoint: "storyboard",
    rev: d.project.rev,
    changedScenes: d.pipe.changedScenes,
  });
  if (d.ctx.speculativeRender) startSpeculativeRender(d);
}

/** Рендер до затвердження розкадровки (jobId із суфіксом `spec-<format>`). */
function startSpeculativeRender(d: Draft): void {
  for (const format of d.project.formats) {
    d.enqueue("render", { format, speculative: true } satisfies RenderParams, `spec-${format}`);
  }
}

function onRenderDone(d: Draft): void {
  if (d.status !== "rendering") return;
  const pending = (j: JobRecord) => j.stage === "render" && !isSpeculative(j);
  if (d.hasOutstanding(pending) || d.pipe.failedJobs.length > 0) return;
  const p = d.project;
  p.deliveredAt = d.ctx.now;
  p.firstDeliveredAt ??= d.ctx.now;
  // Усе, що далі, — правки після першої видачі.
  p.phase = "revision";
  d.setStatus("delivered");
  d.effects.push({ type: "delivery", rev: p.rev, formats: [...p.formats] });
}

// ───────────────────────────── точка входу ─────────────────────────────

export function nextStep(state: MachineState, input: StepInput, ctx: StepContext): StepResult {
  const d = new Draft(state, ctx);
  if (input.kind === "stage_event") {
    onStageEvent(d, input.event);
  } else {
    const cmd = input.command;
    switch (cmd.type) {
      case "start":
        onStart(d);
        break;
      case "user_message":
        onUserMessage(d, cmd, input.intent, input.deferred === true);
        break;
      case "approve":
        onApprove(d, cmd.rev);
        break;
      case "set_logo":
        onSetLogo(d, cmd.assetId);
        break;
      case "photos_added":
        onPhotosAdded(d, cmd.files);
        break;
      case "retry":
        onRetry(d);
        break;
      case "restart_confirmed":
        onRestartConfirmed(d);
        break;
    }
  }
  const changed =
    d.jobs.length > 0 ||
    d.events.length > 0 ||
    JSON.stringify(d.project) !== JSON.stringify(state.project) ||
    JSON.stringify(d.pipe) !== JSON.stringify(state.pipe);
  if (changed) d.project.updatedAt = ctx.now;
  return d.result();
}
