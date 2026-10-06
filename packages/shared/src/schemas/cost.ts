import { z } from "zod";
import { Format, IsoDate, RunSource } from "./common.ts";
import { CostPhase, CostStage, ProjectStatus } from "./project.ts";

export const Provider = z.enum(["anthropic", "elevenlabs", "remotion"]);
export type Provider = z.infer<typeof Provider>;

export const TokenUnits = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
});
export type TokenUnits = z.infer<typeof TokenUnits>;

export const SecondsUnits = z.object({ seconds: z.number().min(0) });
export const RendersUnits = z.object({ renders: z.number().int().min(0) });

export const CostUnits = z.union([TokenUnits, SecondsUnits, RendersUnits]);
export type CostUnits = z.infer<typeof CostUnits>;

/** Один рядок `costs.jsonl` (до 4 КБ). */
export const CostEvent = z.object({
  ts: IsoDate,
  /** null — витрати поза проєктом (кеш SFX) → `costs-shared.jsonl`. */
  projectId: z.string().nullable(),
  rev: z.number().int().nullable(),
  stage: CostStage,
  phase: CostPhase,
  source: RunSource,
  provider: Provider,
  /** Модель Anthropic, model_id ElevenLabs або "remotion". */
  model: z.string(),
  promptName: z.string().nullable(),
  promptHash: z.string().nullable(),
  effort: z.string().nullable(),
  attempt: z.number().int().min(1),
  units: CostUnits,
  /** Знімок цін на момент виклику (USD за 1 млн токенів / хв / рендер). */
  unitPrices: z.record(z.string(), z.number()),
  usd: z.number().min(0),
  /** false — обсяг невідомий точно (обірваний стрім тощо). */
  exact: z.boolean(),
  /** Для музики/SFX/рендера: що саме (music, sfx:whoosh, render:vertical). */
  detail: z.string().nullable().optional(),
});
export type CostEvent = z.infer<typeof CostEvent>;

export const AnthropicModelPrice = z.object({
  input: z.number(),
  output: z.number(),
  /** Запис кешу 5 хв. */
  cacheWrite: z.number(),
  cacheRead: z.number(),
});

/** `config/prices.json`. Ціни Anthropic — USD за 1 млн токенів. */
export const Prices = z.object({
  checkedAt: z.string(),
  currency: z.literal("USD"),
  anthropic: z.record(z.string(), AnthropicModelPrice),
  elevenlabs: z.object({
    musicPerMinute: z.number(),
    sfxPerMinute: z.number(),
  }),
  remotion: z.object({ perRender: z.number() }),
  /** Фіксовані щомісячні витрати; заповнює замовник. */
  fixedMonthly: z.object({
    remotion: z.number().nullable(),
    elevenlabs: z.number().nullable(),
    server: z.number().nullable(),
  }),
});
export type Prices = z.infer<typeof Prices>;

/** Рядок таблиці `/stats` і `/api/stats.csv`. */
export const StatsRow = z.object({
  projectId: z.string(),
  createdAt: IsoDate,
  site: z.string(),
  status: ProjectStatus,
  source: RunSource,
  formats: z.array(Format),
  videoSeconds: z.number().nullable(),
  firstDeliveryUsd: z.number(),
  revisionUsd: z.number(),
  totalUsd: z.number(),
  revisionsCount: z.number().int(),
  fixesCount: z.number().int(),
  templateScenesCount: z.number().int(),
  /** Машинний час до першої видачі (сума тривалостей стадій), с. */
  machineSecondsToFirstDelivery: z.number().nullable(),
  delivered: z.boolean(),
  /** Дорожче за COST_TARGET_USD — лише позначка. */
  overTarget: z.boolean(),
  chatUrl: z.string(),
});
export type StatsRow = z.infer<typeof StatsRow>;

export const Distribution = z.object({
  count: z.number().int(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  p90: z.number().nullable(),
  max: z.number().nullable(),
});
export type Distribution = z.infer<typeof Distribution>;

export const StatsSummary = z.object({
  /** Усі витрати проєктів source=chat. */
  totalUsd: z.number(),
  deliveredCount: z.number().int(),
  /** На готове відео (totalUsd проєктів, що дійшли до видачі). */
  perDeliveredVideo: Distribution,
  /** Усі витрати / кількість готових відео (з урахуванням покинутих). */
  allInPerDelivered: z.number().nullable(),
  byStage: z.array(z.object({ stage: z.string(), usd: z.number() })),
  byProvider: z.array(z.object({ provider: z.string(), usd: z.number() })),
  bySource: z.object({ chat: z.number(), eval: z.number(), test: z.number() }),
  sharedUsd: z.number(),
  targetUsd: z.number(),
  /** Сума fixedMonthly, якщо заповнено. */
  fixedMonthlyUsd: z.number().nullable(),
});
export type StatsSummary = z.infer<typeof StatsSummary>;

export const StatsReport = z.object({
  generatedAt: IsoDate,
  rows: z.array(StatsRow),
  summary: StatsSummary,
});
export type StatsReport = z.infer<typeof StatsReport>;
