import { CheckReport, type QaIssue, QaReport, revPaths } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger.ts";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { fixStage } from "../src/stages/fix.ts";
import { qaStage } from "../src/stages/qa.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  mockEngine,
  PROJECT_ID,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";

const ex = exampleSources();

const issue = (
  sceneId: string,
  severity: QaIssue["severity"],
  kind: QaIssue["kind"] = "clipped_text",
): QaIssue => ({
  sceneId,
  format: "vertical",
  severity,
  kind,
  description: `${sceneId}: проблема`,
  fix: "зменшити заголовок",
});

describe("qaStage", () => {
  it("аркуші всіх форматів у моделі, детермінований вердикт, вибір кращої версії сцени", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await codegenStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: fileBlocks({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] }) },
      ]),
    );
    await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));

    // QA №1: s2 — одне major, s1 — minor; зауваження для невідомої сцени відкидається
    const ctx1 = makeCtx(storage, "qa", { sceneIds: null }, [
      {
        json: {
          verdict: "pass",
          issues: [issue("s2", "major"), issue("s1", "minor"), issue("s9", "critical")],
          summary: "ок",
        },
      },
    ]);
    const r1 = await qaStage(ctx1);
    const call = ctx1.anthropic.calls[0]?.params as { messages: Array<{ content: Array<{ type: string }> }> };
    expect(call.messages[0]?.content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(userText(call)).toContain("Перевір сцени: s1, s2, s3");
    expect(r1.outputs).toEqual({ verdict: "fix", seriousScenes: ["s2"] });

    // fix s2 за зауваженнями QA → check s2 → QA №2 оцінює нову версію гірше
    const fixCtx = makeCtx(storage, "fix", { sceneIds: ["s2"], reason: "qa" }, [
      { text: fileBlocks({ s2: ex.typographic }) },
    ]);
    await fixStage(fixCtx);
    expect(userText(fixCtx.anthropic.calls[0]?.params)).toContain("s2: проблема → fix: зменшити заголовок");
    await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: ["s2"] }));
    const ctx2 = makeCtx(storage, "qa", { sceneIds: ["s2"] }, [
      {
        json: {
          verdict: "fix",
          issues: [issue("s2", "critical"), issue("s2", "major", "overlap")],
          summary: "гірше",
        },
      },
    ]);
    const r2 = await qaStage(ctx2);
    expect(userText(ctx2.anthropic.calls[0]?.params)).toContain("Перевір сцени: s2.");

    // лишилась перша версія s2 (1 серйозне < 2)
    const rp = revPaths(PROJECT_ID, 1);
    expect(await storage.readText(rp.scene("s2"))).toContain("Pill");
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.current).toBe(1);
    expect(ledger.scenes.s2?.versions.map((v) => v.qa?.serious)).toEqual([1, 2]);
    const qa = await storage.readJson(rp.qa, (v) => QaReport.parse(v));
    expect(qa.issues.map((i) => [i.sceneId, i.severity])).toEqual([
      ["s1", "minor"],
      ["s2", "major"],
    ]);
    expect(r2.outputs).toEqual({ verdict: "fix", seriousScenes: ["s2"] });
    // check.json відновлено для версії 1
    const check = await storage.readJson(rp.check, (v) => CheckReport.parse(v));
    expect(check.stills.filter((s) => s.sceneId === "s2")).toHaveLength(4);
  });

  it("без серйозних зауважень — pass навіть якщо модель сказала fix", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await codegenStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: fileBlocks({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] }) },
      ]),
    );
    await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const res = await qaStage(
      makeCtx(storage, "qa", { sceneIds: null }, [
        { json: { verdict: "fix", issues: [issue("s3", "minor")], summary: "" } },
      ]),
    );
    expect(res.outputs).toEqual({ verdict: "pass", seriousScenes: [] });
  });

  it("без check.json — помилка стадії", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await expect(qaStage(makeCtx(storage, "qa", { sceneIds: null }))).rejects.toMatchObject({
      code: "check_missing",
    });
  });
});
