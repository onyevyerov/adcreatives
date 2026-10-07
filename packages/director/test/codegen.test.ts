import { revPaths } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  seedProject,
  systemText,
  tmpStorage,
  userText,
} from "./helpers.ts";

const ex = exampleSources();
const BAD = ex["cta-logo"].replace("const dark =", "const year = new Date().getFullYear();\n  const dark =");

async function firstGeneration() {
  const storage = tmpStorage();
  await seedProject(storage);
  const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
    { text: `Ось сцени:\n${fileBlocks({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: BAD })}` },
  ]);
  const res = await codegenStage(ctx);
  return { storage, ctx, res };
}

describe("codegenStage", () => {
  it("перша генерація: усі сцени одним стрім-викликом, AST-guard, реєстр", async () => {
    const { storage, ctx, res } = await firstGeneration();
    const rp = revPaths(PROJECT_ID, 1);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s3"] });
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(ctx.anthropic.calls[0]?.method).toBe("stream");
    const system = systemText(ctx.anthropic.calls[0]?.params);
    expect(system).toContain("useFormat"); // декларації motion-kit
    expect(system).toContain("registerRoot"); // вендорний system prompt Remotion
    expect(system).toContain("examples/hook-photo.tsx");
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("Generate the scenes: s1, s2, s3");

    expect(await storage.readText(rp.scene("s1"))).toBe(`${ex["hook-photo"].trim()}\n`);
    expect(await storage.exists(rp.scene("s3"))).toBe(false);
    const index = await storage.readText(rp.scenesIndex);
    expect(index).toContain('import S1 from "./s1.tsx";');
    expect(index).toContain("export default { s1: S1, s2: S2 };");

    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s3?.versions[0]).toMatchObject({ v: 1, guardOk: false, origin: "codegen" });
    expect(ledger.scenes.s3?.versions[0]?.violations.join("\n")).toMatch(/Date/);
    expect(await storage.exists(directorPaths(PROJECT_ID, 1).version("s3", 1))).toBe(true);
    expect(ctx.emitted.events.some((e) => e.type === "progress" && e.stage === "codegen")).toBe(true);
  });

  it("режим правки: лише вказані сцени, решта — контекст «тільки для читання»", async () => {
    const { storage } = await firstGeneration();
    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: ["s3"], instructions: [{ sceneId: "s3", instruction: "Зроби кнопку більшою" }] },
      [{ text: fileBlocks({ s3: ex["cta-logo"] }) }],
    );
    const res = await codegenStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s3"], guardRejected: [] });
    const user = userText(ctx.anthropic.calls[0]?.params);
    expect(user).toContain("Mode: subset");
    expect(user).toContain("s3: Зроби кнопку більшою");
    expect(user).toContain('<file name="s1.tsx">');
    expect(user).not.toContain('<file name="s3.tsx">');
    const index = await storage.readText(revPaths(PROJECT_ID, 1).scenesIndex);
    expect(index).toContain("s3: S3");
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s3?.current).toBe(2);
  });

  it("нова ревізія, sceneIds = [] → усі сцени копіюються з основи без виклику моделі", async () => {
    const { storage } = await firstGeneration();
    await seedProject(storage, { rev: 2 });
    const ctx = makeCtx(storage, "codegen", { sceneIds: [], instructions: [] }, [], { rev: 2 });
    const res = await codegenStage(ctx);
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(res.reused).toBe(true);
    const rp2 = revPaths(PROJECT_ID, 2);
    expect(await storage.exists(rp2.scene("s1"))).toBe(true);
    expect(await storage.exists(rp2.scene("s3"))).toBe(false); // у основі s3 відхилена guard'ом
    expect(await storage.readText(rp2.scenesIndex)).toContain("export default { s1: S1, s2: S2 };");
  });

  it("нова ревізія, sceneIds = null: незмінені сцени — за хешем входів, змінені — генеруються", async () => {
    const { storage } = await firstGeneration();
    const sb = structuredClone((await import("@adc/shared/fixtures")).fixtureStoryboard);
    (sb.scenes[1] as { motionIntent: string }).motionIntent = "ціна обертається";
    await seedProject(storage, { rev: 2, storyboard: sb });
    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      [{ text: fileBlocks({ s2: ex["offer-price"], s3: ex["cta-logo"] }) }],
      { rev: 2 },
    );
    const res = await codegenStage(ctx);
    expect(res.outputs.sceneIds).toEqual(["s2", "s3"]);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain('<file name="s1.tsx">');
    const ledger = await readLedger(storage, PROJECT_ID, 2);
    expect(ledger.scenes.s1?.versions[0]?.origin).toBe("carry");
  });

  it("відповідь без файлів — помилка стадії", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: "Вибачте, не можу." },
    ]);
    await expect(codegenStage(ctx)).rejects.toMatchObject({ code: "codegen_no_files" });
  });
});
