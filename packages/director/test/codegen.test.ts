import { createPromptLoader, readTuning, revPaths } from "@adc/shared";
import { fixtureBrandKitFile } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { type CodegenContext, contextVars, logoGeometryHint, logoIsVector } from "../src/context.ts";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { CodegenReport, createCodegenStage } from "../src/stages/codegen.ts";
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

/** Правила R1–R4, R6 (ТЗ «прогалини якості» §2.7) — у промпті code-fix дослівно. */
const FILM_RULES = [
  "Nothing enters at rest and nothing leaves at rest. An element is already moving on its first visible frame (it arrives from off-frame, from a smaller scale, from behind a mask or a colour field) and it leaves accelerating (`easings.in`-like, never slowing down and fading out in place). A hit may land up to one frame before its event frame, never after it: the landing is seen on the beat, the sound is on the event frame.",
  "In an interface mock nothing changes by itself. Every change of state (a field filling, a toggle, a row selected, a slider moved, a button pressed) is caused by the `Cursor`: it travels to the control (`path`), grows on arrival (`hoverAt`), squeezes on the click (`clickAt`), and the control reacts on that same frame. One cursor per scene, one action at a time; a mock that changes without the cursor is `off_brief`.",
  "`Camera` is the scene's virtual camera. It pushes into the active zone of a mock (the field being typed, the row being ticked) and pulls back out. Never two camera moves at once and never a camera move during a cursor move: the push starts after the cursor arrives, the pull-back after the control has reacted. Text that must be read stays inside the camera's rectangle for its reading time.",
  "`MotionBlur` wraps fast moves (a card flying in, a colour field pushing, kinetic text on an energetic brand) so they read as motion, not as a strobe. Use it on elements that travel more than about a quarter of the frame within six frames; never on text while it is being read; never on the whole scene; at most two `MotionBlur` wrappers active in one frame (each multiplies the render cost of its subtree by `samples`).",
  "Build the throughline literally. In every scene the object named in `<storyboard>.throughline` is on screen in the state its entry gives, and at the join it transforms into its next state (`MorphShape`, `DrawPath`, `LogoPath`, your own `<svg>`): the same geometry, colour and position on the last frame of one scene and the first frame of the next. When `throughline` is null, keep the match cuts as before.",
];
const BAD = ex["cta-logo"].replace("const dark =", "const year = new Date().getFullYear();\n  const dark =");

/** Послідовний режим із відкатом до WIP-поведінки (P0): anchor `xhigh`, решта `high`. */
const codegenStage = createCodegenStage({
  tuning: () =>
    readTuning({
      ADC_CODEGEN_MODE: "sequential",
      ADC_CODEGEN_ANCHOR_EFFORT: "xhigh",
      ADC_CODEGEN_REST_EFFORT: "high",
    }),
});

type Params = {
  output_config?: { effort?: string };
  messages: Array<{ content: Array<{ type: string; text?: string; cache_control?: unknown }> }>;
};
const paramsOf = (p: unknown) => p as Params;

async function firstGeneration() {
  const storage = tmpStorage();
  await seedProject(storage);
  const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
    { text: `Ось сцена:\n${fileBlocks({ s1: ex["hook-photo"] })}` },
    { text: fileBlocks({ s2: ex["offer-price"] }) },
    { text: fileBlocks({ s3: BAD }) },
  ]);
  const res = await codegenStage(ctx);
  return { storage, ctx, res };
}

describe("codegenStage (sequential)", () => {
  it("перша генерація: сцена за стрім-виклик (anchor, далі continue), AST-guard, реєстр", async () => {
    const { storage, ctx, res } = await firstGeneration();
    const rp = revPaths(PROJECT_ID, 1);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s3"] });
    expect(ctx.anthropic.calls).toHaveLength(3);
    expect(ctx.anthropic.calls.every((c) => c.method === "stream")).toBe(true);
    const system = systemText(ctx.anthropic.calls[0]?.params);
    expect(system).toContain("useFormat"); // декларації motion-kit
    expect(system).toContain("registerRoot"); // вендорний system prompt Remotion
    expect(system).toContain("examples/hook-photo.tsx");

    const [u1, u2, u3] = ctx.anthropic.calls.map((c) => userText(c.params));
    expect(u1).toContain("Mode: anchor");
    expect(u1).toContain("Generate the scenes: s1.");
    expect(u1).not.toContain('<file name="s1.tsx">');
    expect(u2).toContain("Mode: continue");
    expect(u2).toContain("Generate the scenes: s2.");
    expect(u2).toContain('<file name="s1.tsx">');
    expect(u3).toContain('<file name="s2.tsx">');
    expect(u3).toContain("Generate the scenes: s3.");
    const effort = (i: number) => paramsOf(ctx.anthropic.calls[i]?.params).output_config?.effort;
    expect(effort(0)).toBe("xhigh"); // ADC_CODEGEN_ANCHOR_EFFORT
    expect(effort(1)).toBe("high"); // ADC_CODEGEN_REST_EFFORT

    // Спільна частина user-повідомлення в послідовному режимі унікальна — без cache_control.
    for (const c of ctx.anthropic.calls) {
      const [cached, tail] = paramsOf(c.params).messages[0]?.content ?? [];
      expect(cached?.text).toContain("<storyboard>");
      expect(cached?.cache_control).toBeUndefined();
      expect(tail?.text).toMatch(/^Mode: \w+\.\nGenerate the scenes: s\d\.$/);
    }

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
    expect(paramsOf(ctx.anthropic.calls[0]?.params).output_config?.effort).toBe("high");
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
      [{ text: fileBlocks({ s2: ex["offer-price"] }) }, { text: fileBlocks({ s3: ex["cta-logo"] }) }],
      { rev: 2 },
    );
    const res = await codegenStage(ctx);
    expect(res.outputs.sceneIds).toEqual(["s2", "s3"]);
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("Mode: subset");
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain('<file name="s1.tsx">');
    const ledger = await readLedger(storage, PROJECT_ID, 2);
    expect(ledger.scenes.s1?.versions[0]?.origin).toBe("carry");
  });

  it("відповідь без файлів — помилка стадії", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: "Вибачте, не можу." },
      { text: "Вибачте, не можу." },
      { text: "Вибачте, не можу." },
    ]);
    await expect(codegenStage(ctx)).rejects.toMatchObject({ code: "codegen_no_files" });
  });

  it("збій виклику однієї сцени: сцена в missing, наступні генеруються, стадія ok", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: fileBlocks({ s1: ex["hook-photo"] }) },
      { error: new Error("boom") },
      { text: fileBlocks({ s3: ex["cta-logo"] }) },
    ]);
    const res = await codegenStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s2"] });
    // s3 бачить лише s1: у s2 коду немає.
    const u3 = userText(ctx.anthropic.calls[2]?.params);
    expect(u3).toContain("Mode: continue");
    expect(u3).toContain('<file name="s1.tsx">');
    expect(u3).not.toContain('<file name="s2.tsx">');
    const report = await storage.readJson(directorPaths(PROJECT_ID, 1).codegen, (v) =>
      CodegenReport.parse(v),
    );
    expect(report.missing).toEqual(["s2"]);
    expect(report.violations.s2?.[0]).toMatch(/boom/);
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions[0]).toMatchObject({ missing: true, guardOk: false });
  });

  it("скасування посеред генерації: готові сцени записані, повтор продовжує з першої незгенерованої", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const abort = new AbortController();
    const failing = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: fileBlocks({ s1: ex["hook-photo"] }) },
      () => {
        abort.abort();
        return { error: new Error("aborted") };
      },
    ]);
    failing.signal = abort.signal;
    await expect(codegenStage(failing)).rejects.toThrow(/aborted/);
    expect(await storage.exists(revPaths(PROJECT_ID, 1).scene("s1"))).toBe(true);

    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      [{ text: fileBlocks({ s2: ex["offer-price"] }) }, { text: fileBlocks({ s3: ex["cta-logo"] }) }],
      { attempt: 2 },
    );
    const res = await codegenStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: [] });
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("Mode: continue");
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("Generate the scenes: s2.");
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s1?.versions).toHaveLength(1);
  });

  it("logoGeometryHint: векторність лого з бренд-кіта (svg + assetId), без бренду — правило за logo.type", () => {
    const svg = { type: "svg", assetId: "a02" } as const;
    expect(logoIsVector(svg)).toBe(true);
    expect(logoIsVector({ type: "svg", assetId: null })).toBe(false);
    expect(logoIsVector({ type: "image", assetId: "a01" })).toBe(false);
    expect(logoGeometryHint(svg)).toMatch(/^The logo is vector \(SVG\)/);
    expect(logoGeometryHint(svg)).toContain("fall back to `<Logo>`");
    expect(logoGeometryHint({ type: "image", assetId: "a01" })).toMatch(/^The logo is a raster image/);
    expect(logoGeometryHint({ type: "text", assetId: null })).toMatch(/^The brand has no logo image/);
    expect(logoGeometryHint(null)).toContain("Look at `logo.type` in `<brand>`");

    const context: CodegenContext = {
      remotionSystemPrompt: "R",
      motionKitApi: "A",
      motionKitDeclarations: "D",
      examples: {},
      examplesText: "E",
      hash: "h",
    };
    // без бренду (так кличуть codegen / fix) — загальна підказка; з бренд-кітом — конкретна
    expect(contextVars(context).logoGeometryHint).toBe(logoGeometryHint(null));
    expect(contextVars(context, fixtureBrandKitFile).logoGeometryHint).toBe(logoGeometryHint(svg));
    expect(contextVars(context)).toMatchObject({ examples: "E", motionKitApi: "A" });
  });

  it("промпт code-fix: ті самі правила фільму, що й codegen (кольори, stage, mono, макет, eyebrow/status, лого)", () => {
    const fix = createPromptLoader().load("code-fix", {
      remotionSystemPrompt: "R",
      motionKitApi: "A",
      motionKitDeclarations: "D",
      examples: "E",
      logoGeometryHint: "LOGO",
      brand: {},
      assets: [],
      concept: "-",
      throughline: null,
      scene: {},
      readonlyScenes: "-",
      code: "-",
      problems: "-",
      language: "uk",
      formats: "vertical",
      reason: "qa",
      sceneId: "s1",
    });
    expect(fix.system).toContain("the semantic `danger`, `warning`, `success`");
    expect(fix.system).toContain("`mix(a, b, t)` for tints and shades");
    expect(fix.system).toContain('`Backdrop variant="stage"`');
    expect(fix.system).toContain("`theme.fonts.mono`");
    expect(fix.system).toContain("**`eyebrow` and `status` items are in the frame**");
    expect(fix.system).toContain("**Layout:** the scene's main container");
    expect(fix.system).toContain("`useLogoGeometry()` returns `{ viewBox, paths }`");
    // зауваження рубрики QA «Showreel bar» — як їх лагодити
    expect(fix.system).toContain("a remark that starts with `Showreel bar`");
    // R1–R4, R6 дослівно — у правилах фільму, які ремонт не ламає; object — у типових ремонтах
    const filmRules = fix.system.slice(
      fix.system.indexOf("# Film rules"),
      fix.system.indexOf("# Output format"),
    );
    for (const rule of FILM_RULES) expect(filmRules).toContain(rule);
    const repairs = fix.system.slice(
      fix.system.indexOf("- Typical repairs:"),
      fix.system.indexOf("# Hard rules"),
    );
    expect(repairs).toContain(
      "`Showreel bar · object` → the throughline object is missing or cut at the join: put the object back into the frame in the state from `throughline`",
    );
    expect(repairs).toContain("and make the transformation at the join");
    expect(repairs).toContain("«Camera: два рухи одночасно»");
  });

  it("усі виклики впали — помилка стадії з кодом LLM", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { error: new Error("boom") },
      { error: new Error("boom") },
      { error: new Error("boom") },
    ]);
    await expect(codegenStage(ctx)).rejects.toMatchObject({ code: "llm_api" });
  });
});
