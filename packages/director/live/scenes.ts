/**
 * Живий прогін B4 (перше завдання блоку, один раз, вручну):
 *   LIVE=1 pnpm --filter @adc/director live:scenes
 *   LIVE=1 pnpm --filter @adc/director live:scenes -- --formats vertical,square,landscape --fix
 *
 * Фікстури «Зерно» (бренд-кіт + розкадровка, зображення-заглушки) → codegen (справжній Opus) →
 * check на справжньому RenderEngine (B3): типи, бандл, стіли ScenePreview у всіх форматах, аркуші.
 * З `--fix` — одне коло fix → check для сцен з помилками. Витрати пишуться з `source: "test"`.
 */
import { parseArgs } from "node:util";
import { createRenderEngine } from "@adc/render";
import { makeGradientPng } from "@adc/render/testing";
import {
  type AssetManifest,
  CheckReport,
  createAnthropicClient,
  createConsoleLogger,
  createCostRecorder,
  createLlm,
  createMemoryEmitter,
  createPromptLoader,
  createTracer,
  type Format,
  isLive,
  loadPrices,
  loadRootEnv,
  normalizeFormats,
  projectPaths,
  readCosts,
  type StageContext,
  type StageName,
  type StageParamsMap,
  storageFromEnv,
  sumUsd,
} from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { fixStage } from "../src/stages/fix.ts";

const { values } = parseArgs({
  options: {
    formats: { type: "string", default: "vertical,square" },
    fix: { type: "boolean", default: false },
  },
});

if (!isLive()) {
  console.error(
    "Живий прогін вимагає LIVE=1 (справжні виклики Anthropic). Приклад: LIVE=1 pnpm --filter @adc/director live:scenes",
  );
  process.exit(1);
}
loadRootEnv();

const formats = normalizeFormats((values.formats ?? "").split(",").map((f) => f.trim()) as Format[]);
const storage = storageFromEnv();
const projectId = `live-scenes-${Date.now().toString(36)}`;
const logger = createConsoleLogger({ projectId });
const prompts = createPromptLoader();
const client = createAnthropicClient();
const prices = loadPrices();

async function seed(): Promise<void> {
  const paths = projectPaths(projectId);
  const remap = (key: string) => key.replace(/^projects\/p1\//, `projects/${projectId}/`);
  await storage.writeJson(
    paths.project,
    fixtureProject({
      id: projectId,
      origin: "test",
      formats,
      brandkitVersion: 1,
      language: "uk",
      status: "directing",
    }),
  );
  await storage.writeJson(paths.brandkit(1), fixtureBrandKitFile);
  const manifest: AssetManifest = structuredClone(fixtureAssets);
  for (const a of manifest.assets) {
    a.path = remap(a.path).replace(/\.(jpg|svg)$/, ".png");
    a.mime = "image/png";
    await storage.write(a.path, makeGradientPng(a.width, a.height, "#6B3E26", "#E85D2A"));
  }
  await storage.writeJson(paths.assets, manifest);
  await storage.writeJson(paths.rev(1).storyboard, fixtureStoryboard);
}

function ctxFor<S extends StageName>(stage: S, params: StageParamsMap[S]): StageContext<S> {
  const cost = createCostRecorder(storage, prices, {
    projectId,
    rev: 1,
    stage,
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const trace = createTracer(storage, projectId);
  return {
    projectId,
    rev: 1,
    stage,
    attempt: 1,
    jobId: `${projectId}.${stage}.live`,
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace,
    cost,
    emit: createMemoryEmitter(),
    llm: createLlm({ client, prompts, cost, trace, logger }),
    prompts,
    logger: logger.child({ stage }),
  };
}

async function main(): Promise<void> {
  await seed();
  console.log(`Проєкт: ${storage.absPath(projectPaths(projectId).root)}  формати: ${formats.join(", ")}`);
  const engine = createRenderEngine();
  const check = createCheckStage({ engine });
  try {
    const t0 = Date.now();
    const gen = await codegenStage(ctxFor("codegen", { sceneIds: null, instructions: [] }));
    console.log(`codegen за ${Math.round((Date.now() - t0) / 1000)} с:`, gen.outputs);

    const t1 = Date.now();
    let res = await check(ctxFor("check", { sceneIds: null }));
    console.log(`check за ${Math.round((Date.now() - t1) / 1000)} с:`, res.outputs);

    if (values.fix && res.outputs.failedScenes.length > 0) {
      const fixed = await fixStage(ctxFor("fix", { sceneIds: res.outputs.failedScenes, reason: "check" }));
      console.log("fix:", fixed.outputs);
      res = await check(ctxFor("check", { sceneIds: fixed.outputs.sceneIds }));
      console.log("check після fix:", res.outputs);
    }

    const report = await storage.readJson(projectPaths(projectId).rev(1).check, (v) => CheckReport.parse(v));
    for (const e of report.compileErrors) console.log(`  compile ${e.sceneId}: ${e.message.split("\n")[0]}`);
    for (const e of report.runtimeErrors)
      console.log(`  runtime ${e.sceneId} [${e.format}@${e.frame}]: ${e.message.split("\n")[0]}`);
    for (const i of report.autoIssues) console.log(`  qa ${i.sceneId} [${i.format}] ${i.kind}: ${i.detail}`);
    for (const s of report.sheets) console.log(`  аркуш ${s.format}: ${storage.absPath(s.path)}`);
    console.log(`Стілів: ${report.stills.length}`);
  } finally {
    await engine.close();
  }
  const costs = await readCosts(storage, projectId);
  console.log(`Витрати: $${sumUsd(costs).toFixed(4)} (${costs.length} викликів)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
