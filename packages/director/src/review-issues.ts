import { type FilmReview, type ReviewIssue, routeOf } from "@adc/shared";

/** Рецензія, з якої fix бере зауваження: `issues` і режим маршруту склейок (старий `review.json` — без нього). */
export type ReviewForFix = Pick<FilmReview, "issues"> & { joinSide?: FilmReview["joinSide"] };

/**
 * Зауваження рецензента фільму для сцени: маршрут `fix` (`routeOf`), сцена — `sceneId`, а для `join` —
 * і `nextSceneId`: обидві сторони, бо й у режимі one друга сторона, якщо вона в fix з інших причин, має знати,
 * що її край склейки не чіпати (текст — `reviewLine`).
 */
export function reviewIssuesFor(review: ReviewForFix | null, sceneId: string): ReviewIssue[] {
  return (review?.issues ?? []).filter(
    (i) =>
      routeOf(i.kind) === "fix" &&
      (i.sceneId === sceneId || (i.scope === "join" && i.nextSceneId === sceneId)),
  );
}

/**
 * Рядок зауваження рецензента для `<problems>`: де, що, інструкція; для склейки — що з чим зшити.
 * `joinSide` undefined = "both". У режимі one склейку з `fixSceneId` править лише та сцена; друга сторона
 * отримує лише вказівку не чіпати свої перші/останні кадри.
 */
export function reviewLine(i: ReviewIssue, sceneId: string, joinSide?: FilmReview["joinSide"]): string {
  const own = i.sceneId === sceneId;
  if (i.scope === "join" && joinSide === "one" && i.fixSceneId !== null && i.fixSceneId !== sceneId) {
    return `- [${i.severity}, join] At the cut with ${i.fixSceneId} the other scene is changed to match you: keep your ${own ? "last" : "first"} frames exactly as they are.`;
  }
  const where = [
    i.format,
    i.eventId ? `event ${i.eventId}` : null,
    i.frame !== null ? (own ? `frame ${i.frame}` : `frame ${i.frame} of ${i.sceneId}`) : null,
  ].filter(Boolean);
  const head = `- [${[i.severity, ...where, i.kind].join(", ")}] ${i.description} → fix: ${i.fix}`;
  if (i.scope !== "join") return head;
  if (own) {
    return i.nextSceneId
      ? `${head} At the join with ${i.nextSceneId}: last state of this scene must become first state of the next.`
      : head;
  }
  return `${head} At the join with ${i.sceneId} (it comes before this scene): first state of this scene must continue the last state of ${i.sceneId}.`;
}

/** Блок «Film reviewer's remarks…» для `describeProblems`: заголовок + рядки; [] — зауважень немає. */
export function reviewProblemLines(review: ReviewForFix | null, sceneId: string): string[] {
  const issues = reviewIssuesFor(review, sceneId);
  if (!issues.length) return [];
  return [
    "Film reviewer's remarks (from watching the whole film, frames are local to the scene named):",
    ...issues.map((i) => reviewLine(i, sceneId, review?.joinSide)),
  ];
}
