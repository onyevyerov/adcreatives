import { z } from "zod";
import type { CostRecorder } from "./cost/ledger.ts";
import type { Emitter } from "./events/emit.ts";
import type { Llm } from "./llm/client.ts";
import type { PromptLoader } from "./llm/prompts.ts";
import type { Logger } from "./logger.ts";
import type { FactKind } from "./schemas/brandkit.ts";
import type { AudioProvider, Format, RunSource } from "./schemas/common.ts";
import type { CostPhase, StageName } from "./schemas/project.ts";
import type { QaReport } from "./schemas/qa.ts";
import type { FilmReview, ReviewIssue } from "./schemas/review.ts";
import type { Storage } from "./storage/Storage.ts";
import type { Tracer } from "./trace.ts";

/** Параметри job кожної стадії (лежать у `StageJob.params`, серіалізуються в JSON). */
export interface StageParamsMap {
  crawl: { url: string | null; manualText: string | null };
  ingest: { files: string[] };
  brandkit: Record<string, never>;
  "brandkit-patch": {
    /** Текстова правка клієнта для LLM; null — без LLM (лише лого/факти/відповіді). */
    instruction: string | null;
    logoAssetId: string | null;
    facts: Array<{ kind: FactKind; text: string }>;
  };
  storyboard: { durationSeconds: number | null };
  /** sceneIds = null — усі сцени (перша генерація). */
  codegen: { sceneIds: string[] | null; instructions: Array<{ sceneId: string; instruction: string }> };
  /** Агентний режим: ті самі sceneIds/instructions, що й codegen. */
  author: { sceneIds: string[] | null; instructions: Array<{ sceneId: string; instruction: string }> };
  check: { sceneIds: string[] | null };
  fix: { sceneIds: string[]; reason: "check" | "qa" | "review" };
  qa: { sceneIds: string[] | null };
  revise: { text: string; at: "script" | "storyboard" | "delivered" };
  /** sceneIds = null — усі сцени; instructions — з review (маршрут sfx). */
  sfx: { sceneIds: string[] | null; instructions: ReviewIssue[] };
  review: { round: number };
  /**
   * music — план + трек + прогрів семплів, без зведення; mix — зведення за sfx-plan;
   * full — як було (режим storyboard). Відсутнє поле = full. Відсутній провайдер = `readTuning()` у стадії.
   */
  audio: { phase?: "music" | "mix" | "full"; musicProvider?: AudioProvider; sfxProvider?: AudioProvider };
  /** speculative — рендер до затвердження розкадровки: збій не міняє статус, успіх не робить видачу. */
  render: { format: Format; speculative?: boolean };
}

/** Що стадія повертає оркестратору для рішень (окрім артефактів у сховищі). */
export interface StageOutputsMap {
  crawl: { mode: "site" | "manual"; partial: boolean; pages: number; photos: number };
  ingest: { assetIds: string[] };
  brandkit: { version: number };
  "brandkit-patch": { version: number; summary: string };
  storyboard: { unverifiedClaims: number; totalFrames: number };
  codegen: { sceneIds: string[]; guardRejected: string[] };
  author: {
    sceneIds: string[];
    iterations: number;
    renders: number;
    usd: number;
    stoppedBy: "done" | "budget" | "iterations" | "time";
  };
  check: { failedScenes: string[]; issueScenes: string[] };
  fix: { sceneIds: string[] };
  qa: { verdict: QaReport["verdict"]; seriousScenes: string[] };
  revise: { scenesToRegenerate: string[]; musicChanged: boolean; durationChanged: boolean };
  sfx: { sceneIds: string[]; changed: number; muted: number };
  review: { verdict: "pass" | "fix"; score: number; routes: FilmReview["routes"] };
  audio: { planHash: string; reusedMusic: boolean; mixed: boolean };
  render: { format: Format; out: string; durationMs: number };
}

/** `rev/<n>/renders/<format>.meta.json` — з якими входами зроблено mp4 формату. */
export const RenderMeta = z.object({ inputsHash: z.string().min(1) });
export type RenderMeta = z.infer<typeof RenderMeta>;

export type StageParams<S extends StageName = StageName> = StageParamsMap[S];
export type StageOutputs<S extends StageName = StageName> = StageOutputsMap[S];

export interface StageContext<S extends StageName = StageName> {
  projectId: string;
  rev: number;
  stage: S;
  attempt: number;
  jobId: string;
  phase: CostPhase;
  source: RunSource;
  params: StageParamsMap[S];
  storage: Storage;
  trace: Tracer;
  /** Запис витрат із уже заповненим контекстом (проєкт, ревізія, стадія, фаза). */
  cost: CostRecorder;
  /** Події в чат (прогрес, артефакти). */
  emit: Emitter;
  llm: Llm;
  prompts: PromptLoader;
  logger: Logger;
  signal?: AbortSignal;
}

export interface StageResult<S extends StageName = StageName> {
  /** Ключі створених/оновлених артефактів у сховищі. */
  artifacts: string[];
  outputs: StageOutputsMap[S];
  /** Артефакт скопійовано з попередньої ревізії за хешем входів. */
  reused?: boolean;
  inputsHash?: string;
}

export type Stage<S extends StageName = StageName> = (ctx: StageContext<S>) => Promise<StageResult<S>>;

/** Помилка стадії з поясненням для клієнта. Будь-яка інша помилка теж стає `stage_failed`. */
export class StageError extends Error {
  override name = "StageError";
  constructor(
    message: string,
    public readonly code: string,
    /** Простими словами, для чату. */
    public readonly userMessage: string,
    public readonly retryable = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
