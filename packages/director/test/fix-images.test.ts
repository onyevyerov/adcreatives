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
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { createFixStage } from "../src/stages/fix.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  mockEngine,
  PROJECT_ID,
  type Reply,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";

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
const sceneOf = (params: unknown) => /Виправ сцену (\w+) /.exec(userText(params))?.[1];

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
  await createCheckStage({ engine: mockEngine() })(makeCtx(storage, "check", { sceneIds: null }));
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

describe("fixStage: кадри для qa, прогрів, effort", () => {
  it("qa: стіли обраних форматів (що є в check.json) перед текстом, JPEG ≤ 1568, легенда; warm перед паралельними", async () => {
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
    expect(images(warm)).toHaveLength(0);

    const bySceneId = Object.fromEntries(rest.map((p) => [sceneOf(p), p]));
    const expected: Record<string, string[]> = { s1: ["vertical", "square"], s2: ["vertical"] };
    for (const [id, formats] of Object.entries(expected)) {
      const p = bySceneId[id] as Params;
      const content = p.messages[0]?.content ?? [];
      // зображення — перші блоки, далі лише текст
      expect(content.slice(0, formats.length).map((b) => b.type)).toEqual(formats.map(() => "image"));
      expect(content.slice(formats.length).every((b) => b.type === "text")).toBe(true);
      for (const img of images(p)) {
        expect(img.source?.media_type).toBe("image/jpeg");
        const meta = await sharp(Buffer.from(img.source?.data ?? "", "base64")).metadata();
        expect(meta.format).toBe("jpeg");
        expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1568);
      }
      // 9:16 і 1:1 — кадри в ряд (ширше, ніж вище)
      const first = await sharp(Buffer.from(images(p)[0]?.source?.data ?? "", "base64")).metadata();
      expect(first.width ?? 0).toBeGreaterThan(first.height ?? 0);

      const text = userText(p);
      for (const [i, f] of formats.entries()) {
        expect(text).toContain(`Image ${i + 1}: scene ${id}, format ${f}, frames 25/50/90%`);
      }
      expect(text).not.toContain(`Image ${formats.length + 1}:`);
      expect(text).toContain("The stills show the actual state; the QA remarks below say what to change.");
      expect(text).toContain(`заголовок ${id} обрізано`);
      expect(text.indexOf("Image 1:")).toBeLessThan(text.indexOf("Visual QA remarks"));
      // effort — frontmatter, ті самі model / system, що в прогріві; userCached без cache_control
      expect(p.output_config?.effort).toBe("high");
      expect(p.model).toBe(warm.model);
      expect(p.system).toEqual(warm.system);
      expect(content.find((b) => b.type === "text")?.cache_control).toBeUndefined();
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
    for (const p of rest) {
      expect(images(p)).toHaveLength(0);
      expect(p.output_config?.effort).toBe("medium");
      expect(p.system).toEqual(warm.system);
      expect(p.messages[0]?.content[0]).toEqual(cached);
      // зауваження QA для check не потрапляють у промпт, як і легенда кадрів
      expect(userText(p)).not.toContain("Image 1:");
      expect(userText(p)).not.toContain("обрізано");
    }
  });

  it("check без fixCheckEffort → effort із frontmatter; одна ціль → без прогріву", async () => {
    const storage = await checked();
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s2"], reason: "check" }, byScene(["s2"]));
    const log = traceLlm(ctx);
    await stageWith()(ctx);
    expect(log).toEqual(["text:s2"]);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.max_tokens).not.toBe(0);
    expect(calls[0]?.output_config?.effort).toBe("high");
    expect(calls[0]?.messages[0]?.content[0]?.cache_control).toBeUndefined();
  });

  it("qa з однією ціллю: кадри без прогріву", async () => {
    const storage = await checked();
    await writeQa(storage, ["s3"]);
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s3"], reason: "qa" }, byScene(["s3"]));
    const log = traceLlm(ctx);
    await stageWith()(ctx);
    expect(log).toEqual(["text:s3"]);
    const [call] = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(call && images(call)).toHaveLength(2);
    expect(userText(call)).toContain("Image 2: scene s3, format square, frames 25/50/90%");
  });
});
