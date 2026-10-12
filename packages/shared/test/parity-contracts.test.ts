import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCostRecorder } from "../src/cost/ledger.ts";
import { loadPrices } from "../src/cost/prices.ts";
import { fixtureBrandKitFile, fixtureStoryboard } from "../src/fixtures.ts";
import { type AgentTool, createLlm, LlmError } from "../src/llm/client.ts";
import { createMockAgent, createMockAnthropic } from "../src/llm/mock.ts";
import { createPromptLoader } from "../src/llm/prompts.ts";
import { STAGE_QUEUE } from "../src/queue.ts";
import {
  BrandKit,
  BrandKitFile,
  MusicMeta,
  type MusicTrackCheck,
  OnScreenText,
} from "../src/schemas/index.ts";
import { LocalStorage } from "../src/storage/local.ts";

/** Бренд-кіт у форматі до ТЗ паритету: без семантичних кольорів, моношрифту і речовини продукту. */
function legacyBrandKitFile(): Record<string, unknown> {
  const { substance: _s, ...rest } = structuredClone(fixtureBrandKitFile);
  const { danger: _d, warning: _w, success: _ok, ...palette } = rest.palette;
  const { mono: _m, ...typography } = rest.typography;
  return { ...rest, palette, typography };
}

describe("ТЗ паритету, Крок 0: схеми адитивні", () => {
  it("старий brandkit/v*.json парситься з дефолтами нових полів", () => {
    const kit = BrandKitFile.parse(legacyBrandKitFile());
    expect(kit.palette).toMatchObject({ danger: null, warning: null, success: null });
    expect(kit.typography.mono).toBeNull();
    expect(kit.substance).toEqual({
      steps: [],
      checks: [],
      exampleIssues: [],
      planRows: [],
      products: [],
      comparisons: [],
    });
  });

  it("дефолтна речовина не ділиться між парсами", () => {
    const a = BrandKit.parse(legacyBrandKitFile());
    const b = BrandKit.parse(legacyBrandKitFile());
    a.substance.checks.push("SEO");
    expect(b.substance.checks).toEqual([]);
  });

  it("речовина продукту, семантичні кольори і моношрифт зберігаються", () => {
    const kit = BrandKit.parse({
      ...fixtureBrandKitFile,
      palette: { ...fixtureBrandKitFile.palette, danger: "#E5484D", warning: "#F5A524", success: "#30A46C" },
      typography: {
        ...fixtureBrandKitFile.typography,
        mono: { family: "JetBrains Mono", weights: [400, 700], origin: "substitute" },
      },
      substance: {
        steps: [{ name: "Вставте URL", detail: null }],
        checks: ["SEO", "Швидкість"],
        exampleIssues: [
          {
            title: "Немає meta description",
            severity: "critical",
            score: "42/100",
            explanation: null,
            fix: "Додайте опис",
            effort: "15 хв",
          },
        ],
        planRows: [{ text: "Стиснути зображення", group: "1 тиждень", effort: "3 години" }],
        products: [{ name: "Аудит", oneLiner: null }],
        comparisons: [{ criterion: "Ціна", us: "$9", alternative: "$500" }],
      },
    });
    expect(kit.palette.danger).toBe("#E5484D");
    expect(kit.typography.mono?.family).toBe("JetBrains Mono");
    expect(kit.substance.exampleIssues[0]?.severity).toBe("critical");
    expect(() =>
      BrandKit.parse({ ...fixtureBrandKitFile, palette: { ...fixtureBrandKitFile.palette, danger: "red" } }),
    ).toThrow();
  });

  it("ролі eyebrow і status у кадрі", () => {
    for (const role of ["eyebrow", "status"] as const) {
      expect(OnScreenText.parse({ id: "t1", role, text: "КРОК 2" }).role).toBe(role);
    }
    const old = fixtureStoryboard.scenes[0]?.items ?? [];
    expect(z.array(OnScreenText).parse(old)).toEqual(old);
  });

  it("старий music.json парситься: check = null, attempts = 1; новий — з перевіркою треку", () => {
    const legacy = {
      planHash: "p",
      durationMs: 24000,
      modelId: "music_v1",
      method: "compose",
      promptUsed: null,
      briefHash: "b",
      createdAt: "2026-10-12T10:00:00.000Z",
    };
    expect(MusicMeta.parse(legacy)).toMatchObject({ check: null, attempts: 1 });
    const check: MusicTrackCheck = {
      bpm: 120,
      kickOnsets: 48,
      beatConfidence: 0.9,
      gaps: [{ fromMs: 12000, toMs: 13500, dropDb: 9.5 }],
      rmsPerSecondDb: [-14, -13.5],
      ok: false,
    };
    expect(MusicMeta.parse({ ...legacy, check, attempts: 3 })).toMatchObject({ check, attempts: 3 });
    expect(() => MusicMeta.parse({ ...legacy, attempts: 0 })).toThrow();
  });

  it("стадія author іде в чергу режисера", () => {
    expect(STAGE_QUEUE.author).toBe(STAGE_QUEUE.codegen);
  });
});

function testLlm() {
  const dir = mkdtempSync(path.join(tmpdir(), "adc-agent-"));
  writeFileSync(
    path.join(dir, "author.md"),
    "---\nmodel: claude-opus-5-5\neffort: high\nmax_tokens: 4000\n---\nПиши сцени.\n\n=== user ===\nБренд: {{brand}}",
  );
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-agent-data-")));
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: "p1",
    rev: 1,
    stage: "author",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const prompts = createPromptLoader({ dir });
  return { llm: createLlm({ client: createMockAnthropic([]), prompts, cost }), prompts };
}

const writeScene: AgentTool<{ sceneId: string; code: string }> = {
  name: "write_scene",
  description: "Записати код сцени",
  input: z.object({ sceneId: z.string(), code: z.string() }),
  async run({ sceneId, code }) {
    return { text: code.includes("Math.random") ? `${sceneId}: guard: Math.random` : `${sceneId}: ok` };
  },
};

const renderStrip: AgentTool<{ sceneId: string }> = {
  name: "render_strip",
  description: "Стрип сцени",
  input: z.object({ sceneId: z.string() }),
  async run() {
    return { text: "стрип", images: [{ mediaType: "image/png", data: new Uint8Array([1]) }] };
  },
};

const tools = [writeScene, renderStrip] as AgentTool[];

describe("ТЗ паритету, Крок 0: Llm.agent", () => {
  it("справжній agent() — цикл з інструментами (C1; детально — llm-agent.test.ts)", async () => {
    const { llm } = testLlm();
    // Черга мок-клієнта порожня: перший же виклик API падає — і це помилка API, а не заглушка.
    const err = await llm
      .agent("author", { brand: "Зерно" }, { tools, maxIterations: 5, tokenBudget: 1_000_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe("api");
  });

  it("мок: виконує сценарій інструментами, бачить попередні результати, finish → done", async () => {
    const { llm, prompts } = testLlm();
    const mock = createMockAgent(
      [
        { tool: "write_scene", input: { sceneId: "s1", code: "Math.random()" } },
        (calls) => ({
          tool: "write_scene",
          input: { sceneId: "s1", code: calls.at(-1)?.text?.includes("guard") ? "fixed" : "same" },
        }),
        { tool: "write_scene", input: { sceneId: "s2", code: "ok" } },
        { tool: "render_strip", input: { sceneId: "s2" }, usd: 0.5 },
        { tool: "render_strip", input: { sceneId: 7 } },
        { finish: "готово" },
      ],
      { prompts },
    );
    const agent = { ...llm, agent: mock.agent };
    const seen: string[] = [];
    const res = await agent.agent(
      "author",
      { brand: "Зерно" },
      {
        tools,
        maxIterations: 10,
        tokenBudget: 1_000_000,
        onIteration: (i) => seen.push(`${i.iteration}:${i.tool}`),
      },
    );
    expect(res).toMatchObject({ text: "готово", iterations: 5, stoppedBy: "done", usd: 0.5 });
    expect(res.prompt.user).toContain("Зерно");
    expect(mock.calls.map((c) => c.text)).toEqual([
      "s1: guard: Math.random",
      "s1: ok",
      "s2: ok",
      "стрип",
      expect.stringContaining("невалідний вхід"),
    ]);
    expect(mock.calls[3]?.images).toHaveLength(1);
    expect(mock.calls[4]?.isError).toBe(true);
    expect(seen).toEqual([
      "1:write_scene",
      "2:write_scene",
      "3:write_scene",
      "4:render_strip",
      "5:render_strip",
    ]);
    expect(mock.runs[0]?.vars).toEqual({ brand: "Зерно" });
  });

  it("мок: зупинка за ітераціями, бюджетом токенів і сигналом", async () => {
    const step = { tool: "render_strip", input: { sceneId: "s1" } };
    const opts = { tools, maxIterations: 2, tokenBudget: 1_000_000 };
    const byIterations = await createMockAgent([step, step, step, { finish: "x" }]).agent("author", {}, opts);
    expect(byIterations).toMatchObject({ iterations: 2, stoppedBy: "iterations" });

    const byBudget = await createMockAgent([
      { ...step, tokens: 600_000 },
      { ...step, tokens: 600_000 },
      step,
    ]).agent("author", {}, { ...opts, maxIterations: 10 });
    expect(byBudget).toMatchObject({ iterations: 2, stoppedBy: "budget" });

    const ac = new AbortController();
    ac.abort();
    const bySignal = await createMockAgent([step]).agent("author", {}, { ...opts, signal: ac.signal });
    expect(bySignal).toMatchObject({ iterations: 0, stoppedBy: "signal" });
  });

  it("мок Anthropic віддає tool_use блоки (для тестів agent.ts)", async () => {
    const client = createMockAnthropic([
      { text: "Пишу s1", toolUses: [{ name: "write_scene", input: { sceneId: "s1", code: "x" } }] },
      { text: "Готово" },
    ]);
    const params = { model: "m", max_tokens: 10, messages: [{ role: "user" as const, content: "go" }] };
    const first = await client.messages.stream(params).finalMessage();
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(first.content[1]).toMatchObject({ name: "write_scene", input: { sceneId: "s1", code: "x" } });
    const second = await client.messages.create(params);
    expect(second.stop_reason).toBe("end_turn");
  });
});
