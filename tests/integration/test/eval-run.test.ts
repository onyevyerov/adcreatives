import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAudioStage } from "@adc/audio";
import { createCrawlStage } from "@adc/crawler";
import { createStageRegistry } from "@adc/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type EvalDeps, type EvalReport, runEvalCli } from "../src/eval.ts";
import { mockElevenLabs, recordedAnthropic } from "./helpers/mocks.ts";
import { type FixtureSite, startFixtureSite, testHostMap, testResolver } from "./helpers/site.ts";

/**
 * `pnpm eval` наскрізно на записаних відповідях: прогін по списку з одного сайту, далі
 * `--from render` (повний перезапуск рендеру) і `--from qa --only` зі збережених даних.
 * Як і в pipeline.test.ts, нижня межа ролика знижена до 5 с.
 */
vi.mock("@adc/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@adc/shared")>()),
  MIN_TOTAL_FRAMES: 150,
}));

let site: FixtureSite;
let tmp: string;
let runsDir: string;
const output: string[] = [];

function deps(): EvalDeps {
  return {
    anthropic: recordedAnthropic(),
    registry: createStageRegistry({
      overrides: {
        crawl: createCrawlStage({ resolve: testResolver, hostMap: testHostMap, maxPages: 5 }),
        audio: createAudioStage({ client: mockElevenLabs() }),
      },
    }),
    print: (line) => output.push(line),
  };
}

async function readReport(run: string): Promise<EvalReport> {
  return JSON.parse(await readFile(path.join(runsDir, run, "report.json"), "utf8")) as EvalReport;
}

async function runs(): Promise<string[]> {
  return (await readdir(runsDir)).sort();
}

let first: EvalReport;

beforeAll(async () => {
  // Записані відповіді й очікування («--from qa --only» → ЧП2) — для пайплайна без звукорежисера
  // і рецензента; режим designer покривають тести машини і eval.test.ts.
  vi.stubEnv("ADC_SFX_MODE", "storyboard");
  vi.stubEnv("ADC_FILM_REVIEW", "off");
  site = await startFixtureSite();
  tmp = await mkdtemp(path.join(os.tmpdir(), "adc-eval-run-"));
  runsDir = path.join(tmp, "runs");
  const sites = path.join(tmp, "sites.json");
  await writeFile(sites, JSON.stringify([{ url: site.url, name: "zerno", formats: ["9:16"] }]));
  expect(await runEvalCli(["--sites", sites, "--out", runsDir], deps())).toBe(0);
  const [run] = await runs();
  first = await readReport(run as string);
}, 900_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await site?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("pnpm eval на списку з одного сайту", () => {
  it("проходить до кінця і пише звіт з вартістю, часом і якістю", () => {
    expect(first.summary).toMatchObject({ sites: 1, delivered: 1, failed: 0 });
    const [r] = first.sites;
    expect(r).toMatchObject({
      name: "01-zerno",
      status: "delivered",
      error: null,
      formats: ["vertical"],
      videoSeconds: 5,
      scenes: 2,
      firstTryScenes: 2,
      templateScenes: 0,
      qaFirstPass: true,
    });
    expect(r?.usd).toBeGreaterThan(0);
    expect(r?.usdByProvider.map((p) => p.key).sort()).toEqual(["anthropic", "elevenlabs", "remotion"]);
    expect(r?.machineSeconds).toBeGreaterThan(0);
    expect(r?.wallSeconds).toBeGreaterThan(0);
    expect(first.summary.firstTryShare).toBe(1);
    expect(first.summary.qaPassShare).toBe(1);
    expect(output.some((l) => l.includes("чекпоінт storyboard"))).toBe(true);
  });

  it("копіює відео, постер, стіли й аркуші в sites/<сайт>/", () => {
    const runDir = path.join(runsDir, first.run);
    const files = first.sites[0]?.files ?? [];
    for (const f of [
      "sites/01-zerno/vertical.mp4",
      "sites/01-zerno/poster.png",
      "sites/01-zerno/sheets/vertical.png",
    ]) {
      expect(files).toContain(f);
      expect(existsSync(path.join(runDir, f))).toBe(true);
    }
    expect(existsSync(path.join(runDir, "sites", "01-zerno", "stills", "vertical"))).toBe(true);
    expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
  });

  it("--from render перезапускає рендер зі збережених даних, не чіпаючи старий прогін", async () => {
    expect(await runEvalCli(["--from", "render", "--run", first.run, "--out", runsDir], deps())).toBe(0);
    const rerun = (await runs()).find((r) => r.includes(".from-render"));
    expect(rerun).toBeDefined();
    const report = await readReport(rerun as string);
    expect(report).toMatchObject({ from: "render", baseRun: first.run, only: false });
    const [r] = report.sites;
    expect(r).toMatchObject({ status: "delivered", llmCalls: 0 });
    expect(r?.usdByProvider.map((p) => p.key)).toEqual(["remotion"]);
    expect(existsSync(path.join(runsDir, rerun as string, "sites", r?.name as string, "vertical.mp4"))).toBe(
      true,
    );
    // Старий прогін не змінився.
    expect(await readReport(first.run)).toEqual(first);
  });

  it("--from qa --only виконує лише QA і зупиняється на чекпоінті (без автозатвердження)", async () => {
    expect(await runEvalCli(["--from", "qa", "--run", first.run, "--only", "--out", runsDir], deps())).toBe(
      0,
    );
    const rerun = (await runs()).find((r) => r.includes(".from-qa"));
    const report = await readReport(rerun as string);
    const [r] = report.sites;
    expect(r).toMatchObject({ status: "awaiting_storyboard", delivered: false, llmCalls: 1, error: null });
    expect(r?.usdByStage.map((s) => s.key)).toEqual(["qa"]);
  });
});
