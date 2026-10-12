import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCostRecorder, readCosts } from "../src/cost/ledger.ts";
import { loadPrices } from "../src/cost/prices.ts";
import { KEEP_HISTORY_IMAGES, pruneHistoryImages, toolInputSchema } from "../src/llm/agent.ts";
import { type AgentTool, createLlm, LlmError, REFUSAL_RETRY_NOTE } from "../src/llm/client.ts";
import { createMockAnthropic, type MockReply } from "../src/llm/mock.ts";
import { createPromptLoader } from "../src/llm/prompts.ts";
import { LocalStorage } from "../src/storage/local.ts";

function setup(replies: Array<MockReply | ((params: unknown) => MockReply)>) {
  const dir = mkdtempSync(path.join(tmpdir(), "adc-agent-"));
  writeFileSync(path.join(dir, "ref.md"), "---\nkind: prefix\ncache_ttl: 1h\n---\nДовідка {{lib}}.");
  writeFileSync(
    path.join(dir, "author.md"),
    "---\nmodel: claude-opus-5-5\neffort: high\nmax_tokens: 4000\nprefix: ref\ncache_ttl: 1h\n---\n" +
      "Пиши сцени.\n\n=== user ===\nБренд: {{brand}}",
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
  const client = createMockAnthropic(replies as Parameters<typeof createMockAnthropic>[0]);
  const llm = createLlm({ client, prompts: createPromptLoader({ dir }), cost, sleep: async () => {} });
  return { llm, client, storage };
}

const written: string[] = [];
const writeScene: AgentTool<{ sceneId: string; code: string }> = {
  name: "write_scene",
  description: "Записати код сцени",
  input: z.object({ sceneId: z.string(), code: z.string() }),
  async run({ sceneId, code }) {
    written.push(sceneId);
    return { text: code.includes("Math.random") ? `${sceneId}: guard: Math.random` : `${sceneId}: ok` };
  },
};
const renderStrip: AgentTool<{ sceneId: string }> = {
  name: "render_strip",
  description: "Стрип сцени",
  input: z.object({ sceneId: z.string() }),
  async run() {
    return { text: "стрип", images: [{ mediaType: "image/jpeg", data: new Uint8Array([1, 2, 3]) }] };
  },
};
const broken: AgentTool<{ x: number }> = {
  name: "broken",
  description: "Падає",
  input: z.object({ x: z.number() }),
  async run() {
    throw new Error("бум");
  },
};
const tools = [writeScene, renderStrip, broken] as AgentTool[];
const vars = { brand: "Зерно", lib: "motion-kit" };

type Params = Anthropic.MessageStreamParams;
const asParams = (p: unknown) => p as Params;

function toolResults(params: Params): Anthropic.ToolResultBlockParam[] {
  const last = params.messages.at(-1);
  if (!last || typeof last.content === "string") return [];
  return last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}

describe("Llm.agent: цикл з інструментами", () => {
  it("tool_use → tool_result з текстом і зображенням, помилки інструментів — is_error, end_turn → done", async () => {
    written.length = 0;
    const { llm, client, storage } = setup([
      {
        text: "Пишу s1",
        toolUses: [
          { id: "t1", name: "write_scene", input: { sceneId: "s1", code: "Math.random()" } },
          { id: "t2", name: "render_strip", input: { sceneId: "s1" } },
        ],
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
      {
        toolUses: [
          { id: "t3", name: "write_scene", input: { sceneId: 7 } },
          { id: "t4", name: "nope", input: {} },
          { id: "t5", name: "broken", input: { x: 1 } },
        ],
        usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 1000 },
      },
      { text: "Готово: дві сцени." },
    ]);
    const seen: string[] = [];
    const res = await llm.agent("author", vars, {
      tools,
      maxIterations: 10,
      tokenBudget: 1_000_000,
      costDetail: "author",
      onIteration: (i) => seen.push(`${i.iteration}:${i.tool}`),
    });

    expect(res).toMatchObject({ text: "Готово: дві сцени.", iterations: 2, stoppedBy: "done" });
    expect(res.costs).toHaveLength(3);
    expect(res.usd).toBeGreaterThan(0);
    expect(seen).toEqual(["1:write_scene", "2:write_scene"]);
    expect(written).toEqual(["s1"]);
    expect(client.calls.every((c) => c.method === "stream")).toBe(true);

    // 2-й запит: історія — user, assistant (text + 2 tool_use), user (2 tool_result + бюджет).
    const second = asParams(client.calls[1]?.params);
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const [r1, r2] = toolResults(second);
    expect(r1).toMatchObject({
      tool_use_id: "t1",
      content: [{ type: "text", text: "s1: guard: Math.random" }],
    });
    expect(r2?.content).toEqual([
      { type: "text", text: "стрип" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AQID" } },
    ]);
    const lastBlocks = second.messages.at(-1)?.content as Anthropic.ContentBlockParam[];
    expect(lastBlocks.at(-1)).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(JSON.stringify(lastBlocks.at(-1))).toContain("[budget] iteration 1/10");

    // 3-й запит: невалідний вхід, невідомий інструмент і виняток — is_error; ковзний breakpoint лише один.
    const third = asParams(client.calls[2]?.params);
    const errs = toolResults(third);
    expect(errs.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(JSON.stringify(errs[0]?.content)).toContain("invalid input");
    expect(JSON.stringify(errs[1]?.content)).toContain("unknown tool nope");
    expect(JSON.stringify(errs[2]?.content)).toContain("бум");
    const breakpoints = JSON.stringify(third.messages).match(/cache_control/g) ?? [];
    expect(breakpoints).toHaveLength(1);

    // Кеш: інструменти (TTL 1h, як prefix), prefix і system; схема входу з Zod.
    const defs = (third.tools ?? []) as Anthropic.Tool[];
    expect(defs.map((t) => t.name)).toEqual(["write_scene", "render_strip", "broken"]);
    expect(defs.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(defs[0]?.cache_control).toBeUndefined();
    expect(defs[0]?.input_schema).toMatchObject({
      type: "object",
      required: ["sceneId", "code"],
    });
    expect((third.system as Anthropic.TextBlockParam[]).map((b) => b.cache_control)).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);

    const costs = await readCosts(storage, "p1");
    expect(costs.map((c) => c.detail)).toEqual(["author:iter:1", "author:iter:2", "author:iter:3"]);
    expect(costs[1]?.units).toMatchObject({ input: 50, output: 100, cacheRead: 1000 });
  });

  it("зупинка за ітераціями і бюджетом токенів; інструменти останньої відповіді виконуються", async () => {
    written.length = 0;
    const turn = (id: string, tokens = 100): MockReply => ({
      toolUses: [{ id, name: "write_scene", input: { sceneId: id, code: "ok" } }],
      usage: { input_tokens: tokens, output_tokens: 0 },
    });
    const byIterations = setup([turn("s1"), turn("s2"), turn("s3")]);
    const a = await byIterations.llm.agent("author", vars, {
      tools,
      maxIterations: 2,
      tokenBudget: 1_000_000,
    });
    expect(a).toMatchObject({ iterations: 2, stoppedBy: "iterations" });
    expect(byIterations.client.remaining()).toBe(1);

    written.length = 0;
    const byBudget = setup([turn("s1", 400_000), turn("s2", 700_000), turn("s3")]);
    const b = await byBudget.llm.agent("author", vars, { tools, maxIterations: 10, tokenBudget: 1_000_000 });
    expect(b).toMatchObject({ iterations: 2, stoppedBy: "budget" });
    expect(written).toEqual(["s1", "s2"]);
  });

  it("сигнал: до виклику і під час інструмента → stoppedBy signal без винятку", async () => {
    const ac = new AbortController();
    ac.abort();
    const before = setup([{ text: "x" }]);
    const r1 = await before.llm.agent("author", vars, {
      tools,
      maxIterations: 5,
      tokenBudget: 1_000_000,
      signal: ac.signal,
    });
    expect(r1).toMatchObject({ iterations: 0, stoppedBy: "signal", text: "" });
    expect(before.client.calls).toHaveLength(0);

    const ac2 = new AbortController();
    const slow: AgentTool<Record<string, never>> = {
      name: "slow",
      description: "Довгий",
      input: z.object({}),
      async run(_input, signal) {
        ac2.abort();
        if (signal?.aborted) throw new Error("aborted");
        return { text: "ok" };
      },
    };
    const during = setup([{ toolUses: [{ name: "slow", input: {} }] }, { text: "не дійде" }]);
    const r2 = await during.llm.agent("author", vars, {
      tools: [slow as AgentTool],
      maxIterations: 5,
      tokenBudget: 1_000_000,
      signal: ac2.signal,
    });
    expect(r2).toMatchObject({ iterations: 1, stoppedBy: "signal" });
    expect(during.client.remaining()).toBe(1);
  });

  it("транспортна помилка — повтор; відмова — один повтор з поясненням, друга — LlmError refusal", async () => {
    const overloaded = Object.assign(new Error("overloaded"), { status: 529 });
    const { InternalServerError } = await import("@anthropic-ai/sdk");
    const retry = setup([
      { error: new InternalServerError(500, undefined, "boom", new Headers()) },
      { text: "Готово" },
    ]);
    const r = await retry.llm.agent("author", vars, { tools, maxIterations: 3, tokenBudget: 1_000_000 });
    expect(r).toMatchObject({ stoppedBy: "done", text: "Готово" });
    expect(retry.client.calls).toHaveLength(2);

    const fatal = setup([{ error: overloaded }]);
    const err = await fatal.llm
      .agent("author", vars, { tools, maxIterations: 3, tokenBudget: 1_000_000 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "api" });

    const refusal = setup([{ stopReason: "refusal" }, { text: "Добре" }]);
    const ok = await refusal.llm.agent("author", vars, { tools, maxIterations: 3, tokenBudget: 1_000_000 });
    expect(ok.text).toBe("Добре");
    const retried = asParams(refusal.client.calls[1]?.params);
    expect(retried.messages).toHaveLength(1);
    expect(JSON.stringify(retried.messages[0])).toContain(REFUSAL_RETRY_NOTE.slice(0, 40));

    const twice = setup([{ stopReason: "refusal" }, { stopReason: "refusal" }]);
    const refused = await twice.llm
      .agent("author", vars, { tools, maxIterations: 3, tokenBudget: 1_000_000 })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LlmError);
    expect(refused).toMatchObject({ code: "refusal" });
  });

  it("max_tokens: обрізаний tool_use не виконується, модель отримує підказку і продовжує", async () => {
    written.length = 0;
    const { llm, client } = setup([
      {
        text: "Пишу",
        toolUses: [{ name: "write_scene", input: { sceneId: "s1" } }],
        stopReason: "max_tokens",
      },
      { text: "Готово" },
    ]);
    const res = await llm.agent("author", vars, { tools, maxIterations: 5, tokenBudget: 1_000_000 });
    expect(res).toMatchObject({ stoppedBy: "done", iterations: 1 });
    expect(written).toEqual([]);
    const second = asParams(client.calls[1]?.params);
    expect(JSON.stringify(second.messages.at(-2))).not.toContain("tool_use");
    expect(JSON.stringify(second.messages.at(-1))).toContain("output token limit");
  });

  it("старі зображення історії замінюються підписом", () => {
    const img = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/jpeg" as const, data: "x" },
    };
    const messages: Anthropic.MessageParam[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "tool_result" as const, tool_use_id: `t${i}`, content: [img, img] }],
    }));
    expect(pruneHistoryImages(messages, KEEP_HISTORY_IMAGES)).toBe(60 - KEEP_HISTORY_IMAGES);
    const first = messages[0]?.content as Anthropic.ToolResultBlockParam[];
    expect(JSON.stringify(first[0]?.content)).toContain("older image omitted");
    const last = messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    const kept = (last[0]?.content ?? []) as Array<{ type: string }>;
    expect(kept.map((c) => c.type)).toEqual(["image", "image"]);
  });

  it("схема входу інструмента — об'єкт", () => {
    expect(toolInputSchema(z.object({ a: z.string().optional() }))).toMatchObject({ type: "object" });
    expect(() => toolInputSchema(z.string())).toThrow(LlmError);
  });
});
