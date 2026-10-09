import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CostContext } from "../src/cost/ledger.ts";
import { createCostRecorder, readCosts, recordCost, sumUsd } from "../src/cost/ledger.ts";
import {
  loadPrices,
  priceAnthropic,
  priceElevenLabs,
  priceRemotion,
  UnknownPriceError,
} from "../src/cost/prices.ts";
import { aggregateCosts, distribution, statsToCsv } from "../src/cost/stats.ts";
import { fixtureProject, fixtureStoryboard } from "../src/fixtures.ts";
import { LocalStorage, projectPaths } from "../src/storage/index.ts";
import { createTracer } from "../src/trace.ts";

const prices = loadPrices();
const tmpStorage = () => new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-cost-")));
const ctx = (over: Partial<CostContext> = {}): CostContext => ({
  projectId: "p1",
  rev: 1,
  stage: "brandkit",
  phase: "first_delivery",
  source: "chat",
  attempt: 1,
  ...over,
});

describe("prices", () => {
  it("anthropic, elevenlabs, remotion", () => {
    const sonnet = priceAnthropic(prices, "claude-sonnet-5-5", {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
    });
    expect(sonnet.usd).toBeCloseTo(2 + 10 + 2.5 + 0.2);
    expect(sonnet.unitPrices.cacheWrite1h).toBe(4);
    // Запис кешу на 1 год — 2 × input: Opus 5.5 = 8, Sonnet 5.5 = 4.
    const units1h = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 1_000_000, cacheRead: 0 };
    expect(priceAnthropic(prices, "claude-opus-5-5", units1h).usd).toBeCloseTo(8);
    expect(priceAnthropic(prices, "claude-sonnet-5-5", units1h).usd).toBeCloseTo(4);
    expect(priceElevenLabs(prices, "music", 30).usd).toBeCloseTo(0.075);
    expect(priceElevenLabs(prices, "sfx", 60).usd).toBeCloseTo(0.12);
    expect(priceRemotion(prices, 3).usd).toBeCloseTo(0.03);
    expect(() =>
      priceAnthropic(prices, "nope", { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }),
    ).toThrow(UnknownPriceError);
  });
});

describe("ledger", () => {
  it("recordCost appends validated lines; shared costs go to costs-shared.jsonl", async () => {
    const s = tmpStorage();
    const rec = createCostRecorder(s, prices, ctx());
    await rec.record({
      provider: "anthropic",
      model: "claude-opus-5-5",
      units: { input: 1000, output: 1000, cacheWrite: 0, cacheRead: 0 },
    });
    await rec.record({
      provider: "elevenlabs",
      kind: "music",
      model: "music_v2_5",
      seconds: 16,
      detail: "music",
    });
    await rec.record({ provider: "remotion", renders: 1, detail: "render:vertical" });
    const shared = createCostRecorder(
      s,
      prices,
      ctx({ projectId: null, rev: null, stage: "sfx-cache", source: "test" }),
    );
    await shared.record({
      provider: "elevenlabs",
      kind: "sfx",
      model: "eleven_text_to_sound_v2",
      seconds: 1,
    });

    const events = await readCosts(s, "p1");
    expect(events.map((e) => e.provider)).toEqual(["anthropic", "elevenlabs", "remotion"]);
    expect(events[0]?.usd).toBeCloseTo(0.024);
    // Запис без cacheWrite1h нормалізується до 0 — рядок журналу завжди повний.
    expect(events[0]?.units).toEqual({
      input: 1000,
      output: 1000,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
    expect(events[1]?.units).toEqual({ seconds: 16 });
    expect((await readCosts(s, null)).length).toBe(1);
    expect(sumUsd(events)).toBeCloseTo(0.024 + 0.04 + 0.01);
  });

  it("skips broken lines and rejects invalid events", async () => {
    const s = tmpStorage();
    await s.append(projectPaths("p1").costs, "{broken");
    await expect(recordCost(s, { usd: -1 } as never)).rejects.toThrow();
    expect(await readCosts(s, "p1")).toEqual([]);
  });
});

describe("stats", () => {
  it("distribution", () => {
    expect(distribution([])).toMatchObject({ count: 0, median: null });
    expect(distribution([1, 2, 3, 4, 10])).toEqual({ count: 5, mean: 4, median: 3, p90: 10, max: 10 });
    expect(distribution([1, 3]).median).toBe(2);
  });

  it("aggregateCosts scans project folders", async () => {
    const s = tmpStorage();
    // Проєкт 1: видано, одна правка, дорожче цілі.
    await s.writeJson(
      projectPaths("p1").project,
      fixtureProject({
        id: "p1",
        status: "delivered",
        firstDeliveredAt: "2026-10-06T10:10:00.000Z",
        revisions: [
          {
            n: 1,
            createdAt: "2026-10-06T10:00:00.000Z",
            basedOn: null,
            reason: "initial",
            at: null,
            instruction: null,
          },
          {
            n: 2,
            createdAt: "2026-10-06T10:20:00.000Z",
            basedOn: 1,
            reason: "edit",
            at: "delivered",
            instruction: "x",
          },
        ],
        rev: 2,
      }),
    );
    await s.writeJson(projectPaths("p1").rev(2).storyboard, fixtureStoryboard);
    await s.writeJson(projectPaths("p1").rev(2).pipeline, {
      attempts: {},
      fixRounds: {},
      qaRounds: 0,
      templateScenes: ["s3"],
      dirtyScenes: [],
    });
    const r1 = createCostRecorder(s, prices, ctx());
    await r1.record({
      provider: "anthropic",
      model: "claude-opus-5-5",
      units: { input: 500_000, output: 100_000, cacheWrite: 0, cacheRead: 0 },
    }); // $4
    const r1fix = createCostRecorder(s, prices, ctx({ stage: "fix", phase: "revision", rev: 2 }));
    await r1fix.record({
      provider: "anthropic",
      model: "claude-opus-5-5",
      units: { input: 0, output: 50_000, cacheWrite: 0, cacheRead: 0 },
    }); // $1
    const tracer = createTracer(s, "p1");
    await tracer.record({
      rev: 1,
      stage: "crawl",
      attempt: 1,
      phase: "first_delivery",
      jobId: null,
      startedAt: "2026-10-06T10:00:00.000Z",
      durationMs: 30_000,
      ok: true,
      error: null,
    });
    await tracer.record({
      rev: 2,
      stage: "fix",
      attempt: 1,
      phase: "revision",
      jobId: null,
      startedAt: "2026-10-06T10:20:00.000Z",
      durationMs: 9_000,
      ok: true,
      error: null,
    });

    // Проєкт 2: покинутий на чекпоінті.
    await s.writeJson(
      projectPaths("p2").project,
      fixtureProject({ id: "p2", status: "awaiting_brand", createdAt: "2026-10-06T11:00:00.000Z" }),
    );
    await createCostRecorder(s, prices, ctx({ projectId: "p2" })).record({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      units: { input: 500_000, output: 0, cacheWrite: 0, cacheRead: 0 },
    }); // $1

    // Проєкт 3: eval.
    await s.writeJson(projectPaths("p3").project, fixtureProject({ id: "p3", origin: "eval" }));
    await createCostRecorder(s, prices, ctx({ projectId: "p3", source: "eval" })).record({
      provider: "remotion",
      renders: 2,
    });

    // Тека без project.json ігнорується.
    await s.write("projects/garbage/x.txt", "x");

    const report = await aggregateCosts({ storage: s, prices, targetUsd: 3.5 });
    expect(report.rows.map((r) => r.projectId)).toEqual(["p2", "p1", "p3"]);
    const p1 = report.rows.find((r) => r.projectId === "p1");
    expect(p1).toMatchObject({
      firstDeliveryUsd: 4,
      revisionUsd: 1,
      totalUsd: 5,
      revisionsCount: 1,
      fixesCount: 1,
      templateScenesCount: 1,
      videoSeconds: 15,
      machineSecondsToFirstDelivery: 30,
      delivered: true,
      overTarget: true,
    });
    expect(report.summary).toMatchObject({
      totalUsd: 6,
      deliveredCount: 1,
      allInPerDelivered: 6,
      bySource: { chat: 6, eval: 0.02, test: 0 },
      fixedMonthlyUsd: null,
    });
    expect(report.summary.perDeliveredVideo.median).toBe(5);
    expect(report.summary.byStage[0]).toEqual({ stage: "brandkit", usd: 5 });

    const csv = statsToCsv(report.rows);
    expect(csv.split("\n")[0]).toContain("total_usd");
    expect(csv).toContain("p1,https://zerno.example.com/,delivered,chat,vertical,15,4,1,5,1,1,1,30,true");
  });
});
