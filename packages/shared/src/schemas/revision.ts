import { z } from "zod";
import { JsonPatchOp } from "./brandkit.ts";

/** RevisionPlan — LLM-схема стадії `revise`. */
export const RevisionPlan = z.object({
  /** Що змінюється, коротко — для чату. */
  summary: z.string(),
  /** JSON Patch до storyboard.json поточної ревізії. */
  storyboardPatch: z.array(JsonPatchOp),
  scenesToRegenerate: z.array(
    z.object({
      sceneId: z.string(),
      instruction: z.string(),
    }),
  ),
  musicChanged: z.boolean(),
  durationChanged: z.boolean(),
});
export type RevisionPlan = z.infer<typeof RevisionPlan>;
