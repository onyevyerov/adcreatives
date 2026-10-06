import { ClaimsReport, computeTimeline, revPaths, type Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { reviseStage } from "../src/stages/revise.ts";
import { storyboardStage } from "../src/stages/storyboard.ts";
import { makeCtx, PROJECT_ID, seedProject, tmpStorage, userText } from "./helpers.ts";

function draft(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  // закоротко, неіснуючий асет, непідтверджене твердження
  sb.scenes = sb.scenes.map((s) => ({ ...s, durationFrames: 60, assetIds: [...s.assetIds, "zz1"] }));
  (sb.scenes[0] as Storyboard["scenes"][number]).text.headline = "Найкраща кава";
  return sb;
}

describe("storyboardStage", () => {
  it("structured → normalizeStoryboard → verifyClaims → storyboard.json, claims.json", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: draft() }]);
    const res = await storyboardStage(ctx);
    const rp = revPaths(PROJECT_ID, 1);
    const sb = await storage.readJson<Storyboard>(rp.storyboard);
    expect(computeTimeline(sb).totalFrames).toBe(450);
    expect(sb.scenes[0]?.assetIds).toEqual(["a01"]);
    const claims = await storage.readJson(rp.claims, (v) => ClaimsReport.parse(v));
    expect(claims.unverified.map((c) => c.text)).toEqual(["Найкраща"]);
    expect(res.outputs).toEqual({ unverifiedClaims: 1, totalFrames: 450 });
    expect(res.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    const user = userText(ctx.anthropic.calls[0]?.params);
    expect(user).toContain("<facts>");
    expect(user).toContain("Капучино — 75 грн");
    expect(ctx.anthropic.calls[0]?.method).toBe("stream"); // effort xhigh → стрім
  });

  it("бажана тривалість клієнта і повтор при задовгих текстах", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const long = draft();
    (long.scenes[1] as Storyboard["scenes"][number]).text.sub =
      "Неймовірно довгий підзаголовок, який ніяк не вміщується у два рядки вертикального формату";
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: 20 }, [{ json: long }, { json: draft() }]);
    const res = await storyboardStage(ctx);
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(userText(ctx.anthropic.calls[1]?.params)).toContain("порушила ліміти тексту");
    expect(res.outputs.totalFrames).toBe(600);
  });

  it("та сама розкадровка в ревізії-основі → копія без виклику моделі", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await storyboardStage(makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: draft() }]));
    await seedProject(storage, { rev: 2, storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [], { rev: 2 });
    const res = await storyboardStage(ctx);
    expect(res.reused).toBe(true);
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(await storage.exists(revPaths(PROJECT_ID, 2).claims)).toBe(true);
  });
});

describe("reviseStage", () => {
  it("RevisionPlan → JSON Patch до розкадровки основи → нормалізація, claims, revision.json", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await seedProject(storage, { rev: 2, storyboard: null });
    const newScene = {
      ...structuredClone(fixtureStoryboard.scenes[1]),
      id: "s4",
      text: { headline: "Сніданки щодня", sub: null, emphasis: [] },
    };
    const plan = {
      summary: "Змінюю заголовок другої сцени і додаю сцену про сніданки.",
      storyboardPatch: [
        {
          op: "replace",
          path: "/scenes/1/text/headline",
          valueJson: JSON.stringify("Капучино за 75 грн"),
          from: null,
        },
        { op: "add", path: "/scenes/2", valueJson: JSON.stringify(newScene), from: null },
        { op: "replace", path: "/scenes/9/text/headline", valueJson: '"x"', from: null },
      ],
      scenesToRegenerate: [
        { sceneId: "s2", instruction: "Ціну зробити крупніше" },
        { sceneId: "s7", instruction: "?" },
      ],
      musicChanged: false,
      durationChanged: false,
    };
    const ctx = makeCtx(
      storage,
      "revise",
      { text: "У другій сцені — «Капучино за 75 грн», і додайте сніданки", at: "storyboard" },
      [{ json: plan }],
      { rev: 2 },
    );
    const res = await reviseStage(ctx);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("<client_message>");
    expect(res.outputs).toEqual({
      scenesToRegenerate: ["s2", "s4"],
      musicChanged: false,
      durationChanged: true,
    });

    const rp2 = revPaths(PROJECT_ID, 2);
    const sb = await storage.readJson<Storyboard>(rp2.storyboard);
    expect(sb.scenes.map((s) => s.id)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(sb.scenes[1]?.text.headline).toBe("Капучино за 75 грн");
    expect(computeTimeline(sb).totalFrames).toBeLessThanOrEqual(900);
    const record = await storage.readJson<{ skipped: unknown[]; scenesToRegenerate: unknown[] }>(
      directorPaths(PROJECT_ID, 2).revision,
    );
    expect(record.skipped).toHaveLength(1);
    expect(record.scenesToRegenerate).toContainEqual({
      sceneId: "s4",
      instruction: "Нова сцена — згенеруй її за розкадровкою.",
    });
    // розкадровка основи не змінена
    const base = await storage.readJson<Storyboard>(revPaths(PROJECT_ID, 1).storyboard);
    expect(base.scenes[1]?.text.headline).toBe("Капучино — 75 грн");
    expect(await storage.exists(rp2.claims)).toBe(true);
  });
});
