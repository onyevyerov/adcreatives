import { type ChatEvent, STAGE_STEPS, type Storyboard, t } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { storyboardStage } from "../src/stages/storyboard.ts";
import { makeCtx, seedProject, tmpStorage } from "./helpers.ts";

type ProgressEvent = Extract<ChatEvent, { type: "progress" }>;

const steps = STAGE_STEPS.scripting;
const label = (id: string) => steps.find((s) => s.id === id)?.label as string;

const progressOf = (ctx: { emitted: { events: Array<{ type: string }> } }) =>
  ctx.emitted.events.filter((e): e is ProgressEvent => e.type === "progress");

/** Задовгий sub у s2 → textIssues і точковий copyfix. */
function longDraft(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  (sb.scenes[1] as Storyboard["scenes"][number]).text.sub =
    "Неймовірно довгий підзаголовок, який ніяк не вміщується у два рядки вертикального формату";
  return sb;
}

describe("storyboard: події підкроків", () => {
  it("write → fit → claims; «Пишу сценарій…» шле лише машина (крок brief)", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [
      { json: structuredClone(fixtureStoryboard) },
    ]);
    await storyboardStage(ctx);

    const events = progressOf(ctx);
    expect(events.map((e) => [e.stage, e.step, e.label])).toEqual([
      ["storyboard", "write", label("write")],
      ["storyboard", "fit", label("fit")],
      ["storyboard", "claims", label("claims")],
    ]);
    expect(events.some((e) => e.label === t("scriptProgress") || e.step === "brief")).toBe(false);
  });

  it("copyfix іде в межах кроку fit — без повторних подій", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const fix = { scenes: [{ id: "s2", headline: "Капучино — 75 грн", sub: "-10% з собою", emphasis: [] }] };
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [
      { json: longDraft() },
      { json: fix },
    ]);
    await storyboardStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(progressOf(ctx).map((e) => e.step)).toEqual(["write", "fit", "claims"]);
  });

  it("розкадровка з попередньої ревізії — одразу claims", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { rev: 2, storyboard: null });
    const first = makeCtx(storage, "storyboard", { durationSeconds: null }, [
      { json: structuredClone(fixtureStoryboard) },
    ]);
    await storyboardStage(first);

    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [], { rev: 2 });
    const res = await storyboardStage(ctx);
    expect(res.reused).toBe(true);
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(progressOf(ctx).map((e) => [e.step, e.label])).toEqual([["claims", label("claims")]]);
  });
});
