import { audioStage } from "@adc/audio";
import { brandkitPatchStage, brandkitStage } from "@adc/brandkit";
import { crawlStage, ingestStage } from "@adc/crawler";
import { QUEUE_NAMES, STAGE_NAMES, STAGE_QUEUE } from "@adc/shared";
import { describe, expect, it } from "vitest";
import {
  createStageRegistry,
  defaultDirectorStages,
  queueOf,
  resolveStage,
  stagesForQueue,
} from "../src/stages.ts";

describe("stage registry", () => {
  it("has a Stage for every StageName", () => {
    const registry = createStageRegistry();
    for (const name of STAGE_NAMES) expect(typeof registry[name]).toBe("function");
    expect(Object.keys(registry).sort()).toEqual([...STAGE_NAMES].sort());
  });

  it("wires the real wave-1 stages", () => {
    const registry = createStageRegistry();
    expect(registry.crawl).toBe(crawlStage);
    expect(registry.ingest).toBe(ingestStage);
    expect(registry.brandkit).toBe(brandkitStage);
    expect(registry["brandkit-patch"]).toBe(brandkitPatchStage);
    expect(registry.audio).toBe(audioStage);
  });

  it("routes stages to queues by STAGE_QUEUE", () => {
    expect(stagesForQueue("crawl")).toEqual(["crawl", "ingest"]);
    expect(stagesForQueue("llm")).toEqual([
      "brandkit",
      "brandkit-patch",
      "storyboard",
      "codegen",
      "author",
      "fix",
      "qa",
      "revise",
    ]);
    expect(stagesForQueue("cpu")).toEqual(["check"]);
    expect(stagesForQueue("audio")).toEqual(["audio"]);
    expect(stagesForQueue("render")).toEqual(["render"]);
    expect(stagesForQueue("pipeline")).toEqual([]);
    for (const s of STAGE_NAMES) expect(queueOf(s)).toBe(STAGE_QUEUE[s]);
    // кожна стадія потрапляє рівно в одну чергу
    const all = QUEUE_NAMES.flatMap((q) => stagesForQueue(q));
    expect(all.sort()).toEqual([...STAGE_NAMES].sort());
  });

  it("resolveStage refuses a stage from a foreign queue or an unknown name", () => {
    const registry = createStageRegistry();
    expect(resolveStage(registry, "crawl", "crawl")).toBe(crawlStage);
    expect(resolveStage(registry, "llm", "crawl")).toBeNull();
    expect(resolveStage(registry, "llm", "nope")).toBeNull();
    expect(resolveStage(registry, "pipeline", "render")).toBeNull();
  });

  it("director stages and overrides are injectable", () => {
    const storyboard = async () => ({ artifacts: [], outputs: { unverifiedClaims: 0, totalFrames: 450 } });
    const director = {
      ...defaultDirectorStages(() => {
        throw new Error("engine is not used here");
      }),
      storyboard,
    };
    const crawl = async () => ({
      artifacts: [],
      outputs: { mode: "site" as const, partial: false, pages: 1, photos: 0 },
    });
    const registry = createStageRegistry({ director, overrides: { crawl } });
    expect(registry.storyboard).toBe(storyboard);
    expect(registry.crawl).toBe(crawl);
  });
});
