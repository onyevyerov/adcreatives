import { rmSync } from "node:fs";
import {
  CheckReport,
  createPromptLoader,
  type LocalStorage,
  type QaIssue,
  QaReport,
  revPaths,
} from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readLedger } from "../src/ledger.ts";
import { QA_IMAGE_MAX_SIDE, sceneImageLayout, stripSheetLayout } from "../src/sheets.ts";
import { createCheckStage, versionStripSheet } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { fixStage } from "../src/stages/fix.ts";
import { applyShowreelRubric, qaStage, SHOWREEL_CRITERIA, showreelScore } from "../src/stages/qa.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";
import { movingEngine, sceneIdOf } from "./strip-engine.ts";

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
  await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
  return storage;
}

describe("qaStage", () => {
  it("аркуші стрічки сцен зі scope × форматів, концепт і задум у промпті, детермінований вердикт, вибір кращої версії", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await codegenStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: fileBlocks({ s1: ex["hook-photo"] }) },
        { text: fileBlocks({ s2: ex["offer-price"] }) },
        { text: fileBlocks({ s3: ex["cta-logo"] }) },
      ]),
    );
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));

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
    // scope (3 сцени) × формати (vertical, square) — аркуші стрічки; кожен ≤ ліміту vision
    const sizes = await imageSizes(call);
    expect(sizes).toHaveLength(6);
    for (const s of sizes) expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);
    // s1: 150 кадрів → 10 кадрів стрічки; s3: 165 → 11
    expect(sizes[0]).toEqual({
      width: stripSheetLayout("vertical", 10).width,
      height: stripSheetLayout("vertical", 10).height,
    });
    expect(sizes[5]).toEqual({
      width: stripSheetLayout("square", 11).width,
      height: stripSheetLayout("square", 11).height,
    });
    const text = userText(call);
    expect(text).toContain(
      "Image 1: scene s1, format vertical, strip of 10 frames every 15 frames (0.5 s), left to right, top to bottom: 15, 30, 45, 60, 75, 90, 105, 120, 135, 149",
    );
    expect(text).toContain("Image 2: scene s1, format square, strip of 10 frames");
    expect(text).toContain("Image 6: scene s3, format square, strip of 11 frames");
    expect(text).not.toContain("25/50/90%");
    expect(text).toContain("Check scenes: s1, s2, s3");
    // арт-директор бачить концепт, задум, тексти й моменти сцен (з секундами)
    expect(text).toContain('"concept": "Ранок у «Зерні»: від зерна до чашки"');
    expect(text).toContain('"motionIntent": "ціна виїжджає знизу, акцент кольором"');
    expect(text).toContain('"text": "Спешелті еспресо з молоком"');
    expect(text).toMatch(/"id": "price-hit",\s*"at": 30,\s*"atSec": 1,/);
    expect(text).toContain('"sound": "impact"');
    // автоперевірки з коду (event_unused) — у промпті
    expect(text).toContain('"kind": "event_unused"');
    expect(r1.outputs).toEqual({ verdict: "fix", seriousScenes: ["s2"] });

    // fix s2 за зауваженнями QA → check s2 → QA №2 оцінює нову версію гірше
    const fixCtx = makeCtx(storage, "fix", { sceneIds: ["s2"], reason: "qa" }, [
      { text: fileBlocks({ s2: ex.typographic }) },
    ]);
    await fixStage(fixCtx);
    expect(userText(fixCtx.anthropic.calls[0]?.params)).toContain("s2: проблема → fix: зменшити заголовок");
    // нова версія s2 «стоїть» — її стрічка відрізняється від стрічки версії 1
    await createCheckStage({
      engine: movingEngine({ frozen: (o) => (sceneIdOf(o) === "s2" ? 15 : null) }),
    })(makeCtx(storage, "check", { sceneIds: ["s2"] }));
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
    expect(userText(ctx2.anthropic.calls[0]?.params)).toContain("Check scenes: s2.");
    // повторний QA після fix — лише зображення сцени зі scope
    expect(callImages(ctx2.anthropic.calls[0]?.params)).toHaveLength(2);
    expect(userText(ctx2.anthropic.calls[0]?.params)).toContain("Image 2: scene s2, format square, strip");
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
    // check.json відновлено для версії 1, як і аркуші стрічки
    const check = await storage.readJson(rp.check, (v) => CheckReport.parse(v));
    expect(check.stills.filter((s) => s.sceneId === "s2")).toHaveLength(6);
    for (const format of ["vertical", "square"] as const) {
      const sheet = await storage.read(rp.stripSheet(format, "s2"));
      expect(sheet.equals(await storage.read(versionStripSheet(PROJECT_ID, 1, "s2", 1, format)))).toBe(true);
      expect(sheet.equals(await storage.read(versionStripSheet(PROJECT_ID, 1, "s2", 2, format)))).toBe(false);
    }
  });

  it("без аркуша стрічки (старий check.json) — кадри 25/50/90%: 16:9 стовпчиком, без кадру e — заглушка", async () => {
    const storage = await checked({ project: { formats: ["vertical", "landscape"] } });
    const rp = revPaths(PROJECT_ID, 1);
    const check = await storage.readJson(rp.check, (v) => CheckReport.parse(v));
    // старий формат check.json: лише a/b і без стрічки для s1
    await storage.writeJson(rp.check, { ...check, stills: check.stills.filter((s) => s.variant !== "e") });
    for (const format of ["vertical", "landscape"] as const) {
      rmSync(storage.absPath(rp.stripSheet(format, "s1")));
    }
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
    expect(userText(call)).toContain("Image 1: scene s1, format vertical, frames 25/50/90%");
    expect(userText(call)).toContain("Image 4: scene s3, format landscape, strip of 11 frames");
    expect(sizes[3]).toEqual({
      width: stripSheetLayout("landscape", 11).width,
      height: stripSheetLayout("landscape", 11).height,
    });
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
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const res = await qaStage(
      makeCtx(storage, "qa", { sceneIds: null }, [
        { json: { verdict: "fix", issues: [issue("s3", "minor")], summary: "" } },
      ]),
    );
    expect(res.outputs).toEqual({ verdict: "pass", seriousScenes: [] });
  });

  it("Showreel bar: рубрика в промпті; оцінка ≤ 2 → major і fix без дефектів, 3–5 → minor", async () => {
    const storage = await checked();
    const bar = (
      sceneId: string,
      criterion: string,
      score: number,
      severity: QaIssue["severity"] = "minor",
      kind: QaIssue["kind"] = "weak_moment",
    ): QaIssue => ({
      ...issue(sceneId, severity, kind),
      description: `Showreel bar · ${criterion} ${score}/5: та сама темна картка, що й у сусідній сцені`,
    });
    const ctx = makeCtx(storage, "qa", { sceneIds: null }, [
      {
        json: {
          verdict: "pass",
          issues: [
            bar("s2", "layout", 2), // модель поставила minor і не той kind — рубрика виправляє
            bar("s2", "mocks", 1, "minor", "off_brief"),
            bar("s1", "background", 4, "major"), // 4/5 — не тягне на fix
            bar("s3", "colour", 3, "major"),
          ],
          summary: "Showreel bar 2.5/5 — s2 повторює макет s1.",
        },
      },
    ]);
    const res = await qaStage(ctx);
    const text = userText(ctx.anthropic.calls[0]?.params);
    expect(text).not.toContain("Showreel bar"); // рубрика — у system, не в даних
    const qa = await storage.readJson(revPaths(PROJECT_ID, 1).qa, (v) => QaReport.parse(v));
    expect(qa.issues.map((i) => [i.sceneId, i.kind, i.severity])).toEqual([
      ["s2", "off_brief", "major"],
      ["s2", "placeholder", "major"],
      ["s1", "weak_moment", "minor"],
      ["s3", "weak_moment", "minor"],
    ]);
    expect(qa.summary).toMatch(/^Showreel bar 2\.5\/5/);
    expect(res.outputs).toEqual({ verdict: "fix", seriousScenes: ["s2"] });
  });

  it("промпт qa: розділ Showreel bar — 4 критерії, поріг ≤ 2, бал у summary", () => {
    const prompt = createPromptLoader().load("qa", {
      sheetsLegend: "-",
      storyboard: {},
      palette: {},
      logo: {},
      autoIssues: [],
      failedScenes: [],
      language: "uk",
      formats: "vertical",
      scope: "s1",
    });
    expect(prompt.system).toContain("# Showreel bar");
    for (const c of Object.keys(SHOWREEL_CRITERIA)) expect(prompt.system).toContain(`- \`${c}\` — `);
    expect(prompt.system).toContain(
      "A score of 1 or 2 is a remark: kind `placeholder` for `mocks`, `off_brief`",
    );
    expect(prompt.system).toContain("`Showreel bar · <criterion> <score>/5:`");
    expect(prompt.system).toContain("starts with `Showreel bar X.X/5`");
  });

  it("applyShowreelRubric: розбір опису, одне зауваження на сцену й критерій, решта без змін", () => {
    expect(showreelScore("Showreel bar · layout 2/5: повтор")).toEqual({ criterion: "layout", score: 2 });
    expect(showreelScore("showreel bar: Color 1/5 — один колір")).toEqual({ criterion: "colour", score: 1 });
    expect(showreelScore("Showreel bar - mocks 5 / 5")).toEqual({ criterion: "mocks", score: 5 });
    expect(showreelScore("Заголовок обрізано, Showreel bar layout 2/5")).toBeNull();
    expect(showreelScore("Showreel bar · layout 7/5")).toBeNull();

    const withDesc = (i: QaIssue, description: string): QaIssue => ({ ...i, description });
    const plain = issue("s1", "major");
    const out = applyShowreelRubric([
      withDesc(issue("s1", "minor", "off_brief"), "Showreel bar · background 2/5: плоский фон"),
      plain,
      { ...withDesc(issue("s1", "minor"), "Showreel bar · background 1/5: плоский фон"), format: "square" },
      withDesc(issue("s2", "critical", "placeholder"), "Showreel bar · mocks 1/5: сірі смужки"),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(plain);
    expect(out[1]).toMatchObject({ sceneId: "s1", format: "square", kind: "off_brief", severity: "major" });
    expect(out[2]).toMatchObject({ sceneId: "s2", kind: "placeholder", severity: "critical" });
  });

  it("без check.json — помилка стадії", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    await expect(qaStage(makeCtx(storage, "qa", { sceneIds: null }))).rejects.toMatchObject({
      code: "check_missing",
    });
  });
});
