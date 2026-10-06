import {
  createCostRecorder,
  createPromptLoader,
  loadPrices,
  projectPaths,
  readCosts,
  sharedPaths,
} from "@adc/shared";
import { describe, expect, it } from "vitest";
import { ensureCustomSfx, loadStandardCues, sfxHash } from "../src/sfx.ts";
import { runSfxCacheCli, warmSfxCache } from "../src/sfxCache.ts";
import { instantGate, mockElevenLabs, PROJECT_ID, tmpStorage } from "./helpers.ts";

const prompts = createPromptLoader();
const library = loadStandardCues(prompts);

const sharedCost = (storage: ReturnType<typeof tmpStorage>) =>
  createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "sfx-cache",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });

describe("standard SFX cache", () => {
  it("warms all 8 cues once into cache/sfx/<hash>.mp3 with shared costs; second run is free", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    const opts = { storage, prompts, client: () => client, gate: instantGate(), cost: sharedCost(storage) };
    const first = await warmSfxCache(opts);
    expect(first.filter((f) => f.generated)).toHaveLength(8);
    expect(client.calls).toHaveLength(8);
    for (const call of client.calls) {
      expect(call.request).toMatchObject({ promptInfluence: 0.6, modelId: "eleven_text_to_sound_v2" });
    }
    const whoosh = sharedPaths.sfxCache(sfxHash(library.whoosh));
    expect((await storage.read(whoosh)).toString()).toBe(`SFX:${library.whoosh.text}`);
    expect(await storage.exists(sharedPaths.sfxCacheMeta(sfxHash(library.whoosh)))).toBe(true);

    const costs = await readCosts(storage, null);
    expect(costs).toHaveLength(8);
    expect(
      costs.every((c) => c.provider === "elevenlabs" && c.stage === "sfx-cache" && c.projectId === null),
    ).toBe(true);
    expect(costs.find((c) => c.detail === "sfx:riser")?.units).toEqual({ seconds: 1.5 });

    const second = await warmSfxCache(opts);
    expect(second.every((f) => !f.generated)).toBe(true);
    expect(client.calls).toHaveLength(8);
  });

  it("the CLI refuses paid calls without LIVE=1", async () => {
    const prev = process.env.LIVE;
    // "0", а не delete: loadRootEnv не перезаписує наявні змінні, тож LIVE=1 з .env не підхопиться.
    process.env.LIVE = "0";
    try {
      expect(await runSfxCacheCli([])).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.LIVE;
      else process.env.LIVE = prev;
    }
  });
});

describe("custom SFX", () => {
  it("cached per project by spec hash; costs go to the project log", async () => {
    const storage = tmpStorage();
    const client = mockElevenLabs();
    const cost = createCostRecorder(storage, loadPrices(), {
      projectId: PROJECT_ID,
      rev: 1,
      stage: "audio",
      phase: "first_delivery",
      source: "test",
      attempt: 1,
    });
    const deps = { storage, client: () => client, gate: instantGate() };
    const def = { text: "cup clink", durationSeconds: 1 };
    const a = await ensureCustomSfx(deps, cost, PROJECT_ID, "cup", def);
    const b = await ensureCustomSfx(deps, cost, PROJECT_ID, "cup", def);
    expect(a.key).toBe(projectPaths(PROJECT_ID).sfx(`${sfxHash(def)}.mp3`));
    expect([a.generated, b.generated]).toEqual([true, false]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.request).toMatchObject({
      text: "cup clink",
      durationSeconds: 1,
      promptInfluence: 0.6,
    });
    const costs = await readCosts(storage, PROJECT_ID);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ units: { seconds: 1 }, usd: 0.002 });
  });
});
