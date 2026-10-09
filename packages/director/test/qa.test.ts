import { CheckReport, type LocalStorage, type QaIssue, QaReport, revPaths } from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger.ts";
import { QA_IMAGE_MAX_SIDE, sceneImageLayout } from "../src/sheets.ts";
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

/** Зображення з першого user-повідомлення запиту до моделі (локальний хелпер B3). */
function callImages(params: unknown): Buffer[] {
  const p = params as {
    messages: Array<{ content: Array<{ type: string; source?: { data?: string } }> }>;
  };
  return (p.messages[0]?.content ?? [])
    .filter((c) => c.type === "image")
    .map((c) => Buffer.from(c.source?.data ?? "", "base64"));
}

async function imageSizes(params: unknown): Promise<Array<{ width: number; height: number }>> {
  return Promise.all(
    callImages(params).map(async (b) => {
      const m = await sharp(b).metadata();
      return { width: m.width ?? 0, height: m.height ?? 0 };
    }),
  );
}

async function checked(seed: Parameters<typeof seedProject>[1] = {}): Promise<LocalStorage> {
  const storage = tmpStorage();
  await seedProject(storage, seed);
  await codegenStage(
    makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: fileBlocks({ s1: ex["hook-photo"] }) },
      { text: fileBlocks({ s2: ex["offer-price"] }) },
      { text: fileBlocks({ s3: ex["cta-logo"] }) },
    ]),
  );
  await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));
  return storage;
}

describe("qaStage", () => {
  it("зображення сцен зі scope × форматів, детермінований вердикт, вибір кращої версії сцени", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await codegenStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: fileBlocks({ s1: ex["hook-photo"] }) },
        { text: fileBlocks({ s2: ex["offer-price"] }) },
        { text: fileBlocks({ s3: ex["cta-logo"] }) },
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
    const call = ctx1.anthropic.calls[0]?.params;
    // scope (3 сцени) × формати (vertical, square); кожне ≤ ліміту vision
    const sizes = await imageSizes(call);
    expect(sizes).toHaveLength(6);
    for (const s of sizes) expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);
    // 9:16 і 1:1 — кадри в ряд (ширше, ніж вище)
    expect(sizes[0]).toEqual({
      width: sceneImageLayout("vertical").width,
      height: sceneImageLayout("vertical").height,
    });
    expect(sizes.every((s) => s.width > s.height)).toBe(true);
    const text = userText(call);
    expect(text).toContain("Image 1: scene s1, format vertical, frames 25/50/90%");
    expect(text).toContain("Image 2: scene s1, format square, frames 25/50/90%");
    expect(text).toContain("Image 6: scene s3, format square, frames 25/50/90%");
    expect(text).toContain("Перевір сцени: s1, s2, s3");
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
    // повторний QA після fix — лише зображення сцени зі scope
    expect(callImages(ctx2.anthropic.calls[0]?.params)).toHaveLength(2);
    expect(userText(ctx2.anthropic.calls[0]?.params)).toContain("Image 2: scene s2, format square");
    expect(userText(ctx2.anthropic.calls[0]?.params)).not.toContain("scene s1");

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
    expect(check.stills.filter((s) => s.sceneId === "s2")).toHaveLength(6);
  });

  it("16:9 — кадри стовпчиком у межах ліміту; старий check.json без кадру e — заглушка замість кадру", async () => {
    const storage = await checked({ project: { formats: ["vertical", "landscape"] } });
    const rp = revPaths(PROJECT_ID, 1);
    const check = await storage.readJson(rp.check, (v) => CheckReport.parse(v));
    // старий формат check.json: лише a/b
    await storage.writeJson(rp.check, { ...check, stills: check.stills.filter((s) => s.variant !== "e") });
    const ctx = makeCtx(storage, "qa", { sceneIds: ["s1", "s3"] }, [
      { json: { verdict: "pass", issues: [], summary: "" } },
    ]);
    const res = await qaStage(ctx);
    expect(res.outputs.verdict).toBe("pass");
    const call = ctx.anthropic.calls[0]?.params;
    const sizes = await imageSizes(call);
    expect(sizes).toHaveLength(4); // 2 сцени × 2 формати
    for (const s of sizes) expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);
    // vertical — у ряд, landscape — у стовпчик
    const landscape = sceneImageLayout("landscape");
    expect(landscape.inRow).toBe(false);
    expect(sizes[0]?.width).toBeGreaterThan(sizes[0]?.height ?? 0);
    expect(sizes[1]).toEqual({ width: landscape.width, height: landscape.height });
    expect(landscape.height).toBeGreaterThan(landscape.width);
    expect(userText(call)).toContain("Image 4: scene s3, format landscape, frames 25/50/90%");
    expect(sceneImageLayout("square").inRow).toBe(true);
  });

  it("без серйозних зауважень — pass навіть якщо модель сказала fix", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await codegenStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: fileBlocks({ s1: ex["hook-photo"] }) },
        { text: fileBlocks({ s2: ex["offer-price"] }) },
        { text: fileBlocks({ s3: ex["cta-logo"] }) },
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
