import { z } from "zod";
import { BrandKitFile } from "./brandkit.ts";
import { ClaimsReport } from "./claims.ts";
import { Format, IsoDate } from "./common.ts";
import { Checkpoint, CostStage, ProjectStatus } from "./project.ts";
import { QaIssue } from "./qa.ts";
import { MusicBrief, Storyboard } from "./storyboard.ts";

/**
 * Події чату. Зберігаються в Redis Stream `events:<projectId>` (поле `data` = JSON),
 * у SSE відправляються як `event: <type>`, `id: <id запису стріму>`, `data: <JSON події>`.
 */

export const Button = z.enum(["approve", "edit", "retry", "restart_confirm"]);
export type Button = z.infer<typeof Button>;

export const MessageEvent = z.object({
  type: z.literal("message"),
  at: IsoDate,
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  /** Кнопки під повідомленням. */
  buttons: z.array(Button).optional(),
});

export const ProgressEvent = z.object({
  type: z.literal("progress"),
  at: IsoDate,
  stage: CostStage,
  /** «Сканую сайт… 7/25 сторінок». */
  label: z.string(),
  done: z.number().int().nullable(),
  total: z.number().int().nullable(),
});

const MediaRef = z.object({
  /** URL для браузера (/files/…). */
  url: z.string(),
});

export const BrandCheckpointPayload = z.object({
  checkpoint: z.literal("brand"),
  brandkit: BrandKitFile,
  logoCandidates: z.array(MediaRef.extend({ assetId: z.string() })),
  /** Посилання на мініатюри найкращих фото. */
  photos: z.array(MediaRef.extend({ assetId: z.string() })),
  formats: z.array(Format),
  /** Мовні версії сайту, якщо їх кілька — питаємо мову відео. */
  languageOptions: z.array(z.object({ lang: z.string(), url: z.string() })),
  /** Придатних фото менше трьох — просимо дозавантажити. */
  needMorePhotos: z.boolean(),
});

export const ScriptCheckpointPayload = z.object({
  checkpoint: z.literal("script"),
  storyboard: Storyboard,
  claims: ClaimsReport,
  thumbnails: z.array(MediaRef.extend({ assetId: z.string() })),
  musicBrief: MusicBrief,
  durationSeconds: z.number(),
});

export const StoryboardCheckpointPayload = z.object({
  checkpoint: z.literal("storyboard"),
  primaryFormat: Format,
  /** Стіли кожної сцени в основному форматі (2 кадри на сцену). */
  stills: z.array(MediaRef.extend({ sceneId: z.string(), variant: z.enum(["a", "b"]) })),
  /** Зведені аркуші інших форматів. */
  sheets: z.array(MediaRef.extend({ format: Format })),
  warnings: z.array(QaIssue),
  templateScenes: z.array(z.string()),
  music: MediaRef.nullable(),
  /** Лише змінені сцени (після правки). */
  changedScenes: z.array(z.string()).nullable(),
});

export const CheckpointPayload = z.discriminatedUnion("checkpoint", [
  BrandCheckpointPayload,
  ScriptCheckpointPayload,
  StoryboardCheckpointPayload,
]);
export type CheckpointPayload = z.infer<typeof CheckpointPayload>;

export const CheckpointEvent = z.object({
  type: z.literal("checkpoint"),
  at: IsoDate,
  rev: z.number().int(),
  checkpoint: Checkpoint,
  payload: CheckpointPayload,
});

export const ArtifactEvent = z.object({
  type: z.literal("artifact"),
  at: IsoDate,
  rev: z.number().int(),
  kind: z.enum(["video", "poster", "still", "sheet", "music", "brandkit", "storyboard"]),
  url: z.string(),
  format: Format.nullable(),
  sceneId: z.string().nullable(),
});

export const CostEventMsg = z.object({
  type: z.literal("cost"),
  at: IsoDate,
  totalUsd: z.number(),
  /** Витрати стадії, що щойно завершилась. */
  stage: CostStage.nullable(),
  stageUsd: z.number(),
  /** Розбивка за етапами — разом із готовим відео. */
  breakdown: z.array(z.object({ stage: z.string(), usd: z.number() })).optional(),
});

export const StateEvent = z.object({
  type: z.literal("state"),
  at: IsoDate,
  status: ProjectStatus,
  prev: ProjectStatus.nullable(),
  rev: z.number().int(),
});

export const ErrorEvent = z.object({
  type: z.literal("error"),
  at: IsoDate,
  stage: z.string().nullable(),
  /** Простими словами. */
  message: z.string(),
  retryable: z.boolean(),
});

export const ChatEvent = z.discriminatedUnion("type", [
  MessageEvent,
  ProgressEvent,
  CheckpointEvent,
  ArtifactEvent,
  CostEventMsg,
  StateEvent,
  ErrorEvent,
]);
export type ChatEvent = z.infer<typeof ChatEvent>;
export type ChatEventType = ChatEvent["type"];

/** Розподільна версія Omit для union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Подія без `at` — його ставить emitter. */
export type ChatEventInput = DistributiveOmit<ChatEvent, "at">;

/** Подія, прочитана зі стріму, з її ID (= SSE `id`). */
export interface StoredChatEvent {
  id: string;
  event: ChatEvent;
}
