import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserLog,
  CheckReport,
  type LocalStorage,
  type RenderStillOptions,
  readTuning,
  revPaths,
  type ScenePreviewProps,
  STILL_PLAN,
} from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { createFixStage, FILM_OMITTED, fixStage } from "../src/stages/fix.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  qaLogLine,
  seedProject,
  systemText,
  tmpStorage,
  userText,
} from "./helpers.ts";
import { movingEngine } from "./strip-engine.ts";

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
    makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      Object.entries(scenes).map(([id, code]) => ({ text: fileBlocks({ [id]: code }) })),
    ),
  );
  return storage;
}

const readCheck = (storage: LocalStorage, rev = 1) =>
  storage.readJson(revPaths(PROJECT_ID, rev).check, (v) => CheckReport.parse(v));

/** Мок-рушій, що додає рядки логу залежно від кадру стілу (локальний хелпер B3). */
function frameLogEngine(byFrame: (o: RenderStillOptions) => string[]) {
  const engine = movingEngine();
  const render = engine.renderStill.bind(engine);
  engine.renderStill = async (o: RenderStillOptions) => {
    const res = await render(o);
    const extra: BrowserLog[] = byFrame(o).map((text) => ({ type: "log", text }));
    return { ...res, logs: [...res.logs, ...extra] };
  };
  return engine;
}

/** Імітує check.json, записаний до появи кадру `e`: лише стіли a/b. */
async function stripEStills(storage: LocalStorage, rev = 1): Promise<void> {
  const report = await readCheck(storage, rev);
  await storage.writeJson(revPaths(PROJECT_ID, rev).check, {
    ...report,
    stills: report.stills.filter((s) => s.variant !== "e"),
  });
}

const sceneOf = (o: RenderStillOptions) => (o.inputProps as ScenePreviewProps).sceneId;
/** Рендери стілів (без кадрів стрічки). */
const stillRenders = (engine: { stills: RenderStillOptions[] }) =>
  engine.stills.filter((o) => o.out.replaceAll("\\", "/").includes("/stills/"));
type Block = { type: string; text?: string; cache_control?: unknown };
const contentOf = (params: unknown) =>
  (params as { messages: Array<{ content: Block[] }> }).messages[0]?.content ?? [];
const filmOf = (params: unknown) =>
  /<film>\n([\s\S]*?)\n<\/film>/.exec(contentOf(params)[0]?.text ?? "")?.[1] ?? "";
const codeOf = (text: string) => (/<code>\n([\s\S]*?)\n<\/code>/.exec(text)?.[1] ?? "").trim();

/** autoIssues без `event_unused` (у фікстурі s2 має події, а еталонний код їх не знає). */
const withoutEvents = <T extends { kind: string }>(xs: T[]) => xs.filter((i) => i.kind !== "event_unused");

describe("checkStage (мок RenderEngine)", () => {
  it("типи по сценах, AST-guard, стіли у всіх форматах, autoIssues, аркуші", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: GUARD_BAD });
    const engine = movingEngine({
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
    // 3 стіли на сцену й формат на кадрах STILL_PLAN (25/50/90% від 150 кадрів)
    expect(STILL_PLAN.map((p) => p.variant)).toEqual(["e", "a", "b"]);
    expect(report.stills.map((s) => `${s.format}/${s.sceneId}-${s.variant}@${s.frame}`).sort()).toEqual([
      "square/s1-a@75",
      "square/s1-b@135",
      "square/s1-e@38",
      "vertical/s1-a@75",
      "vertical/s1-b@135",
      "vertical/s1-e@38",
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
    // аркуш для людини: три рядки (e, a, b) мініатюр 270×480 з підписами
    expect(meta.height).toBe(8 + 3 * (480 + 28 + 8));

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
    const engine = movingEngine({ fail: { s2: "TypeError: cannot read properties of undefined" } });
    const res = await createCheckStage({ engine: () => engine })(
      makeCtx(storage, "check", { sceneIds: null }),
    );
    expect(res.outputs.failedScenes).toEqual(["s2"]);
    const report = await readCheck(storage);
    expect(report.runtimeErrors.map((e) => [e.sceneId, e.format])).toEqual([
      ["s2", "vertical"],
      ["s2", "vertical"],
      ["s2", "vertical"],
      ["s2", "square"],
      ["s2", "square"],
      ["s2", "square"],
    ]);
    expect(report.compileErrors).toEqual([]);
    const s3 = engine.stills.filter((s) => (s.inputProps as ScenePreviewProps).sceneId === "s3");
    expect(s3).toHaveLength(6);
    expect((s3[0]?.inputProps as ScenePreviewProps | undefined)?.useTemplate).toBe(true);
    expect(engine.closed).toBe(1);
  });

  it("помилка бандла на сцені → compileError цієї сцени і повтор без неї; невідома — помилка стадії", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    const engine = movingEngine({
      bundleError: (n) =>
        n === 1 ? "Module build failed: /data/rev/1/video/scenes/s2.tsx: Unexpected token" : null,
    });
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual(["s2"]);
    expect(engine.bundles).toHaveLength(2);
    expect((await readCheck(storage)).compileErrors[0]?.message).toMatch(/^bundle: /);

    const broken = movingEngine({ bundleError: () => "rspack crashed" });
    await expect(
      createCheckStage({ engine: broken })(makeCtx(storage, "check", { sceneIds: null })),
    ).rejects.toMatchObject({
      code: "check_bundle_failed",
    });
    expect((await readCheck(storage)).bundleError).toBe("rspack crashed");
  });

  it("нова ревізія: незмінені сцени переносяться (код і стіли) без рендера", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    await seedProject(storage, { rev: 2 });
    const engine = movingEngine();
    const res = await createCheckStage({ engine })(
      makeCtx(storage, "check", { sceneIds: null }, [], { rev: 2 }),
    );
    expect(engine.stills).toHaveLength(0);
    expect(res.reused).toBe(true);
    const report = await readCheck(storage, 2);
    expect(report.stills).toHaveLength(18); // 3 сцени × 2 формати × STILL_PLAN
    expect(report.stills.filter((s) => s.variant === "e")).toHaveLength(6);
    expect(await storage.exists(revPaths(PROJECT_ID, 2).still("vertical", "s1", "e"))).toBe(true);
    expect(report.stills[0]?.path).toContain("/rev/2/");
    expect(await storage.exists(revPaths(PROJECT_ID, 2).scene("s1"))).toBe(true);

    // змінена сцена s2 знімається, решта — з основи
    const engine3 = movingEngine();
    await seedProject(storage, { rev: 3 });
    await storage.write(revPaths(PROJECT_ID, 3).scene("s2"), ex.typographic);
    await createCheckStage({ engine: engine3 })(
      makeCtx(storage, "check", { sceneIds: ["s2"] }, [], { rev: 3 }),
    );
    // стіли — лише змінена s2; перші кадри s3 рендеряться для склейки в аркуші моментів s2
    expect(new Set(stillRenders(engine3).map((s) => (s.inputProps as ScenePreviewProps).sceneId))).toEqual(
      new Set(["s2"]),
    );
    expect((await readCheck(storage, 3)).stills).toHaveLength(18);
  });

  it("autoIssues з кадру e (25%) не йдуть у звіт, сам стіл e є", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    const eFrame = 38; // s1: 25% від 150 кадрів
    const engine = frameLogEngine((o) =>
      sceneOf(o) !== "s1"
        ? []
        : o.frame === eFrame
          ? [qaLogLine("outside_safe_area", "headline ще влітає")]
          : [qaLogLine("text_overflow", "headline не вліз")],
    );
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(engine.stills.filter((o) => sceneOf(o) === "s1" && o.frame === eFrame)).toHaveLength(2);
    const report = await readCheck(storage);
    expect(withoutEvents(report.autoIssues).map((i) => [i.sceneId, i.format, i.kind])).toEqual([
      ["s1", "vertical", "text_overflow"],
      ["s1", "square", "text_overflow"],
    ]);
    expect(withoutEvents(report.autoIssues).every((i) => i.frame !== eFrame)).toBe(true);
    expect(report.stills.filter((s) => s.sceneId === "s1" && s.variant === "e")).toHaveLength(2);
    expect(res.outputs.issueScenes).toEqual(["s1", "s2"]);

    // лише кадр e «скаржиться» → сцена без autoIssues
    const storage2 = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    const res2 = await createCheckStage({
      engine: frameLogEngine((o) =>
        o.frame === eFrame ? [qaLogLine("text_overflow", "ще з'являється")] : [],
      ),
    })(makeCtx(storage2, "check", { sceneIds: null }));
    // лишається тільки event_unused сцени s2 (події price-hit, badge-in не згадані в коді)
    expect(res2.outputs.issueScenes).toEqual(["s2"]);
    expect((await readCheck(storage2)).autoIssues.map((i) => [i.sceneId, i.kind, i.frame])).toEqual([
      ["s2", "event_unused", 30],
      ["s2", "event_unused", 60],
    ]);
  });

  it("старий check.json (лише a/b): основа не перевикористовується, нецільові сцени знімаються заново", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    await stripEStills(storage, 1);
    expect((await readCheck(storage, 1)).stills).toHaveLength(12); // старий формат парситься

    // нова ревізія: хеш входів збігся, але стілів основи 2 × 2 ≠ formats × STILL_PLAN → рендер
    await seedProject(storage, { rev: 2 });
    const engine2 = movingEngine();
    const res2 = await createCheckStage({ engine: engine2 })(
      makeCtx(storage, "check", { sceneIds: null }, [], { rev: 2 }),
    );
    expect(res2.reused).toBeUndefined();
    expect(stillRenders(engine2)).toHaveLength(18);
    expect((await readCheck(storage, 2)).stills).toHaveLength(18);

    // та сама ревізія: правка s2, а s1/s3 без кадру e у check.json → теж знімаються
    await stripEStills(storage, 2);
    const engine3 = movingEngine();
    await createCheckStage({ engine: engine3 })(
      makeCtx(storage, "check", { sceneIds: ["s2"] }, [], { rev: 2 }),
    );
    expect(new Set(engine3.stills.map(sceneOf))).toEqual(new Set(["s1", "s2", "s3"]));
    expect((await readCheck(storage, 2)).stills).toHaveLength(18);
  });
});

describe("fixStage (записані відповіді LLM)", () => {
  it("виправляє сцени паралельно за помилками check; новий код проходить AST-guard", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: GUARD_BAD });
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const recorded = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
    const reply = (params: unknown) =>
      userText(params).includes("Repair scene s2")
        ? { text: recorded("fix-s2.txt") }
        : { text: recorded("fix-s3.txt") };
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s2", "s3"], reason: "check" }, [reply, reply]);
    const res = await fixStage(ctx);
    expect(res.outputs.sceneIds.sort()).toEqual(["s2", "s3"]);

    const prompts = ctx.anthropic.calls.map((c) => userText(c.params));
    const s2Prompt = prompts.find((p) => p.includes("Repair scene s2")) ?? "";
    expect(s2Prompt).toMatch(/TS\d+:.*huge/);
    expect(s2Prompt).toContain("<logo_hint>\nThe logo is vector (SVG)");
    expect(s2Prompt).toContain('size="huge"');
    const s3Prompt = prompts.find((p) => p.includes("Repair scene s3")) ?? "";
    expect(s3Prompt).toMatch(/AST-guard[\s\S]*Date/);
    // film-блок: s1 і s2 (TS-помилка — не guard), без s3 (відхилена guard'ом), один на всі виклики
    const film = filmOf(ctx.anthropic.calls[0]?.params);
    expect(film).toContain('<file name="s1.tsx">');
    expect(film).toContain('<file name="s2.tsx">');
    expect(film).not.toContain('<file name="s3.tsx">');
    for (const c of ctx.anthropic.calls) expect(filmOf(c.params)).toBe(film);
    expect(codeOf(s2Prompt)).toBe("(the current code of this scene is the file s2.tsx in <film>)");
    expect(codeOf(s3Prompt)).toContain("new Date");
    // наскрізний об'єкт розкадровки доходить до ремонту (у фікстурі його немає — null)
    expect(s2Prompt).toContain("<throughline>\nnull\n</throughline>");
    // ремонт знає правила курсора, камери, blur і наскрізного об'єкта (R2–R4, R6) і як лагодити «object»
    const system = systemText(ctx.anthropic.calls[0]?.params);
    expect(system).toContain("- **The cursor:** In an interface mock nothing changes by itself.");
    expect(system).toContain("- **The camera:** `Camera` is the scene's virtual camera.");
    expect(system).toContain("- **Motion blur:** `MotionBlur` wraps fast moves");
    expect(system).toContain("- **The throughline:** Build the throughline literally.");
    expect(system).toContain(
      "  - `Showreel bar · object` → the throughline object is missing or cut at the join",
    );

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
    const res2 = await createCheckStage({ engine: movingEngine() })(
      makeCtx(storage, "check", { sceneIds: ["s2", "s3"] }),
    );
    expect(res2.outputs.failedScenes).toEqual([]);
    expect((await readCheck(storage)).stills).toHaveLength(18);
  });

  it("ADC_FIX_CHECK_CONTEXT=own: лише TS / AST-guard → без коду фільму, свій код у <code>; runtime-помилка → film", async () => {
    const storage = await generated({ s1: ex["hook-photo"], s2: TS_BAD, s3: GUARD_BAD });
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const recorded = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
    const reply = (params: unknown) =>
      userText(params).includes("Repair scene s2")
        ? { text: recorded("fix-s2.txt") }
        : { text: recorded("fix-s3.txt") };
    const run = async (env: Record<string, string>) => {
      const ctx = makeCtx(storage, "fix", { sceneIds: ["s2", "s3"], reason: "check" }, [reply, reply]);
      await createFixStage({ tuning: () => readTuning(env) })(ctx);
      return ctx.anthropic.calls.map((c) => c.params);
    };
    const own = { ADC_FIX_CHECK_CONTEXT: "own", ADC_FIX_CHECK_EFFORT: "medium" };

    const calls = await run(own);
    expect(calls).toHaveLength(3); // прогрів + 2 сцени
    for (const p of calls) {
      expect(filmOf(p)).toBe(FILM_OMITTED);
      expect(userText(p)).not.toContain('<file name="s1.tsx">');
      expect((p as { output_config: { effort: string } }).output_config.effort).toBe("medium");
    }
    const tail = (id: string) => userText(calls.find((p) => userText(p).includes(`Repair scene ${id}`)));
    expect(codeOf(tail("s2"))).toContain('size="huge"');
    expect(codeOf(tail("s3"))).toContain("new Date");
    expect(contentOf(calls[1]).map((b) => b.type)).toEqual(["text", "text"]);
    expect(contentOf(calls[1])[0]).toEqual(contentOf(calls[0])[0]);

    // runtime-помилка хоч в одній цілі → film для всіх
    const rp = revPaths(PROJECT_ID, 1);
    const report = await readCheck(storage);
    await storage.writeJson(rp.check, {
      ...report,
      runtimeErrors: [{ sceneId: "s3", format: "vertical", frame: 10, message: "boom" }],
    });
    const withRuntime = await run(own);
    for (const p of withRuntime) expect(filmOf(p)).toContain('<file name="s1.tsx">');

    // дефолт film і без runtime-помилок
    await storage.writeJson(rp.check, report);
    for (const p of await run({})) expect(filmOf(p)).toContain('<file name="s1.tsx">');
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
