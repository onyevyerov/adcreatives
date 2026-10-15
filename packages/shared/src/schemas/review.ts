import { z } from "zod";
import { Format } from "./common.ts";
import { QaIssueKind, QaSeverity } from "./qa.ts";

export const ReviewScope = z.enum(["scene", "join", "film"]);
export type ReviewScope = z.infer<typeof ReviewScope>;

export const ReviewKind = z.enum([
  ...QaIssueKind.options, // візуальні по сцені, ті самі, що в QA
  "join_break", // склейка рве рух/стан (останній стан ≠ перший стан наступної)
  "throughline_lost", // наскрізний об'єкт зникає або міняє природу
  "rhythm", // ритм: сцена/момент не на долі, темп картинки проти темпу
  "pace", // затягнуто/заспішно відносно концепту
  "sfx_wrong_cue", // cue не відповідає тому, що видно
  "sfx_missing", // видимий удар/поява без звуку
  "sfx_excess", // забагато звуків, каша, перевищені ліміти ударів
  "sfx_off_beat", // |beatOffsetMs| понад поріг у відомості
  "sfx_level", // подія не чутна або надто гучна за peakDb/дакінгом
  "music_mismatch", // настрій/темп треку проти бренду й концепту
  "music_level", // арка mix (filtered/full/breakdown) не працює за rmsPerSecondDb
]);
export type ReviewKind = z.infer<typeof ReviewKind>;

export const ReviewRoute = z.enum(["fix", "sfx", "music", "none"]);
export type ReviewRoute = z.infer<typeof ReviewRoute>;

export const ReviewIssue = z.object({
  scope: ReviewScope,
  /** scene/join — сцена (для join — та, що ПЕРЕД склейкою); film — null. */
  sceneId: z.string().nullable(),
  nextSceneId: z.string().nullable().default(null),
  eventId: z.string().nullable().default(null),
  /** Локальний кадр sceneId; null — вся сцена/фільм. */
  frame: z.number().int().nullable().default(null),
  format: Format.nullable().default(null),
  severity: QaSeverity,
  kind: ReviewKind,
  description: z.string(),
  /** Точна інструкція виконавцю (fix або sfx). */
  fix: z.string(),
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

/** Що повертає модель. */
export const FilmReviewDraft = z.object({
  verdict: z.enum(["pass", "fix"]),
  score: z.number().int().min(1).max(10),
  issues: z.array(ReviewIssue),
  summary: z.string(),
});
export type FilmReviewDraft = z.infer<typeof FilmReviewDraft>;

/** `rev/<n>/review.json`: + маршрути (їх ставить код) і коло. */
export const FilmReview = FilmReviewDraft.extend({
  version: z.literal(1),
  round: z.number().int(),
  inputsHash: z.string(),
  routes: z.object({
    fix: z.array(z.string()),
    sfx: z.array(z.string()),
    music: z.number().int(),
  }),
});
export type FilmReview = z.infer<typeof FilmReview>;

/** Маршрут за типом: QaIssueKind ∪ join_break/throughline_lost/rhythm/pace → fix; sfx_* → sfx; music_* → music. */
export function routeOf(kind: ReviewKind): ReviewRoute {
  if (kind.startsWith("sfx_")) return "sfx";
  if (kind.startsWith("music_")) return "music";
  return "fix";
}

/** Вердикт за правилом коду: fix лише коли є major/critical з маршрутом fix або sfx. */
export function effectiveVerdict(issues: readonly ReviewIssue[]): "pass" | "fix" {
  return issues.some((i) => {
    if (i.severity === "minor") return false;
    const route = routeOf(i.kind);
    return route === "fix" || route === "sfx";
  })
    ? "fix"
    : "pass";
}
