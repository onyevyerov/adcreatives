import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckReport, type LocalStorage, revPaths, type ScenePreviewProps } from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { fixStage } from "../src/stages/fix.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  mockEngine,
  PROJECT_ID,
  qaLogLine,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";

const ex = exampleSources();
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TS_BAD = `import type { SceneProps } from "@adc/motion-kit";
import { Headline } from "@adc/motion-kit";
export default function Scene(props: SceneProps) {
  return <Headline title={props.scene.text.headline} size="huge" />;
}
`;
const GUARD_BAD = ex["cta-logo"].replace(
  "const dark =",
  "const year = new Date().getFullYear();\n  const dark =",
);

async function generated(scenes: Record<string, string>, opts: { rev?: number } = {}): Promise<LocalStorage> {
  const storage = tmpStorage();
  await seedProject(storage, opts);
  await codegenStage(
    makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [{ text: fileBlocks(scenes) }]),
  );
  return storage;
}

const readCheck = (storage: LocalStorage, rev = 1) =>
  storage.readJson(revPaths(PROJECT_ID, rev).check, (v) => CheckReport.parse(v));

describe("checkStage (мок RenderEngine)", () => {
  it("типи по сценах, AST-guard, стіли у всіх форматах, autoIssues, аркуші", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: GUARD_BAD });
    const engine = mockEngine({
      logs: { s1: [qaLogLine("text_overflow", "headline не вліз"), "звичайний лог"] },
    });
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));

    expect(res.outputs).toEqual({ failedScenes: ["s2", "s3"], issueScenes: ["s1"] });
    const report = await readCheck(storage);
    expect(
      report.compileErrors
        .filter((e) => e.sceneId === "s2")
        .map((e) => e.message)
        .join("\n"),
    ).toMatch(/huge/);
    expect(report.compileErrors.find((e) => e.sceneId === "s3")?.message).toMatch(/AST-guard: .*Date/);
    expect(report.stills.map((s) => `${s.format}/${s.sceneId}-${s.variant}@${s.frame}`).sort()).toEqual([
      "square/s1-a@75",
      "square/s1-b@135",
      "vertical/s1-a@75",
      "vertical/s1-b@135",
    ]);
    expect(report.autoIssues).toHaveLength(2);
    expect(report.autoIssues[0]).toMatchObject({
      kind: "text_overflow",
      sceneId: "s1",
      component: "FitText",
    });
    expect(report.sheets.map((s) => s.format)).toEqual(["vertical", "square"]);
    const meta = await sharp(await storage.read(revPaths(PROJECT_ID, 1).sheet("vertical"))).metadata();
    expect(meta.width).toBeGreaterThan(500);

    // ScenePreview з QA-режимом і асетами в public/
    const props = engine.stills[0]?.inputProps as ScenePreviewProps;
    expect(props).toMatchObject({ sceneId: "s1", qa: true, useTemplate: false });
    expect(props.assets.a01?.src).toBe("assets/a01.jpg");
    expect(await storage.exists(revPaths(PROJECT_ID, 1).publicFile("assets/a01.jpg"))).toBe(true);
    // реєстр сцен без сцен з помилками компіляції
    expect(await storage.readText(revPaths(PROJECT_ID, 1).scenesIndex)).toContain(
      "export default { s1: S1 };",
    );
    expect(engine.closed).toBe(0); // екземпляр не закривається стадією
    // журнал версій: результат check і копії стілів
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s1?.versions[0]?.check?.autoIssues).toHaveLength(2);
    expect(await storage.exists(directorPaths(PROJECT_ID, 1).versionStill("s1", 1, "vertical", "a"))).toBe(
      true,
    );
  });

  it("runtime-помилка прив'язується до сцени; TemplateScene з pipeline.json; фабрика закривається", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: GUARD_BAD });
    await storage.writeJson(revPaths(PROJECT_ID, 1).pipeline, {
      attempts: {},
      fixRounds: {},
      qaRounds: 0,
      templateScenes: ["s3"],
      dirtyScenes: [],
    });
    const engine = mockEngine({ fail: { s2: "TypeError: cannot read properties of undefined" } });
    const res = await createCheckStage({ engine: () => engine })(
      makeCtx(storage, "check", { sceneIds: null }),
    );
    expect(res.outputs.failedScenes).toEqual(["s2"]);
    const report = await readCheck(storage);
    expect(report.runtimeErrors.map((e) => [e.sceneId, e.format])).toEqual([
      ["s2", "vertical"],
      ["s2", "vertical"],
      ["s2", "square"],
      ["s2", "square"],
    ]);
    expect(report.compileErrors).toEqual([]);
    const s3 = engine.stills.filter((s) => (s.inputProps as ScenePreviewProps).sceneId === "s3");
    expect(s3).toHaveLength(4);
    expect((s3[0]?.inputProps as ScenePreviewProps | undefined)?.useTemplate).toBe(true);
    expect(engine.closed).toBe(1);
  });

  it("помилка бандла на сцені → compileError цієї сцени і повтор без неї; невідома — помилка стадії", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    const engine = mockEngine({
      bundleError: (n) =>
        n === 1 ? "Module build failed: /data/rev/1/video/scenes/s2.tsx: Unexpected token" : null,
    });
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual(["s2"]);
    expect(engine.bundles).toHaveLength(2);
    expect((await readCheck(storage)).compileErrors[0]?.message).toMatch(/^bundle: /);

    const broken = mockEngine({ bundleError: () => "rspack crashed" });
    await expect(
      createCheckStage({ engine: broken })(makeCtx(storage, "check", { sceneIds: null })),
    ).rejects.toMatchObject({
      code: "check_bundle_failed",
    });
    expect((await readCheck(storage)).bundleError).toBe("rspack crashed");
  });

  it("нова ревізія: незмінені сцени переносяться (код і стіли) без рендера", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    await seedProject(storage, { rev: 2 });
    const engine = mockEngine();
    const res = await createCheckStage({ engine })(
      makeCtx(storage, "check", { sceneIds: null }, [], { rev: 2 }),
    );
    expect(engine.stills).toHaveLength(0);
    expect(res.reused).toBe(true);
    const report = await readCheck(storage, 2);
    expect(report.stills).toHaveLength(12);
    expect(report.stills[0]?.path).toContain("/rev/2/");
    expect(await storage.exists(revPaths(PROJECT_ID, 2).scene("s1"))).toBe(true);

    // змінена сцена s2 знімається, решта — з основи
    const engine3 = mockEngine();
    await seedProject(storage, { rev: 3 });
    await storage.write(revPaths(PROJECT_ID, 3).scene("s2"), ex.typographic);
    await createCheckStage({ engine: engine3 })(
      makeCtx(storage, "check", { sceneIds: ["s2"] }, [], { rev: 3 }),
    );
    expect(new Set(engine3.stills.map((s) => (s.inputProps as ScenePreviewProps).sceneId))).toEqual(
      new Set(["s2"]),
    );
    expect((await readCheck(storage, 3)).stills).toHaveLength(12);
  });
});

describe("fixStage (записані відповіді LLM)", () => {
  it("виправляє сцени паралельно за помилками check; новий код проходить AST-guard", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: GUARD_BAD });
    await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const recorded = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
    const reply = (params: unknown) =>
      userText(params).includes("Виправ сцену s2")
        ? { text: recorded("fix-s2.txt") }
        : { text: recorded("fix-s3.txt") };
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s2", "s3"], reason: "check" }, [reply, reply]);
    const res = await fixStage(ctx);
    expect(res.outputs.sceneIds.sort()).toEqual(["s2", "s3"]);

    const prompts = ctx.anthropic.calls.map((c) => userText(c.params));
    const s2Prompt = prompts.find((p) => p.includes("Виправ сцену s2")) ?? "";
    expect(s2Prompt).toMatch(/TS\d+:.*huge/);
    expect(s2Prompt).toContain('size="huge"');
    const s3Prompt = prompts.find((p) => p.includes("Виправ сцену s3")) ?? "";
    expect(s3Prompt).toMatch(/AST-guard[\s\S]*Date/);

    const rp = revPaths(PROJECT_ID, 1);
    expect(await storage.readText(rp.scene("s2"))).toContain("extrapolateLeft");
    expect(await storage.readText(rp.scene("s3"))).not.toContain("new Date");
    expect(await storage.readText(rp.scenesIndex)).toContain("export default { s1: S1, s2: S2, s3: S3 };");
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions.map((v) => [v.v, v.origin, v.guardOk])).toEqual([
      [1, "codegen", true],
      [2, "fix", true],
    ]);

    // наступний check бачить виправлені сцени чистими
    const res2 = await createCheckStage({ engine: mockEngine() })(
      makeCtx(storage, "check", { sceneIds: ["s2", "s3"] }),
    );
    expect(res2.outputs.failedScenes).toEqual([]);
    expect((await readCheck(storage)).stills).toHaveLength(12);
  });

  it("відповідь з забороненим кодом → нова версія відхилена, сцена поза реєстром", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: ex["cta-logo"] });
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s2"], reason: "check" }, [
      { text: fileBlocks({ s2: GUARD_BAD }) },
    ]);
    const res = await fixStage(ctx);
    expect(res.outputs.sceneIds).toEqual(["s2"]);
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions[1]?.guardOk).toBe(false);
    expect(await storage.readText(revPaths(PROJECT_ID, 1).scenesIndex)).not.toContain("s2");
  });
});
