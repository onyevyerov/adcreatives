import { z } from "zod";
import { Format, IsoDate, Language, RunSource } from "./common.ts";

export const PROJECT_STATUSES = [
  "intake",
  "crawling",
  "brandkit",
  "awaiting_brand",
  "scripting",
  "awaiting_script",
  "directing",
  "awaiting_storyboard",
  "rendering",
  "delivered",
  "revising",
  "failed",
] as const;
export const ProjectStatus = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** Стани, у яких іде робота: повідомлення відкладаються до найближчого чекпоінта. */
export const BUSY_STATUSES: readonly ProjectStatus[] = [
  "crawling",
  "brandkit",
  "scripting",
  "directing",
  "rendering",
  "revising",
];

export const Checkpoint = z.enum(["brand", "script", "storyboard"]);
export type Checkpoint = z.infer<typeof Checkpoint>;

export const CHECKPOINT_STATUS: Record<Checkpoint, ProjectStatus> = {
  brand: "awaiting_brand",
  script: "awaiting_script",
  storyboard: "awaiting_storyboard",
};

export function isBusy(status: ProjectStatus): boolean {
  return BUSY_STATUSES.includes(status);
}

export function checkpointOf(status: ProjectStatus): Checkpoint | null {
  const entry = Object.entries(CHECKPOINT_STATUS).find(([, s]) => s === status);
  return entry ? (entry[0] as Checkpoint) : null;
}

/** Усі стадії пайплайна (назва = ключ у реєстрі воркера і в журналі витрат). */
export const STAGE_NAMES = [
  "crawl",
  "ingest",
  "brandkit",
  "brandkit-patch",
  "storyboard",
  "codegen",
  "check",
  "fix",
  "qa",
  "revise",
  "audio",
  "render",
] as const;
export const StageName = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageName>;

/**
 * Назви для записів витрат/трейсу, які не є стадіями воркера:
 * виклики оркестратора (chat-intent, chat-reply) і спільні задачі (sfx-cache).
 */
export const COST_STAGE_NAMES = [...STAGE_NAMES, "chat-intent", "chat-reply", "sfx-cache", "live"] as const;
export const CostStage = z.enum(COST_STAGE_NAMES);
export type CostStage = z.infer<typeof CostStage>;

export const CostPhase = z.enum(["first_delivery", "revision"]);
export type CostPhase = z.infer<typeof CostPhase>;

export const PendingMessage = z.object({
  id: z.string(),
  text: z.string(),
  receivedAt: IsoDate,
  /** Стан, у якому прийшло повідомлення. */
  receivedIn: ProjectStatus,
});
export type PendingMessage = z.infer<typeof PendingMessage>;

export const RevisionInfo = z.object({
  n: z.number().int().min(1),
  createdAt: IsoDate,
  /** Ревізія, від якої відгалужено (для пропуску стадій за хешем); null для першої. */
  basedOn: z.number().int().nullable(),
  reason: z.enum(["initial", "edit", "restart"]),
  /** На якому етапі прийшла правка: чекпоінт або після видачі. */
  at: z.enum(["brand", "script", "storyboard", "delivered"]).nullable(),
  /** Текст правки клієнта. */
  instruction: z.string().nullable(),
});
export type RevisionInfo = z.infer<typeof RevisionInfo>;

export const BranchStatus = z.enum(["idle", "running", "done", "failed"]);

export const ProjectFailure = z.object({
  stage: z.string(),
  /** Технічне повідомлення (для логів). */
  message: z.string(),
  /** Причина простими словами для чату. */
  userMessage: z.string(),
  at: IsoDate,
  retryable: z.boolean(),
  /** Стан, у який повертаємось після «Спробувати ще раз». */
  resumeStatus: ProjectStatus,
});
export type ProjectFailure = z.infer<typeof ProjectFailure>;

/**
 * `project.json`. Пише лише оркестратор (B7) під lock `lock:project:<id>`.
 * API і стадії тільки читають.
 */
export const ProjectState = z.object({
  id: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  status: ProjectStatus,
  origin: RunSource,
  input: z.object({
    kind: z.enum(["site", "manual"]),
    url: z.string().nullable(),
    manualText: z.string().nullable(),
  }),
  /** Обрані формати в канонічному порядку; дефолт — лише vertical. */
  formats: z.array(Format).min(1),
  /** Мова відео; null — ще не визначено (буде з бренд-кіта або з відповіді на чекпоінті 1). */
  language: Language.nullable(),
  /** Відповіді на питання чекпоінта 1: questionId → відповідь. */
  answers: z.record(z.string(), z.string()),
  /** Бажана тривалість від клієнта, с (15–30); null — обирає модель. */
  durationSeconds: z.number().int().min(15).max(30).nullable(),
  /** Поточна ревізія (rev/<n>/). */
  rev: z.number().int().min(1),
  revisions: z.array(RevisionInfo),
  /** Поточна версія brandkit/v<k>.json; null — ще немає. */
  brandkitVersion: z.number().int().nullable(),
  /** Фаза для обліку витрат: до першої видачі чи правки після неї. */
  phase: CostPhase,
  /** Повідомлення, що прийшли в зайнятому стані. */
  pendingMessages: z.array(PendingMessage),
  /** Гілки перед чекпоінтом 3: відео (codegen…qa) і аудіо. */
  branches: z.object({
    video: BranchStatus,
    audio: BranchStatus,
  }),
  /** Хеш аудіо-плану, чий трек використовується в поточній ревізії. */
  audioPlanHash: z.string().nullable(),
  failure: ProjectFailure.nullable(),
  /** Очікуємо підтвердження restart кнопкою. */
  restartRequested: z.boolean(),
  firstDeliveredAt: IsoDate.nullable(),
  deliveredAt: IsoDate.nullable(),
});
export type ProjectState = z.infer<typeof ProjectState>;

/** `rev/<n>/pipeline.json` — лічильники спроб ревізії (пише оркестратор). */
export const PipelineCounters = z.object({
  /** Спроби кожної стадії: stage → номер останньої спроби. */
  attempts: z.record(z.string(), z.number().int()),
  /** Кола фіксів компіляції/runtime по сценах (максимум 2). */
  fixRounds: z.record(z.string(), z.number().int()),
  /** Кола QA (максимум 1 коло фіксів після QA). */
  qaRounds: z.number().int(),
  /** Сцени, замінені на TemplateScene. */
  templateScenes: z.array(z.string()),
  /** Сцени, змінені в поточному колі (для check/qa лише по них). */
  dirtyScenes: z.array(z.string()),
});
export type PipelineCounters = z.infer<typeof PipelineCounters>;

export function emptyCounters(): PipelineCounters {
  return { attempts: {}, fixRounds: {}, qaRounds: 0, templateScenes: [], dirtyScenes: [] };
}

/** `rev/<n>/inputs.json` — хеші входів артефактів ревізії, для пропуску стадій. */
export const InputsManifest = z.object({
  artifacts: z.record(
    z.string(),
    z.object({
      /** Хеш входів (inputsHash). */
      hash: z.string(),
      stage: z.string(),
      createdAt: IsoDate,
      /** Скопійовано з попередньої ревізії замість перерахунку. */
      reusedFrom: z.number().int().nullable(),
    }),
  ),
});
export type InputsManifest = z.infer<typeof InputsManifest>;
