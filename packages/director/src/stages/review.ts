import { type Stage, type StageContext, StageError } from "@adc/shared";

export const REVIEW_PROMPT = "review";

export type ReviewStageDeps = Record<string, never>;

/** Крок 0: заглушка стадії `review`; реалізація — блок B3. */
export function createReviewStage(_deps: ReviewStageDeps = {}): Stage<"review"> {
  return async (_ctx: StageContext<"review">) => {
    throw new StageError("review: not implemented", "not_implemented", "Цей етап ще не реалізований.", false);
  };
}

export const reviewStage: Stage<"review"> = createReviewStage();
