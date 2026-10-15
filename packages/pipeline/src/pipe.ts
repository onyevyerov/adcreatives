import { emptyCounters, PipelineCounters, ReviewIssue, StageName } from "@adc/shared";
import { z } from "zod";

/**
 * `rev/<n>/pipeline.json` — стан оркестратора для ревізії.
 *
 * Верхній рівень сумісний із `PipelineCounters` зі shared (attempts, fixRounds, qaRounds,
 * templateScenes, dirtyScenes): воркер і стадії читають файл через `PipelineCounters.parse`
 * (зайві поля Zod відкидає). Решта полів — внутрішня бухгалтерія оркестратора.
 */

/** Максимум кіл фіксів компіляції/runtime на сцену. */
export const MAX_FIX_ROUNDS = 2;
// Кількість кіл QA → fix — `Tuning.qaMaxRounds` (env `ADC_QA_MAX_ROUNDS`), див. `StepContext.qaMaxRounds`.

/** Job, поставлений у чергу й ще не завершений (для відсіву застарілих/подвійних подій). */
export const JobRecord = z.object({
  jobId: z.string(),
  projectId: z.string(),
  rev: z.number().int(),
  stage: StageName,
  attempt: z.number().int(),
  params: z.record(z.string(), z.unknown()),
});
export type JobRecord = z.infer<typeof JobRecord>;

/**
 * Задача «IO-смуги»: `crawl` і `ingest` обидві переписують `crawl/assets.json`,
 * тож виконуються строго по одній.
 */
export const IoTask = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("crawl"),
    params: z.object({ url: z.string().nullable(), manualText: z.string().nullable() }),
  }),
  z.object({ stage: z.literal("ingest"), params: z.object({ files: z.array(z.string()) }) }),
]);
export type IoTask = z.infer<typeof IoTask>;

export const RevisionAt = z.enum(["script", "storyboard", "delivered"]);
export type RevisionAt = z.infer<typeof RevisionAt>;

export const PipeState = PipelineCounters.extend({
  /**
   * build — codegen (або author) → check ↔ fix → qa; qa_fix — коло фіксів після QA;
   * review_fix — коло за рецензентом: fix → check (без QA) → sfx → mix → review.
   */
  videoPhase: z.enum(["build", "qa_fix", "review_fix"]).default("build"),
  /**
   * Звук ревізії, зафіксований на старті режисури (`Tuning.sfxMode`): designer — audio{music} ∥ відео →
   * sfx → audio{mix} → review; storyboard — audio{full} ∥ відео, як до звукорежисера. Дефолт storyboard —
   * для pipeline.json ревізій, розпочатих до B4 (їхній audio вже поставлено без фази).
   */
  sfxMode: z.enum(["storyboard", "designer"]).default("storyboard"),
  /** audio{music} завершено (трек і план готові, можна зводити). */
  musicDone: z.boolean().default(false),
  /** Останній sfx ревізії завершено (або впав — тоді зведення за розкадровкою). */
  sfxDone: z.boolean().default(false),
  /** Що отримає sfx після зеленого check у колі рецензента (сцени і звукові зауваження). */
  pendingSfx: z
    .object({ sceneIds: z.array(z.string()), instructions: z.array(ReviewIssue) })
    .nullable()
    .default(null),
  /** Сцени, змінені правкою (check/qa лише по них; чекпоінт 3 показує їх). null — усі. */
  changedScenes: z.array(z.string()).nullable().default(null),
  outstanding: z.array(JobRecord).default([]),
  /** Job, що впали; «Спробувати ще раз» ставить їх повторно. */
  failedJobs: z.array(JobRecord).default([]),
  /** Черга IO-смуги (crawl/ingest), що чекає завершення поточної IO-задачі. */
  ioQueue: z.array(IoTask).default([]),
  /** Ключі фото клієнта, вже передані в ingest (захист від повторного ingest тих самих файлів). */
  knownUploads: z.array(z.string()).default([]),
  /** Що робити, коли завершиться `brandkit-patch`. */
  afterPatch: z.enum(["brand", "script_facts", "revise"]).nullable().default(null),
  /** Правка, що чекає на `brandkit-patch` (факти/бренд) перед `revise`. */
  pendingRevise: z.object({ text: z.string(), at: RevisionAt }).nullable().default(null),
  /** Курсор журналу витрат: `<stage>@<rev>` → скільки записів уже віднесено до подій `cost`. */
  costSeen: z.record(z.string(), z.number().int()).default({}),
});
export type PipeState = z.infer<typeof PipeState>;

export function emptyPipe(): PipeState {
  return PipeState.parse(emptyCounters());
}

export function isIoStage(stage: StageName): stage is "crawl" | "ingest" {
  return stage === "crawl" || stage === "ingest";
}

export const VIDEO_STAGES: readonly StageName[] = ["codegen", "author", "check", "fix", "qa"];

export function branchOf(stage: StageName): "video" | "audio" | null {
  if (stage === "audio") return "audio";
  return VIDEO_STAGES.includes(stage) ? "video" : null;
}
