import { type ChatEvent, STAGE_STEPS } from "@adc/shared";
import { fixtureSiteData } from "@adc/shared/fixtures";
import { describe, expect, it, vi } from "vitest";
import type { CrawlOptions, CrawlResult } from "../src/crawl.ts";
import { createCrawlStage, createIngestStage } from "../src/stage.ts";
import { makeContext } from "./helpers/context.ts";

// Браузер не потрібен: crawlSite лише проганяє фази прогресу, як справжній краулер.
vi.mock("../src/crawl.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/crawl.ts")>();
  return {
    ...actual,
    crawlSite: async (_url: string, opts: CrawlOptions): Promise<CrawlResult> => {
      await opts.onProgress?.({ phase: "pages", done: 1, total: 3 });
      await opts.onProgress?.({ phase: "pages", done: 1, total: 3 });
      await opts.onProgress?.({ phase: "pages", done: 3, total: 3 });
      await opts.onProgress?.({ phase: "assets", done: 0, total: 5 });
      await opts.onProgress?.({ phase: "assets", done: 5, total: 5 });
      return { site: structuredClone(fixtureSiteData), assets: [], blocked: [] } as unknown as CrawlResult;
    },
  };
});

type ProgressEvent = Extract<ChatEvent, { type: "progress" }>;

const progressOf = (events: Array<{ type: string }>) =>
  events.filter((e): e is ProgressEvent => e.type === "progress");

/** Кроки подій ідуть у порядку STAGE_STEPS і без двох однакових подій поспіль. */
function expectOrdered(events: ProgressEvent[], steps: string[]) {
  const idx = events.map((e) => steps.indexOf(e.step as string));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect(idx).toEqual([...idx].sort((a, b) => a - b));
  for (let i = 1; i < events.length; i++) {
    const [a, b] = [events[i - 1] as ProgressEvent, events[i] as ProgressEvent];
    expect(`${a.stage}|${a.step}|${a.label}`).not.toBe(`${b.stage}|${b.step}|${b.label}`);
  }
}

const crawling = STAGE_STEPS.crawling;
const label = (id: string) => crawling.find((s) => s.id === id)?.label as string;

describe("crawl: події підкроків", () => {
  it("сайт: open → pages (з лічильником) → assets, у порядку STAGE_STEPS", async () => {
    const { ctx, emit } = makeContext("crawl", { url: "https://zerno.example.com/", manualText: null });
    await createCrawlStage()(ctx);
    const events = progressOf(emit.events);

    expect(events.map((e) => [e.step, e.label, e.done, e.total])).toEqual([
      ["open", label("open"), null, null],
      ["pages", `${label("pages")} 1/3`, 1, 3],
      ["pages", `${label("pages")} 3/3`, 3, 3],
      ["assets", `${label("assets")} 0/5`, 0, 5],
      ["assets", `${label("assets")} 5/5`, 5, 5],
      ["assets", "Сайт проскановано", null, null],
    ]);
    expect(events.every((e) => e.stage === "crawl")).toBe(true);
    expectOrdered(
      events,
      crawling.map((s) => s.id),
    );
  });

  it("фото клієнта: крок photos з лічильником", async () => {
    const { ctx, emit } = makeContext("ingest", { files: [] });
    await createIngestStage()(ctx);
    const events = progressOf(emit.events);
    expect(events.map((e) => [e.stage, e.step, e.label])).toEqual([
      ["ingest", "photos", `${label("photos")} 0/0`],
    ]);
  });
});
