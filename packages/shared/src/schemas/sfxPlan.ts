import { z } from "zod";
import { SoundAccent, SoundCue, type Storyboard } from "./storyboard.ts";

export const SfxDecision = z.object({
  sceneId: z.string(),
  eventId: z.string(),
  /** null — подія мовчить. */
  sound: z.object({ cue: SoundCue, accent: SoundAccent.default("normal") }).nullable(),
  /** 1 речення: чому так (для рецензента і журналу). */
  reason: z.string().default(""),
});
export type SfxDecision = z.infer<typeof SfxDecision>;

/** Що повертає модель (structured output). */
export const SfxPlanDraft = z.object({
  decisions: z.array(SfxDecision),
  /** Звукова логіка ролика, 2–4 речення (для рецензента). */
  notes: z.string().default(""),
});
export type SfxPlanDraft = z.infer<typeof SfxPlanDraft>;

/** `rev/<n>/sfx-plan.json`. */
export const SfxPlan = SfxPlanDraft.extend({
  version: z.literal(1),
  inputsHash: z.string(),
  /** Сцени, на яких план рахувався в цій ревізії; решта скопійована з ревізії-основи. */
  sceneIds: z.array(z.string()),
});
export type SfxPlan = z.infer<typeof SfxPlan>;

/**
 * Накладання плану на розкадровку: для кожного рішення підміняється лише `events[].sound`;
 * `at` не рухається; події без рішення лишають звук розкадровки; невідомі sceneId/eventId
 * ігноруються (повертаються в `dropped`). Чиста функція, детермінована; вхід не мутується.
 */
export function applySfxPlan(
  storyboard: Storyboard,
  plan: Pick<SfxPlan, "decisions"> | null,
): { storyboard: Storyboard; applied: number; dropped: SfxDecision[] } {
  if (!plan || plan.decisions.length === 0) return { storyboard, applied: 0, dropped: [] };
  // Останнє рішення для пари сцена+подія перемагає.
  const byKey = new Map<string, SfxDecision>();
  for (const d of plan.decisions) byKey.set(`${d.sceneId}\u0000${d.eventId}`, d);
  const used = new Set<string>();
  const scenes = storyboard.scenes.map((scene) => ({
    ...scene,
    events: scene.events.map((ev) => {
      const key = `${scene.id}\u0000${ev.id}`;
      const d = byKey.get(key);
      if (!d) return ev;
      used.add(key);
      return { ...ev, sound: d.sound ? { cue: d.sound.cue, accent: d.sound.accent } : null };
    }),
  }));
  const dropped = [...byKey.entries()].filter(([k]) => !used.has(k)).map(([, d]) => d);
  return { storyboard: { ...storyboard, scenes }, applied: used.size, dropped };
}
