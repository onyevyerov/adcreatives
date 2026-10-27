import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCostRecorder, readCosts } from "../src/cost/ledger.ts";
import { loadPrices } from "../src/cost/prices.ts";
import {
  createLlm,
  LlmError,
  REFUSAL_RETRY_NOTE,
  TASK_BUDGET_BETA,
  usageToUnits,
} from "../src/llm/client.ts";
import { createMockAnthropic, type MockOptions, type MockReply } from "../src/llm/mock.ts";
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
  writeFileSync(path.join(dir, "ref.md"), "---\nkind: prefix\ncache_ttl: 1h\n---\nДовідка {{lib}}.");
  writeFileSync(
    path.join(dir, "scene.md"),
    "---\nmodel: claude-opus-5-5\neffort: high\nmax_tokens: 4000\nprefix: ref\ncache_ttl: 1h\n---\nПравила.\n\n" +
      "=== user ===\nСпільне: {{shared}}\n=== cache ===\nСцена: {{scene}}",
  );
  writeFileSync(
    path.join(dir, "pick-prompt.md"),
    "---\nmodel: claude-opus-5-5\neffort: low\nmax_tokens: 4000\nschema_mode: prompt\n---\nОбери колір.\n\n=== user ===\nБренд: {{brand}}",
  );
  return dir;
}

const Pick = z.object({
  color: z.enum(["red", "green"]),
  score: z.number().int().min(1).max(5),
});

function setup(replies: MockReply[], mockOptions?: MockOptions) {
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-llm-data-")));
  const client = createMockAnthropic(replies, mockOptions);
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

  describe("Крок 0: prefix, кеш user-частини, warm, task budget", () => {
    const vars = { lib: "motion-kit", shared: "бренд і розкадровка", scene: "s2" };

    it("system = [prefix (1h), stage (1h)]; user = [userCached (5m), хвіст]; costDetail у витратах", async () => {
      const { llm, client, storage } = setup([{ text: "код" }]);
      await llm.stream("scene", vars, { costDetail: "scene:s2" });
      const params = client.calls[0]?.params as Anthropic.MessageStreamParams;
      expect(params.system).toEqual([
        { type: "text", text: "Довідка motion-kit.", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "Правила.", cache_control: { type: "ephemeral", ttl: "1h" } },
      ]);
      expect(params.messages[0]?.content).toEqual([
        { type: "text", text: "Спільне: бренд і розкадровка", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Сцена: s2" },
      ]);
      expect(client.calls[0]?.options?.headers).toBeUndefined();
      const [event] = await readCosts(storage, "p1");
      expect(event?.detail).toBe("scene:s2");
    });

    it("cacheUserPrefix: false — userCached без cache_control", async () => {
      const { llm, client } = setup([{ text: "код" }]);
      await llm.stream("scene", vars, { cacheUserPrefix: false });
      const params = client.calls[0]?.params as Anthropic.MessageStreamParams | undefined;
      const content = params?.messages[0]?.content;
      expect(content).toEqual([
        { type: "text", text: "Спільне: бренд і розкадровка" },
        { type: "text", text: "Сцена: s2" },
      ]);
    });

    it("imagesAfterCache: [userCached, ...зображення, хвіст]; без нього — зображення першими; перший блок = прогрів", async () => {
      const images = [
        { mediaType: "image/png" as const, data: "AAA" },
        { mediaType: "image/jpeg" as const, data: "BBB" },
      ];
      const imageBlocks = [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
      ];
      const cached = {
        type: "text",
        text: "Спільне: бренд і розкадровка",
        cache_control: { type: "ephemeral" },
      };
      const tail = { type: "text", text: "Сцена: s2" };
      const { llm, client } = setup([{ text: "код" }, { text: "код" }, { text: "код" }]);

      await llm.warm("scene", vars);
      await llm.stream("scene", vars, { images, imagesAfterCache: true });
      await llm.stream("scene", vars, { images });
      await llm.stream("pick", { brand: "Зерно" }, { images, imagesAfterCache: true });

      const [w, after, before, noCached] = client.calls.map(
        (c) => (c.params as Anthropic.MessageStreamParams).messages[0]?.content as unknown[],
      );
      expect(after).toEqual([cached, ...imageBlocks, tail]);
      expect(before).toEqual([...imageBlocks, cached, tail]);
      // Без userCached перемикач ігнорується.
      expect(noCached).toEqual([...imageBlocks, { type: "text", text: "Бренд: Зерно" }]);
      expect(w).toEqual([cached]);
      expect(after?.[0]).toEqual(w?.[0]);
    });

    it("taskBudget → output_config.task_budget і beta-заголовок; менше 20 000 — помилка", async () => {
      const { llm, client } = setup([{ text: "код" }]);
      await llm.stream("scene", vars, { taskBudget: 25_000, effort: "medium" });
      const params = client.calls[0]?.params as unknown as { output_config: unknown };
      expect(params.output_config).toEqual({
        effort: "medium",
        task_budget: { type: "tokens", total: 25_000 },
      });
      expect(client.calls[0]?.options?.headers).toEqual({ "anthropic-beta": TASK_BUDGET_BETA });
      await expect(llm.stream("scene", vars, { taskBudget: 5_000 })).rejects.toMatchObject({
        code: "prompt",
      });
    });

    it("warm: max_tokens 0 без стріму й формату, ті самі system/userCached/effort, черги не споживає", async () => {
      const { llm, client, storage } = setup([{ text: "код" }], {
        warmUsage: {
          input_tokens: 10,
          cache_creation_input_tokens: 3_000,
          cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
        },
      });
      const warmed = await llm.warm("scene", vars, { effort: "medium", costDetail: "warm:codegen" });
      expect(client.remaining()).toBe(1);
      await llm.stream("scene", vars, { effort: "medium" });
      expect(client.remaining()).toBe(0);

      const [w, real] = client.calls;
      expect(w?.method).toBe("create");
      const wp = w?.params as Anthropic.MessageCreateParamsNonStreaming;
      const rp = real?.params as Anthropic.MessageStreamParams;
      expect(wp.max_tokens).toBe(0);
      expect(wp.output_config).toEqual({ effort: "medium" });
      expect(wp.thinking).toEqual(rp.thinking);
      expect(wp.model).toBe(rp.model);
      expect(wp.system).toEqual(rp.system);
      const realContent = rp.messages[0]?.content as unknown[] | undefined;
      expect(wp.messages[0]?.content).toEqual([realContent?.[0]]);

      // Opus 5.5: 10 × $4 + 1 000 × $5 + 2 000 × $8 за 1 млн.
      expect(warmed).toEqual({ usd: 0.02104, cacheWrite: 1_000, cacheWrite1h: 2_000, cacheRead: 0 });
      const costs = await readCosts(storage, "p1");
      expect(costs[0]).toMatchObject({ detail: "warm:codegen", effort: "medium", promptName: "scene" });
      expect(costs[0]?.units).toMatchObject({ cacheWrite: 1_000, cacheWrite1h: 2_000 });
    });

    it("warm без userCached: system прогрівається, у user — хвіст промпта", async () => {
      const { llm, client, storage } = setup([]);
      const res = await llm.warm("pick", { brand: "Зерно" });
      expect(res.cacheWrite1h).toBe(0);
      const wp = client.calls[0]?.params as Anthropic.MessageCreateParamsNonStreaming;
      expect(wp.messages[0]?.content).toEqual([{ type: "text", text: "Бренд: Зерно" }]);
      expect((await readCosts(storage, "p1"))[0]?.detail).toBe("warm");
    });

    it("schema_mode: prompt — одразу схема в промпті, без output_config.format", async () => {
      const { llm, client } = setup([{ text: '{"color":"green","score":2}', usage }]);
      const res = await llm.structured("pick-prompt", { brand: "Зерно" }, Pick);
      expect(res.data).toEqual({ color: "green", score: 2 });
      expect(client.calls).toHaveLength(1);
      const params = client.calls[0]?.params as Anthropic.MessageCreateParamsNonStreaming;
      expect(params.output_config?.format).toBeUndefined();
      expect(JSON.stringify(params.messages)).toContain("JSON Schema");
    });

    it("usageToUnits: запис кешу за TTL; без розбивки — увесь запис як 5 хв", () => {
      const base = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 };
      expect(
        usageToUnits({
          ...base,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        } as Anthropic.Usage),
      ).toEqual({ input: 1, output: 2, cacheWrite: 10, cacheWrite1h: 20, cacheRead: 3 });
      expect(usageToUnits({ ...base, cache_creation_input_tokens: 30 } as Anthropic.Usage)).toEqual({
        input: 1,
        output: 2,
        cacheWrite: 30,
        cacheWrite1h: 0,
        cacheRead: 3,
      });
    });

    it("промпт kind: prefix напряму не викликається", async () => {
      const { llm, client } = setup([{ text: "x" }]);
      await expect(llm.text("ref", vars)).rejects.toThrow(/kind: prefix/);
      expect(client.calls).toHaveLength(0);
    });
  });
});
