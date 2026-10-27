import {
  CheckReport,
  type Llm,
  type LocalStorage,
  type MockReply,
  type QaReport,
  readCosts,
  readTuning,
  revPaths,
} from "@adc/shared";
import { fixtureBrandKitFile } from "@adc/shared/fixtures";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardOptions } from "../src/guard.ts";
import { addVersion, readLedger, writeLedger } from "../src/ledger.ts";
import { stripSheetLayout } from "../src/sheets.ts";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { createFixStage } from "../src/stages/fix.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  type Reply,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";
import { movingEngine } from "./strip-engine.ts";

/** Опції кожного виклику guardScene (обгортка над справжнім guard). */
const guardCalls = vi.hoisted(() => [] as Array<{ code: string; opts: GuardOptions }>);
vi.mock("../src/guard.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/guard.ts")>();
  return {
    ...mod,
    guardScene: (code: string, opts: GuardOptions = {}) => {
      guardCalls.push({ code, opts });
      return mod.guardScene(code, opts);
    },
  };
});

const ex = exampleSources();
const CODE: Record<string, string> = { s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] };

type Block = {
  type: string;
  text?: string;
  cache_control?: unknown;
  source?: { type: string; media_type?: string; data?: string };
};
type Params = {
  model: string;
  max_tokens: number;
  thinking?: unknown;
  output_config?: { effort?: string };
  system: Block[];
  messages: Array<{ content: Block[] }>;
};
const paramsOf = (p: unknown) => p as Params;
const sceneOf = (params: unknown) => /Repair scene (\w+) /.exec(userText(params))?.[1];

/** Стадія з `Tuning` з цього env. */
const stageWith = (env: Record<string, string> = {}) => createFixStage({ tuning: () => readTuning(env) });

/** Відповіді за сценою з хвоста промпта — не залежать від порядку паралельних викликів. */
function byScene(ids: readonly string[]): Reply[] {
  return ids.map(() => (params: unknown): MockReply => {
    const id = sceneOf(params);
    const code = id ? CODE[id] : undefined;
    if (!id || !code) throw new Error(`немає відповіді для сцени ${id}`);
    return { text: fileBlocks({ [id]: code }) };
  });
}

/** Журнал викликів моделі: warm і початок text-виклику сцени. */
function traceLlm(ctx: { llm: Llm }): string[] {
  const log: string[] = [];
  const { text, warm } = ctx.llm;
  ctx.llm = {
    ...ctx.llm,
    text: async (name, vars, opts) => {
      log.push(`text:${(vars as { sceneId: string }).sceneId}`);
      return text(name, vars, opts);
    },
    warm: async (name, vars, opts) => {
      log.push("warm");
      return warm(name, vars, opts);
    },
  };
  return log;
}

/** Проєкт (vertical + square) зі згенерованими сценами s1–s3 і check.json зі стілами e/a/b. */
async function checked(): Promise<LocalStorage> {
  const storage = tmpStorage();
  await seedProject(storage);
  await codegenStage(
    makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      Object.entries(CODE).map(([id, code]) => ({ text: fileBlocks({ [id]: code }) })),
    ),
  );
  await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
  return storage;
}

async function writeQa(storage: LocalStorage, sceneIds: readonly string[]): Promise<void> {
  const report: QaReport = {
    verdict: "fix",
    issues: sceneIds.map((sceneId) => ({
      sceneId,
      format: "vertical",
      severity: "major",
      kind: "clipped_text",
      description: `заголовок ${sceneId} обрізано`,
      fix: "зменшити size до lg",
    })),
    summary: "-",
  };
  await storage.writeJson(revPaths(PROJECT_ID, 1).qa, report);
}

const images = (p: Params) => (p.messages[0]?.content ?? []).filter((b) => b.type === "image");
/** Типи блоків user-повідомлення; `text+cache` — текст з `cache_control`. */
const shape = (p: Params) =>
  (p.messages[0]?.content ?? []).map((b) => (b.type === "text" && b.cache_control ? "text+cache" : b.type));
/** Перший блок user-повідомлення — бренд, концепт і код фільму (`<film>`). */
const filmBlock = (p: Params) => p.messages[0]?.content[0]?.text ?? "";
const filmOf = (text: string) => /<film>\n([\s\S]*?)\n<\/film>/.exec(text)?.[1] ?? "";
const codeOf = (text: string) => (/<code>\n([\s\S]*?)\n<\/code>/.exec(text)?.[1] ?? "").trim();

describe("fixStage: кадри для qa, прогрів, effort", () => {
  beforeEach(() => {
    guardCalls.length = 0;
  });

  it("qa: [film-блок з кешем, аркуші стрічки обраних форматів (що є в check.json), хвіст], JPEG ≤ 1568, легенда; warm перед паралельними", async () => {
    const storage = await checked();
    // s2 без стілів square — лише одне зображення
    const rp = revPaths(PROJECT_ID, 1);
    const check = await storage.readJson(rp.check, (v) => CheckReport.parse(v));
    await storage.writeJson(rp.check, {
      ...check,
      stills: check.stills.filter((s) => !(s.sceneId === "s2" && s.format === "square")),
    });
    await writeQa(storage, ["s1", "s2"]);

    // fixCheckEffort не стосується qa: effort із frontmatter
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s1", "s2"], reason: "qa" }, byScene(["s1", "s2"]));
    const log = traceLlm(ctx);
    const res = await stageWith({ ADC_FIX_CHECK_EFFORT: "low" })(ctx);
    expect(res.outputs.sceneIds.sort()).toEqual(["s1", "s2"]);

    expect(log).toEqual(["warm", "text:s1", "text:s2"]);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls).toHaveLength(3);
    const [warm, ...rest] = calls as [Params, ...Params[]];
    expect(warm.max_tokens).toBe(0);
    expect(shape(warm)).toEqual(["text+cache"]);
    const film = filmBlock(warm);
    expect(warm.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
    // film-блок: код усіх сцен фільму, зі своєю і сусідами
    for (const id of ["s1", "s2", "s3"]) expect(filmOf(film)).toContain(`<file name="${id}.tsx">`);

    const bySceneId = Object.fromEntries(rest.map((p) => [sceneOf(p), p]));
    const expected: Record<string, string[]> = { s1: ["vertical", "square"], s2: ["vertical"] };
    for (const [id, formats] of Object.entries(expected)) {
      const p = bySceneId[id] as Params;
      const content = p.messages[0]?.content ?? [];
      // film-блок (той самий, що в прогріві, з cache_control 5m), далі кадри, далі хвіст
      expect(shape(p)).toEqual(["text+cache", ...formats.map(() => "image"), "text"]);
      expect(content[0]).toEqual(warm.messages[0]?.content[0]);
      expect(content.at(-1)?.text?.startsWith("<scene>")).toBe(true);
      expect(codeOf(userText(p))).toBe(`(the current code of this scene is the file ${id}.tsx in <film>)`);
      for (const img of images(p)) {
        expect(img.source?.media_type).toBe("image/jpeg");
        const meta = await sharp(Buffer.from(img.source?.data ?? "", "base64")).metadata();
        expect(meta.format).toBe("jpeg");
        expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1568);
      }
      // аркуш стрічки сцени (s1 — 150 кадрів → 10, s2 — 165 → 11 кадрів)
      const first = await sharp(Buffer.from(images(p)[0]?.source?.data ?? "", "base64")).metadata();
      const layout = stripSheetLayout("vertical", id === "s1" ? 10 : 11);
      expect({ width: first.width, height: first.height }).toEqual({
        width: layout.width,
        height: layout.height,
      });

      const text = userText(p);
      for (const [i, f] of formats.entries()) {
        expect(text).toContain(`Image ${i + 1}: scene ${id}, format ${f}, strip of`);
      }
      expect(text).not.toContain(`Image ${formats.length + 1}:`);
      expect(text).toContain("The frames show the actual state; the remarks below say what to change.");
      expect(text).toContain(`заголовок ${id} обрізано`);
      expect(text.indexOf("Image 1:")).toBeLessThan(text.indexOf("Art director's remarks"));
      // effort — frontmatter (ADC_FIX_EFFORT не задано), ті самі model / system, що в прогріві
      expect(p.output_config?.effort).toBe("high");
      expect(p.model).toBe(warm.model);
      expect(p.system).toEqual(warm.system);
    }
    expect(warm.output_config?.effort).toBe("high");

    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "code-fix");
    expect(costs.map((e) => e.detail).sort()).toEqual(["scene:s1", "scene:s2", "warm"]);
  });

  it("check: без зображень; effort з Tuning.fixCheckEffort у прогріві й викликах; спільний userCached", async () => {
    const storage = await checked();
    await writeQa(storage, ["s1", "s2", "s3"]);
    const ctx = makeCtx(
      storage,
      "fix",
      { sceneIds: ["s1", "s2", "s3"], reason: "check" },
      byScene(["s1", "s2", "s3"]),
    );
    const log = traceLlm(ctx);
    const res = await stageWith({ ADC_FIX_CHECK_EFFORT: "medium" })(ctx);
    expect(res.outputs.sceneIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(log).toEqual(["warm", "text:s1", "text:s2", "text:s3"]);

    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls).toHaveLength(4);
    const [warm, ...rest] = calls as [Params, ...Params[]];
    expect(warm.max_tokens).toBe(0);
    expect(warm.output_config?.effort).toBe("medium");
    const cached = warm.messages[0]?.content[0];
    expect(cached?.cache_control).toEqual({ type: "ephemeral" });
    expect(cached?.text).toContain("<brand>");
    expect(cached?.text).not.toContain("<code>");
    // код фільму в порядку розкадровки — у кешованому блоці
    const film = filmOf(cached?.text ?? "");
    const at = ["s1", "s2", "s3"].map((id) => film.indexOf(`<file name="${id}.tsx">`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(film).toContain(CODE.s3?.trim().slice(0, 200));
    for (const p of rest) {
      expect(shape(p)).toEqual(["text+cache", "text"]);
      expect(p.model).toBe(warm.model);
      expect(p.output_config?.effort).toBe("medium");
      expect(p.system).toEqual(warm.system);
      expect(p.messages[0]?.content[0]).toEqual(cached);
      // зауваження QA для check не потрапляють у промпт, як і легенда кадрів
      expect(userText(p)).not.toContain("Image 1:");
      expect(userText(p)).not.toContain("обрізано");
    }
  });

  it("check без fixCheckEffort → effort із frontmatter; одна ціль → без прогріву і без cache_control на film-блоці", async () => {
    const storage = await checked();
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s2"], reason: "check" }, byScene(["s2"]));
    const log = traceLlm(ctx);
    await stageWith()(ctx);
    expect(log).toEqual(["text:s2"]);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.max_tokens).toBe(64000);
    expect(calls[0]?.output_config?.effort).toBe("high");
    expect(calls[0]?.messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(calls[0] && shape(calls[0])).toEqual(["text", "text"]);
    expect(filmOf(calls[0] ? filmBlock(calls[0]) : "")).toContain('<file name="s2.tsx">');
  });

  it("ADC_FIX_EFFORT: qa бере його в прогріві й викликах; check — fixCheckEffort, без нього — frontmatter", async () => {
    const effortsOf = async (reason: "qa" | "check", env: Record<string, string>) => {
      const storage = await checked();
      await writeQa(storage, ["s1", "s2"]);
      const ctx = makeCtx(storage, "fix", { sceneIds: ["s1", "s2"], reason }, byScene(["s1", "s2"]));
      await stageWith(env)(ctx);
      const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
      expect(calls[0]?.max_tokens).toBe(0);
      expect(calls).toHaveLength(3);
      return calls.map((p) => p.output_config?.effort);
    };
    expect(await effortsOf("qa", { ADC_FIX_EFFORT: "medium", ADC_FIX_CHECK_EFFORT: "low" })).toEqual([
      "medium",
      "medium",
      "medium",
    ]);
    expect(await effortsOf("check", { ADC_FIX_EFFORT: "medium", ADC_FIX_CHECK_EFFORT: "low" })).toEqual([
      "low",
      "low",
      "low",
    ]);
    expect(await effortsOf("check", { ADC_FIX_EFFORT: "medium" })).toEqual(["high", "high", "high"]);
  });

  it("qa з однією ціллю: кадри після film-блоку, без прогріву і без cache_control", async () => {
    const storage = await checked();
    await writeQa(storage, ["s3"]);
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s3"], reason: "qa" }, byScene(["s3"]));
    const log = traceLlm(ctx);
    await stageWith()(ctx);
    expect(log).toEqual(["text:s3"]);
    const [call] = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(call && shape(call)).toEqual(["text", "image", "image", "text"]);
    expect(call?.messages[0]?.content[0]?.text).toContain("<film>");
    expect(userText(call)).toContain("Image 2: scene s3, format square, strip of 11 frames");
  });

  it("film-блок: код усіх сцен, зі своєю, без шаблонних і відхилених guard'ом; відхилена своя — у <code>; guard — з allowedScreenTexts", async () => {
    const storage = await checked();
    await storage.writeJson(revPaths(PROJECT_ID, 1).pipeline, {
      attempts: {},
      fixRounds: {},
      qaRounds: 0,
      templateScenes: ["s3"],
      dirtyScenes: [],
    });
    // поточна версія s2 відхилена guard'ом
    const rejected = CODE.s2?.replace(
      "export default",
      "const year = new Date().getFullYear();\nexport default",
    );
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    await addVersion(storage, PROJECT_ID, 1, ledger, "s2", {
      origin: "fix",
      code: rejected ?? null,
      guardOk: false,
      violations: ["Date заборонено"],
      now: new Date("2026-10-27T10:00:00.000Z"),
    });
    await writeLedger(storage, PROJECT_ID, 1, ledger);
    await writeQa(storage, ["s1", "s2"]);
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s1", "s2"], reason: "qa" }, byScene(["s1", "s2"]));
    guardCalls.length = 0;
    await stageWith()(ctx);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    const [warm, ...rest] = calls as [Params, ...Params[]];
    const film = filmOf(filmBlock(warm));
    expect(film).toContain('<file name="s1.tsx">');
    expect(film).toContain(CODE.s1?.trim().slice(0, 200));
    expect(film).not.toContain('<file name="s2.tsx">'); // відхилена guard'ом
    expect(film).not.toContain('<file name="s3.tsx">'); // шаблонна сцена — без коду
    for (const p of rest) expect(filmBlock(p)).toBe(filmBlock(warm));
    const prompts = Object.fromEntries(rest.map((p) => [sceneOf(p), userText(p)]));
    expect(codeOf(prompts.s1 ?? "")).toBe("(the current code of this scene is the file s1.tsx in <film>)");
    expect(codeOf(prompts.s2 ?? "")).toBe(rejected?.trim());

    // guard нової версії — з дозволеними текстами сцени (headline, sub, items, CTA)
    expect(guardCalls.map((c) => c.opts.fileName).sort()).toEqual(["s1.tsx", "s2.tsx"]);
    const s2Guard = guardCalls.find((c) => c.opts.fileName === "s2.tsx");
    expect(s2Guard?.opts.allowedTexts).toEqual([
      "Капучино — 75 грн",
      "-10% на каву з собою до 10:00",
      "Спешелті еспресо з молоком",
      "75 грн",
      "-10%",
      fixtureBrandKitFile.cta.text,
    ]);
  });
});
