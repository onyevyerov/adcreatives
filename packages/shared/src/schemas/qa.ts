import { z } from "zod";
import { Format } from "./common.ts";

/** Префікс рядка в лозі браузера, який пишуть компоненти motion-kit у QA-режимі. */
export const QA_LOG_PREFIX = "ADC_QA ";

export const AutoIssueKind = z.enum([
  "text_overflow",
  "text_min_size",
  "outside_safe_area",
  "stretched_image",
  "upscaled_image",
  "low_contrast",
]);
export type AutoIssueKind = z.infer<typeof AutoIssueKind>;

/** JSON після префікса `ADC_QA ` у лозі браузера. */
export const QaLogEntry = z.object({
  kind: AutoIssueKind,
  /** Назва компонента motion-kit (FitText, BrandImage, …). */
  component: z.string(),
  detail: z.string(),
  /** Числове значення, якщо є (розмір шрифту, коефіцієнт масштабу, контраст). */
  value: z.number().nullable().optional(),
  frame: z.number().int().optional(),
});
export type QaLogEntry = z.infer<typeof QaLogEntry>;

/** Програмне зауваження, прив'язане до сцени і формату. */
export const AutoIssue = QaLogEntry.extend({
  sceneId: z.string(),
  format: Format,
});
export type AutoIssue = z.infer<typeof AutoIssue>;

export const StillRef = z.object({
  sceneId: z.string(),
  format: Format,
  variant: z.enum(["a", "b"]),
  frame: z.number().int(),
  /** Ключ у сховищі. */
  path: z.string(),
});
export type StillRef = z.infer<typeof StillRef>;

/** Результат стадії `check`: `rev/<n>/check.json`. */
export const CheckReport = z.object({
  compileErrors: z.array(
    z.object({
      sceneId: z.string(),
      message: z.string(),
      line: z.number().int().nullable(),
      column: z.number().int().nullable(),
    }),
  ),
  /** Помилка бандла, не прив'язана до сцени. */
  bundleError: z.string().nullable(),
  runtimeErrors: z.array(
    z.object({
      sceneId: z.string(),
      format: Format,
      frame: z.number().int(),
      message: z.string(),
    }),
  ),
  autoIssues: z.array(AutoIssue),
  stills: z.array(StillRef),
  sheets: z.array(z.object({ format: Format, path: z.string() })),
  durationMs: z.number().int(),
});
export type CheckReport = z.infer<typeof CheckReport>;

export const QaIssueKind = z.enum([
  "clipped_text",
  "outside_safe_area",
  "low_contrast",
  "overlap",
  "empty_frame",
  "off_palette",
  "stretched_image",
  "too_much_text",
  "logo_distorted",
]);
export type QaIssueKind = z.infer<typeof QaIssueKind>;

export const QaSeverity = z.enum(["minor", "major", "critical"]);
export type QaSeverity = z.infer<typeof QaSeverity>;

export const QaIssue = z.object({
  sceneId: z.string(),
  format: Format,
  severity: QaSeverity,
  kind: QaIssueKind,
  description: z.string(),
  /** Конкретна інструкція для `fix`. */
  fix: z.string(),
});
export type QaIssue = z.infer<typeof QaIssue>;

/** QaReport — LLM-схема стадії `qa`: `rev/<n>/qa.json`. */
export const QaReport = z.object({
  verdict: z.enum(["pass", "fix"]),
  issues: z.array(QaIssue),
  summary: z.string(),
});
export type QaReport = z.infer<typeof QaReport>;

/** Серйозні зауваження — major і critical; за ними обирається краща версія сцени. */
export function countSerious(issues: readonly QaIssue[], sceneId?: string): number {
  return issues.filter((i) => i.severity !== "minor" && (sceneId === undefined || i.sceneId === sceneId))
    .length;
}
