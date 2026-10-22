import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAudioStage } from "@adc/audio";
import { createCrawlStage } from "@adc/crawler";
import {
  AssetManifest,
  type ChatEvent,
  type CostEvent,
  ProjectState,
  projectPaths,
  RenderMeta,
  readCosts,
  readTrace,
  Storyboard,
} from "@adc/shared";
import { createStageRegistry } from "@adc/worker";
import { parseMedia } from "@remotion/media-parser";
import { nodeReader } from "@remotion/media-parser/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { autoApprove, createHarness, type Harness } from "../src/harness.ts";
import { mockElevenLabs, RECORDED_STAGES, type RoutedAnthropic, recordedAnthropic } from "./helpers/mocks.ts";
import { type FixtureSite, startFixtureSite, testHostMap, testResolver, userPhoto } from "./helpers/site.ts";

/**
 * Наскрізний тест: справжні краулер (Chromium, локальний сайт), бренд-кіт, режисер (typecheck,
 * бандл rspack, стіли, QA), аудіо, оркестратор і рендер Remotion; LLM і ElevenLabs — записані
 * відповіді. Пайплайн проходить три чекпоінти й видає 5-секундні mp4 у двох форматах.
 *
 * Нижня межа тривалості ролика (15 с у проді) тут знижена до 5 с, щоб рендер займав секунди:
 * `normalizeStoryboard` бере межу з `@adc/shared`, інші модулі від неї не залежать.
 *
 * Увімкнено спекулятивний рендер (`ADC_SPECULATIVE_RENDER=1`): на чекпоінті 3 рендер стартує до
 * «Затвердити», а звичайні job після затвердження перевикористовують готові mp4 за хешем входів.
 */
vi.mock("@adc/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@adc/shared")>()),
  MIN_TOTAL_FRAMES: 150,
}));

let site: FixtureSite;
let dataDir: string;
let harness: Harness;
let anthropic: RoutedAnthropic;
let eleven: ReturnType<typeof mockElevenLabs>;
let projectId: string;
let finalStatus: string | null;
const approved: string[] = [];

const events = (): ChatEvent[] => harness.events.list(projectId);
const ofType = <T extends ChatEvent["type"]>(type: T) =>
  events().filter((e): e is Extract<ChatEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  vi.stubEnv("ADC_SPECULATIVE_RENDER", "1");
  site = await startFixtureSite();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "adc-integration-"));
  anthropic = recordedAnthropic();
  eleven = mockElevenLabs();
  const registry = createStageRegistry({
    overrides: {
      crawl: createCrawlStage({ resolve: testResolver, hostMap: testHostMap, maxPages: 5 }),
      audio: createAudioStage({ client: eleven }),
    },
  });
  harness = createHarness({ dataDir, anthropic, registry });
  autoApprove(harness, {
    formats: ["vertical", "square"],
    onApprove: (_id, checkpoint) => approved.push(checkpoint),
  });
  projectId = await harness.createProject({
    url: site.url,
    photos: [{ name: "terrace.jpg", data: await userPhoto() }],
    origin: "test",
  });
  finalStatus = await harness.waitForStatus(projectId, ["delivered", "failed"], 840_000);
}, 900_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await harness?.close();
  await site?.close();
  if (dataDir && !process.env.KEEP_INTEGRATION_DATA) await rm(dataDir, { recursive: true, force: true });
});

describe("пайплайн від URL до mp4", () => {
  it("доходить до видачі без збоїв", async () => {
    const failure = (await harness.driver.load(projectId))?.project.failure;
    expect(failure, JSON.stringify(failure)).toBeNull();
    expect(finalStatus).toBe("delivered");
    expect(harness.queue.errors).toEqual([]);
    expect(anthropic.unexpected).toEqual([]);
  });

  it("проходить три чекпоінти по порядку, кожен затверджено", () => {
    expect(ofType("checkpoint").map((e) => e.checkpoint)).toEqual(["brand", "script", "storyboard"]);
    expect(approved).toEqual(["brand", "script", "storyboard"]);
    const states = ofType("state").map((e) => e.status);
    for (const s of ["crawling", "brandkit", "awaiting_brand", "scripting", "awaiting_script", "directing"]) {
      expect(states).toContain(s);
    }
    expect(states.slice(-3)).toEqual(["awaiting_storyboard", "rendering", "delivered"]);
  });

  it("краулить сайт фікстури і приймає фото клієнта", async () => {
    expect(site.hits).toContain("/");
    const manifest = await harness.storage.readJson(projectPaths(projectId).assets, (v) =>
      AssetManifest.parse(v),
    );
    expect(manifest.assets.some((a) => a.source === "user")).toBe(true);
    expect(manifest.assets.some((a) => a.source === "site")).toBe(true);
  });

  it("чекпоінт 1 показує бренд-кіт, чекпоінт 3 — стіли обох форматів", () => {
    const [brand, script, board] = ofType("checkpoint").map((e) => e.payload);
    expect(brand?.checkpoint === "brand" && brand.brandkit.identity.name).toBe("Зерно");
    expect(script?.checkpoint === "script" && script.durationSeconds).toBe(5);
    if (board?.checkpoint !== "storyboard") throw new Error("немає чекпоінта 3");
    expect(board.primaryFormat).toBe("vertical");
    expect(board.stills.length).toBe(4); // 2 сцени × 2 кадри в основному форматі
    expect(board.sheets.map((s) => s.format)).toContain("square");
  });

  it("затвердження сценарію робить непідтверджені твердження фактами клієнта", async () => {
    const project = await harness.storage.readJson(projectPaths(projectId).project, (v) =>
      ProjectState.parse(v),
    );
    const kit = await harness.storage.readJson(
      projectPaths(projectId).brandkit(project.brandkitVersion as number),
      (v) => v as { facts: Array<{ source: string; text: string }> },
    );
    expect(kit.facts.some((f) => f.source === "client" && f.text.includes("10%"))).toBe(true);
  });

  it("рендерить 5-секундні mp4 зі звуком у кожному обраному форматі + постер", async () => {
    const project = await harness.storage.readJson(projectPaths(projectId).project, (v) =>
      ProjectState.parse(v),
    );
    expect(project.formats).toEqual(["vertical", "square"]);
    const rev = projectPaths(projectId).rev(project.rev);
    const storyboard = await harness.storage.readJson(rev.storyboard, (v) => Storyboard.parse(v));
    expect(storyboard.scenes.map((s) => s.id)).toEqual(["s1", "s2"]);

    const expected = { vertical: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } };
    for (const format of ["vertical", "square"] as const) {
      const file = harness.storage.absPath(rev.render(format));
      expect((await stat(file)).size).toBeGreaterThan(10_000);
      const meta = await parseMedia({
        src: file,
        reader: nodeReader,
        fields: { durationInSeconds: true, dimensions: true, tracks: true },
        acknowledgeRemotionLicense: true,
      });
      expect(meta.durationInSeconds).toBeCloseTo(5, 0);
      expect(meta.dimensions).toMatchObject(expected[format]);
      expect(meta.tracks.map((t) => t.type)).toEqual(expect.arrayContaining(["video", "audio"]));
    }
    expect((await stat(harness.storage.absPath(rev.poster))).size).toBeGreaterThan(1000);

    const delivery = ofType("artifact");
    expect(delivery.length).toBeGreaterThan(0);
  });

  it("спекулятивний рендер: звичайні job після «Затвердити» перевикористовують готові mp4", async () => {
    const project = await harness.storage.readJson(projectPaths(projectId).project, (v) =>
      ProjectState.parse(v),
    );
    const renders = harness.queue.history.filter((j) => j.stage === "render" && j.projectId === projectId);
    expect(renders.map((j) => j.jobId.split(".").slice(2).join("."))).toEqual([
      "r1.a1.spec-vertical",
      "r1.a1.spec-square",
      "r1.a1.vertical",
      "r1.a1.square",
    ]);
    const rev = projectPaths(projectId).rev(project.rev);
    for (const format of ["vertical", "square"] as const) {
      const meta = await harness.storage.readJson(rev.renderMeta(format), (v) => RenderMeta.parse(v));
      expect(meta.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    }
    // Спекулятивний рендер мовчить; після «Затвердити» — старт і одразу 100% (перевикористано).
    expect(
      ofType("progress")
        .filter((e) => e.stage === "render")
        .map((e) => e.label),
    ).toEqual(["Рендерю відео (9:16, 1:1)…", "Рендерю 9:16… 100%", "Рендерю 1:1… 100%"]);
  });

  it("без шаблонних сцен: записаний код скомпілювався з першої спроби", async () => {
    const project = await harness.storage.readJson(projectPaths(projectId).project, (v) =>
      ProjectState.parse(v),
    );
    const pipe = await harness.storage.readJson(
      projectPaths(projectId).rev(project.rev).pipeline,
      (v) => v as { templateScenes: string[]; fixRounds: Record<string, number> },
    );
    expect(pipe.templateScenes).toEqual([]);
    expect(pipe.fixRounds).toEqual({});
    for (const stage of RECORDED_STAGES) expect(anthropic.callsByStage.get(stage) ?? 0).toBeGreaterThan(0);
    expect(anthropic.callsByStage.get("storyboard")).toBe(1);
  });

  it("costs.jsonl містить Anthropic (з хешами промптів), ElevenLabs і Remotion", async () => {
    const costs: CostEvent[] = await readCosts(harness.storage, projectId);
    const shared = await readCosts(harness.storage, null);
    const anthropicEvents = costs.filter((e) => e.provider === "anthropic");
    for (const e of anthropicEvents) {
      expect(e.promptHash, e.promptName ?? "").toMatch(/^[0-9a-f]{8,}$/);
      expect(e.usd).toBeGreaterThan(0);
    }
    expect(new Set(anthropicEvents.map((e) => e.promptName))).toEqual(
      new Set(["brandkit", "storyboard", "codegen", "qa", "audio-plan", "sfx-design", "review"]),
    );
    const music = costs.filter((e) => e.provider === "elevenlabs");
    expect(music.length).toBeGreaterThan(0);
    // Стандартні SFX без прогрітого кешу догенеровуються в спільний журнал.
    expect(
      [...costs, ...shared].some((e) => e.provider === "elevenlabs" && e.detail?.startsWith("sfx")),
    ).toBe(true);
    // Рендер — лише спекулятивний (облік `preview <format>`): звичайні job перевикористали mp4 і
    // витрат Remotion не писали.
    const renders = costs.filter((e) => e.provider === "remotion");
    expect(renders.map((e) => e.detail).sort()).toEqual(["preview square", "preview vertical"]);
    expect(costs.every((e) => e.source === "test" && e.projectId === projectId)).toBe(true);
    expect(costs.every((e) => e.phase === "first_delivery")).toBe(true);

    // У чаті видно суму витрат: подія cost після стадій, останнє значення = журнал.
    const total = costs.reduce((a, e) => a + e.usd, 0);
    const last = ofType("cost").at(-1);
    expect(last?.totalUsd).toBeCloseTo(total, 4);
  });

  it("trace фіксує кожну стадію", async () => {
    const stages = new Set((await readTrace(harness.storage, projectId)).map((t) => t.stage));
    for (const s of [
      "crawl",
      "ingest",
      "brandkit",
      "storyboard",
      "codegen",
      "check",
      "qa",
      "audio",
      "render",
    ]) {
      expect(stages).toContain(s);
    }
  });
});
