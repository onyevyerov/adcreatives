import { type Llm, type MockReply, readCosts, readTuning, revPaths } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { CodegenReport, createCodegenStage } from "../src/stages/codegen.ts";
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

const ex = exampleSources();
const CODE: Record<string, string> = { s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] };

/** Стадія у режимі `fanout` (відкат через env) з `Tuning` з цього env (решта — дефолти: high / high). */
const stageWith = (env: Record<string, string> = {}) =>
  createCodegenStage({ tuning: () => readTuning({ ADC_CODEGEN_MODE: "fanout", ...env }) });
const fanoutStage = stageWith();
/** Решта сцен на нижчому effort, ніж anchor — щоб тести розрізняли виклики. */
const mediumRestStage = stageWith({ ADC_CODEGEN_REST_EFFORT: "medium" });

type Block = { type: string; text?: string; cache_control?: unknown };
type Params = {
  model: string;
  max_tokens: number;
  thinking?: unknown;
  output_config?: { effort?: string; task_budget?: { total: number } };
  system: Block[];
  messages: Array<{ content: Block[] }>;
};
const paramsOf = (p: unknown) => p as Params;
const sceneOf = (params: unknown) => /Generate the scenes: (\w+)\./.exec(userText(params))?.[1];

/** Відповіді за сценою з хвоста промпта — не залежать від порядку паралельних викликів. */
function byScene(map: Record<string, MockReply>, count = Object.keys(map).length): Reply[] {
  return Array.from({ length: count }, () => (params: unknown) => {
    const id = sceneOf(params);
    const reply = id ? map[id] : undefined;
    if (!reply) throw new Error(`немає відповіді для сцени ${id}`);
    return reply;
  });
}
const ok = (id: string): MockReply => ({ text: fileBlocks({ [id]: CODE[id] ?? "" }) });

/** Журнал початку й кінця викликів моделі (stream — за сценою, warm — окремо). */
function traceLlm(ctx: { llm: Llm }): string[] {
  const log: string[] = [];
  const { stream, warm } = ctx.llm;
  ctx.llm = {
    ...ctx.llm,
    stream: async (name, vars, opts) => {
      const id = (vars as { targets: string }).targets;
      log.push(`start:${id}`);
      try {
        return await stream(name, vars, opts);
      } finally {
        log.push(`end:${id}`);
      }
    },
    warm: async (name, vars, opts) => {
      log.push("warm");
      return warm(name, vars, opts);
    },
  };
  return log;
}

async function seeded() {
  const storage = tmpStorage();
  await seedProject(storage);
  return storage;
}

describe("codegenStage (fanout)", () => {
  it("перша генерація: anchor сам, потім один warm, решта паралельно з кодом лише anchor", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      ok("s1"),
      ...byScene({ s2: ok("s2"), s3: ok("s3") }),
    ]);
    const log = traceLlm(ctx);
    const res = await mediumRestStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: [] });

    // anchor завершився до будь-якого іншого виклику; warm — рівно один, до паралельних; s2 і s3
    // стартують, не чекаючи одна одну.
    expect(log.slice(0, 5)).toEqual(["start:s1", "end:s1", "warm", "start:s2", "start:s3"]);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.max_tokens === 0)).toHaveLength(1);
    const [anchor, warm, p2, p3] = calls as [Params, Params, Params, Params];
    expect(warm.max_tokens).toBe(0);
    expect(ctx.anthropic.calls[1]?.method).toBe("create");

    const anchorUser = userText(anchor);
    expect(anchorUser).toContain("Mode: anchor.");
    expect(anchorUser).not.toContain("<file name=");
    expect(anchor.output_config?.effort).toBe("high");
    expect(anchor.messages[0]?.content[0]?.cache_control).toBeUndefined();

    // Паралельні: однакові system і userCached (той самий, що прогрітий), різниться лише хвіст.
    for (const p of [p2, p3]) {
      expect(p.output_config?.effort).toBe("medium");
      expect(p.model).toBe(warm.model);
      expect(p.system).toEqual(warm.system);
      expect(p.messages[0]?.content[0]).toEqual(warm.messages[0]?.content[0]);
      expect(p.messages[0]?.content).toHaveLength(2);
    }
    expect(warm.output_config?.effort).toBe("medium");
    expect(warm.thinking).toEqual(p2.thinking);
    const cached = warm.messages[0]?.content[0];
    expect(cached?.cache_control).toEqual({ type: "ephemeral" });
    expect(cached?.text).toContain('<file name="s1.tsx">');
    expect(cached?.text).not.toContain('<file name="s2.tsx">');
    expect(cached?.text).not.toContain("Mode:");
    expect(cached?.text).not.toContain("Generate the scenes");
    const tails = [p2, p3].map((p) => p.messages[0]?.content[1]?.text);
    expect(tails).toEqual([
      "Mode: parallel.\nGenerate the scenes: s2.",
      "Mode: parallel.\nGenerate the scenes: s3.",
    ]);

    // Прогрес — у міру завершення, done/total.
    const progress = ctx.emitted.events.filter((e) => e.type === "progress" && e.stage === "codegen");
    expect(progress.map((e) => (e as { done: number }).done)).toEqual([0, 1, 2, 3]);
    expect(progress.every((e) => (e as { total: number }).total === 3)).toBe(true);

    const index = await storage.readText(revPaths(PROJECT_ID, 1).scenesIndex);
    expect(index).toContain("export default { s1: S1, s2: S2, s3: S3 };");
  });

  it("costDetail scene:<id> на кожну сцену, warm — окремим записом", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      ok("s1"),
      ...byScene({ s2: ok("s2"), s3: ok("s3") }),
    ]);
    await fanoutStage(ctx);
    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "codegen");
    expect(costs.map((e) => e.detail).sort()).toEqual(["scene:s1", "scene:s2", "scene:s3", "warm"]);
  });

  it("збій сцени (API, max_tokens) → сцена в missing, стадія ok", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      ok("s1"),
      ...byScene({
        s2: { error: new Error("boom") },
        s3: { text: fileBlocks({ s3: "обрізано" }), stopReason: "max_tokens" },
      }),
    ]);
    const res = await fanoutStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s2", "s3"] });
    const report = await storage.readJson(directorPaths(PROJECT_ID, 1).codegen, (v) =>
      CodegenReport.parse(v),
    );
    expect(report.missing).toEqual(["s2", "s3"]);
    expect(report.violations.s3?.[0]).toMatch(/max_tokens/);
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions[0]).toMatchObject({ missing: true, guardOk: false });
    expect(await storage.readText(revPaths(PROJECT_ID, 1).scenesIndex)).toContain(
      "export default { s1: S1 };",
    );
  });

  it("anchor не вдався → anchor стає наступна сцена; один паралельний виклик — без warm і без кешу", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { error: new Error("boom") },
      ok("s2"),
      ok("s3"),
    ]);
    const res = await fanoutStage(ctx);
    expect(res.outputs.guardRejected).toEqual(["s1"]);
    const calls = ctx.anthropic.calls.map((c) => paramsOf(c.params));
    expect(calls.map((c) => c.max_tokens === 0)).toEqual([false, false, false]);
    expect(userText(calls[1])).toContain("Mode: anchor.");
    expect(calls[1]?.output_config?.effort).toBe("high");
    const last = calls[2] as Params;
    expect(userText(last)).toContain("Mode: parallel.");
    expect(userText(last)).toContain('<file name="s2.tsx">');
    expect(last.messages[0]?.content[0]?.cache_control).toBeUndefined();
  });

  it("усі сцени без коду — помилка стадії", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { error: new Error("boom") },
      { error: new Error("boom") },
      { error: new Error("boom") },
    ]);
    await expect(fanoutStage(ctx)).rejects.toMatchObject({ code: "llm_api" });
  });

  it("правка (subset): усі цільові паралельно після warm, поруч поточний код нецільових", async () => {
    const storage = await seeded();
    await fanoutStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        ok("s1"),
        ...byScene({ s2: ok("s2"), s3: ok("s3") }),
      ]),
    );
    const ctx = makeCtx(
      storage,
      "codegen",
      {
        sceneIds: ["s1", "s3"],
        instructions: [
          { sceneId: "s1", instruction: "Фото крупніше" },
          { sceneId: "s3", instruction: "Зроби кнопку більшою" },
        ],
      },
      byScene({ s1: ok("s1"), s3: ok("s3") }),
    );
    const log = traceLlm(ctx);
    const res = await fanoutStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s3"], guardRejected: [] });
    expect(log.slice(0, 3)).toEqual(["warm", "start:s1", "start:s3"]);
    const [warm, p1, p3] = ctx.anthropic.calls.map((c) => paramsOf(c.params)) as [Params, Params, Params];
    expect(warm.max_tokens).toBe(0);
    const cached = warm.messages[0]?.content[0];
    expect(cached?.text).toContain('<file name="s2.tsx">');
    expect(cached?.text).not.toContain('<file name="s1.tsx">');
    expect(cached?.text).not.toContain('<file name="s3.tsx">');
    expect(cached?.text).toContain("s1: Фото крупніше");
    expect(cached?.text).toContain("s3: Зроби кнопку більшою");
    for (const p of [p1, p3]) {
      expect(p.messages[0]?.content[0]).toEqual(cached);
      expect(p.output_config?.effort).toBe("high");
    }
    expect(p1.messages[0]?.content[1]?.text).toBe("Mode: subset.\nGenerate the scenes: s1.");
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s1?.current).toBe(2);
    expect(ledger.scenes.s2?.current).toBe(1);
  });

  it("ліміт паралельності codegenConcurrency", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      ok("s1"),
      ...byScene({ s2: ok("s2"), s3: ok("s3") }),
    ]);
    const log = traceLlm(ctx);
    await stageWith({ ADC_CODEGEN_CONCURRENCY: "1" })(ctx);
    expect(log).toEqual(["start:s1", "end:s1", "warm", "start:s2", "end:s2", "start:s3", "end:s3"]);
  });

  it("модель, max_tokens і task budget з Tuning; anchor — модель з frontmatter", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      ok("s1"),
      ...byScene({ s2: ok("s2"), s3: ok("s3") }),
    ]);
    await stageWith({
      ADC_CODEGEN_ANCHOR_EFFORT: "xhigh",
      ADC_CODEGEN_REST_EFFORT: "low",
      ADC_CODEGEN_REST_MODEL: "claude-sonnet-5-5",
      ADC_CODEGEN_MAX_TOKENS: "64000",
      ADC_CODEGEN_TASK_BUDGET: "30000",
    })(ctx);
    const [anchor, warm, p2, p3] = ctx.anthropic.calls.map((c) => paramsOf(c.params)) as [
      Params,
      Params,
      Params,
      Params,
    ];
    expect(anchor).toMatchObject({ model: "claude-opus-5-5", max_tokens: 64000 });
    expect(anchor.output_config).toMatchObject({ effort: "xhigh", task_budget: { total: 30000 } });
    expect(warm).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 0,
      output_config: { effort: "low" },
    });
    for (const p of [p2, p3]) {
      expect(p).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 64000 });
      expect(p.output_config).toMatchObject({ effort: "low", task_budget: { total: 30000 } });
    }
  });
});
