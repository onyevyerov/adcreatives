import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCostRecorder, readCosts } from "../src/cost/ledger.ts";
import { loadPrices } from "../src/cost/prices.ts";
import { createLlm, LlmError, REFUSAL_RETRY_NOTE } from "../src/llm/client.ts";
import { createMockAnthropic, type MockReply } from "../src/llm/mock.ts";
import { createPromptLoader } from "../src/llm/prompts.ts";
import { LocalStorage } from "../src/storage/local.ts";
import { createNoopTracer } from "../src/trace.ts";

function promptsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "adc-llm-"));
  const write = (name: string, effort: string, body: string) =>
    writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nmodel: claude-opus-5-5\neffort: ${effort}\nmax_tokens: 4000\n---\n${body}`,
    );
  write("pick", "low", "Обери колір.\n\n=== user ===\nБренд: {{brand}}");
  write("deep", "xhigh", "Подумай глибоко.\n\n=== user ===\nЗавдання: {{task}}");
  write("empty", "low", "");
  return dir;
}

const Pick = z.object({
  color: z.enum(["red", "green"]),
  score: z.number().int().min(1).max(5),
});

function setup(replies: MockReply[]) {
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-llm-data-")));
  const client = createMockAnthropic(replies);
  const trace = createNoopTracer();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: "p1",
    rev: 1,
    stage: "brandkit",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const llm = createLlm({
    client,
    prompts: createPromptLoader({ dir: promptsDir() }),
    cost,
    trace,
    sleep: async () => {},
  });
  return { llm, client, storage, trace };
}

const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };

describe("llm wrapper", () => {
  it("structured: sends adaptive thinking, effort, strict schema with enum, cached system; records cost", async () => {
    const { llm, client, storage, trace } = setup([{ json: { color: "red", score: 3 }, usage }]);
    const res = await llm.structured("pick", { brand: "Зерно" }, Pick, {
      images: [{ mediaType: "image/png", data: Buffer.from("png") }],
    });
    expect(res.data).toEqual({ color: "red", score: 3 });

    const call = client.calls[0];
    expect(call?.method).toBe("create");
    const params = call?.params as Anthropic.MessageCreateParamsNonStreaming;
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config?.effort).toBe("low");
    const schema = params.output_config?.format?.schema as { properties: { color: { enum: string[] } } };
    expect(schema.properties.color.enum).toEqual(["red", "green"]);
    expect(params.system).toEqual([
      { type: "text", text: "Обери колір.", cache_control: { type: "ephemeral" } },
    ]);
    const content = params.messages[0]?.content as Anthropic.ContentBlockParam[];
    expect(content[0]?.type).toBe("image");
    expect(content[1]).toEqual({ type: "text", text: "Бренд: Зерно" });

    // Opus 5.5: $4 / 1M вхід + $20 / 1M вихід → 4 + 2 = 6
    expect(res.usd).toBe(6);
    const costs = await readCosts(storage, "p1");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptName: "pick",
      effort: "low",
      attempt: 1,
      exact: true,
      usd: 6,
      source: "test",
    });
    expect(costs[0]?.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.prompts()).toEqual([{ name: "pick", hash: costs[0]?.promptHash }]);
  });

  it("high effort goes through streaming", async () => {
    const { llm, client } = setup([{ text: "готово" }]);
    const deltas: string[] = [];
    const res = await llm.text("deep", { task: "x" }, { onText: (d) => deltas.push(d) });
    expect(client.calls[0]?.method).toBe("stream");
    expect(res.text).toBe("готово");
    expect(deltas.join("")).toBe("готово");
  });

  it("constraint violation → one retry with the error text, both attempts recorded", async () => {
    const { llm, client, storage } = setup([
      { json: { color: "red", score: 9 } },
      { json: { color: "green", score: 5 } },
    ]);
    const res = await llm.structured("pick", { brand: "x" }, Pick);
    expect(res.data.score).toBe(5);
    const second = client.calls[1]?.params.messages[0]?.content as Anthropic.TextBlockParam[];
    expect(second.at(-1)?.text).toContain("не пройшла перевірку");
    const costs = await readCosts(storage, "p1");
    expect(costs.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it("second validation failure is a stage error", async () => {
    const { llm } = setup([{ text: "not json" }, { json: { color: "blue", score: 1 } }]);
    await expect(llm.structured("pick", { brand: "x" }, Pick)).rejects.toMatchObject({ code: "validation" });
  });

  it("refusal → one softened retry, then error", async () => {
    const ok = setup([{ stopReason: "refusal" }, { json: { color: "red", score: 1 } }]);
    await ok.llm.structured("pick", { brand: "x" }, Pick);
    const retried = ok.client.calls[1]?.params.messages[0]?.content as Anthropic.TextBlockParam[];
    expect(retried.at(-1)?.text).toContain(REFUSAL_RETRY_NOTE);

    const bad = setup([{ stopReason: "refusal" }, { stopReason: "refusal" }]);
    await expect(bad.llm.structured("pick", { brand: "x" }, Pick)).rejects.toMatchObject({ code: "refusal" });
    expect((await readCosts(bad.storage, "p1")).length).toBe(2);
  });

  it("retries rate limits and 5xx with backoff, gives up after 3 retries", async () => {
    const rate = () => new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
    const server = () => new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers());
    const ok = setup([{ error: rate() }, { error: server() }, { json: { color: "red", score: 2 } }]);
    expect((await ok.llm.structured("pick", { brand: "x" }, Pick)).data.score).toBe(2);

    const bad = setup([{ error: rate() }, { error: rate() }, { error: rate() }, { error: rate() }]);
    await expect(bad.llm.structured("pick", { brand: "x" }, Pick)).rejects.toMatchObject({ code: "api" });
    expect(bad.client.remaining()).toBe(0);
  });

  it("does not retry 400", async () => {
    const { llm, client } = setup([
      { error: new Anthropic.BadRequestError(400, undefined, "bad", new Headers()) },
      { json: { color: "red", score: 1 } },
    ]);
    await expect(llm.structured("pick", { brand: "x" }, Pick)).rejects.toBeInstanceOf(LlmError);
    expect(client.remaining()).toBe(1);
  });

  it("схема, завелика для граматики API: повтор без output_config.format, схема — у промпті", async () => {
    const Big = z.object({ color: z.enum(["red", "green"]), note: z.string() });
    const tooLarge = () =>
      new Anthropic.BadRequestError(
        400,
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
          },
        },
        "400 The compiled grammar is too large, which would cause performance issues.",
        new Headers(),
      );
    const { llm, client, storage } = setup([
      { error: tooLarge() },
      { text: 'Ось відповідь:\n```json\n{"color":"green","note":"ok"}\n```', usage },
      { text: '{"color":"red","note":"знову"}', usage },
    ]);
    const res = await llm.structured("pick", { brand: "Зерно" }, Big);
    expect(res.data).toEqual({ color: "green", note: "ok" });
    const [first, second] = client.calls.map((c) => c.params as Anthropic.MessageCreateParamsNonStreaming);
    expect(first?.output_config?.format).toBeDefined();
    expect(second?.output_config?.format).toBeUndefined();
    const userText = JSON.stringify(second?.messages);
    expect(userText).toContain("JSON Schema");
    expect(userText).toContain('\\"note\\"'); // поле схеми є в тексті промпта
    // Та сама схема далі йде одразу без граматики — без зайвого 400.
    const again = await llm.structured("pick", { brand: "Зерно" }, Big);
    expect(again.data).toEqual({ color: "red", note: "знову" });
    expect(client.calls).toHaveLength(3);
    const third = client.calls[2]?.params as Anthropic.MessageCreateParamsNonStreaming | undefined;
    expect(third?.output_config?.format).toBeUndefined();
    // 400 не тарифікується: витрати лише за дві успішні відповіді.
    expect(await readCosts(storage, "p1")).toHaveLength(2);
  });

  it("broken stream records partial usage as inexact", async () => {
    const { llm, storage } = setup([
      {
        error: new Anthropic.APIConnectionError({ message: "reset" }),
        partialUsage: { input_tokens: 500, output_tokens: 40 },
      },
      { text: "ok" },
    ]);
    await llm.stream("deep", { task: "x" });
    const costs = await readCosts(storage, "p1");
    expect(costs.map((c) => c.exact)).toEqual([false, true]);
  });

  it("max_tokens and empty prompt are errors", async () => {
    const { llm } = setup([{ stopReason: "max_tokens", text: "{" }]);
    await expect(llm.structured("pick", { brand: "x" }, Pick)).rejects.toMatchObject({ code: "max_tokens" });
    await expect(llm.text("empty", {}, { userText: "x" })).rejects.toMatchObject({ code: "prompt" });
  });
});
