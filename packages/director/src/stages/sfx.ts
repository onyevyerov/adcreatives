import { type Stage, type StageContext, StageError } from "@adc/shared";

export const SFX_PROMPT = "sfx-design";

export type SfxStageDeps = Record<string, never>;

/** Крок 0: заглушка стадії `sfx`; реалізація — блок B2. */
export function createSfxStage(_deps: SfxStageDeps = {}): Stage<"sfx"> {
  return async (_ctx: StageContext<"sfx">) => {
    throw new StageError("sfx: not implemented", "not_implemented", "Цей етап ще не реалізований.", false);
  };
}

export const sfxStage: Stage<"sfx"> = createSfxStage();
