/**
 * Живий прогін B2 (один раз, вручну, після хвилі 1):
 *   LIVE=1 pnpm --filter @adc/brandkit live
 *   LIVE=1 pnpm --filter @adc/brandkit live -- --project <id>          # збережений crawl у DATA_DIR/projects/<id>
 *   LIVE=1 pnpm --filter @adc/brandkit live -- --patch "Зробіть акцент темно-зеленим"
 *
 * Без `--project` бере фікстуру «Зерно» (site.json + assets.json) і малює для неї
 * зображення-заглушки. Справжні виклики Anthropic; витрати пишуться в журнал проєкту з `source: "test"`.
 */
import { parseArgs } from "node:util";
import {
  type AssetManifest,
  createAnthropicClient,
  createConsoleLogger,
  createCostRecorder,
  createLlm,
  createMemoryEmitter,
  createPromptLoader,
  createTracer,
  isLive,
  type LocalStorage,
  loadPrices,
  loadRootEnv,
  projectPaths,
  readCosts,
  type StageContext,
  type StageName,
  type StageParamsMap,
  storageFromEnv,
  sumUsd,
} from "@adc/shared";
import { fixtureAssets, fixtureSiteData } from "@adc/shared/fixtures";
import sharp from "sharp";
import { brandkitPatchStage, brandkitStage } from "../src/stage.ts";
import { formatBrandSummaryText, summarizeBrandKit } from "../src/summary.ts";
import { readBrandkit } from "../src/versions.ts";

async function placeholder(width: number, height: number, color: string, label: string): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="${color}"/>` +
      `<text x="50%" y="50%" font-size="${Math.round(height / 8)}" text-anchor="middle" fill="#FFFFFF" ` +
      `font-family="sans-serif">${label}</text></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

/** Кладе фікстуру «Зерно» в новий проєкт і малює заглушки скриншотів та асетів. */
async function seedFixture(storage: LocalStorage, projectId: string): Promise<void> {
  const paths = projectPaths(projectId);
  const remap = (key: string) => key.replace(/^projects\/p1\//, `projects/${projectId}/`);
  const site = structuredClone(fixtureSiteData);
  for (const p of site.pages) p.screenshot = p.screenshot ? remap(p.screenshot) : null;
  for (const s of site.screenshots) {
    s.path = remap(s.path);
    await storage.write(s.path, await placeholder(s.width, s.height, "#6B3E26", "Зерно — кав'ярня"));
  }
  const manifest: AssetManifest = structuredClone(fixtureAssets);
  for (const a of manifest.assets) {
    a.path = remap(a.path);
    if (a.mime.includes("svg")) {
      await storage.write(
        a.path,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${a.width}" height="${a.height}">` +
          `<text x="10" y="80" font-size="72" fill="#6B3E26" font-family="serif">Зерно</text></svg>`,
      );
    } else {
      await storage.write(a.path, await placeholder(a.width, a.height, "#8B5A3C", a.alt ?? a.id));
    }
  }
  await storage.writeJson(paths.site, site);
  await storage.writeJson(paths.assets, manifest);
}

function context<S extends "brandkit" | "brandkit-patch">(
  storage: LocalStorage,
  projectId: string,
  stage: S,
  params: StageParamsMap[S],
): StageContext<S> {
  const logger = createConsoleLogger({ run: "live-brandkit", stage });
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId,
    rev: 1,
    stage,
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const prompts = createPromptLoader({ reload: true });
  const trace = createTracer(storage, projectId);
  return {
    projectId,
    rev: 1,
    stage: stage as S & StageName,
    attempt: 1,
    jobId: `${projectId}:${stage}:1:1`,
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace,
    cost,
    emit: createMemoryEmitter(),
    llm: createLlm({ client: createAnthropicClient(), prompts, cost, trace, logger }),
    prompts,
    logger,
  };
}

async function main(): Promise<number> {
  loadRootEnv();
  if (!isLive()) {
    console.log("Живий прогін вимкнено. Запуск: LIVE=1 pnpm --filter @adc/brandkit live");
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Немає ANTHROPIC_API_KEY (кореневий .env або змінна середовища).");
    return 1;
  }
  const { values } = parseArgs({
    options: { project: { type: "string" }, patch: { type: "string" } },
    allowPositionals: true,
  });

  const storage = storageFromEnv();
  let projectId = values.project ?? "";
  if (!projectId) {
    projectId = `live-brandkit-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await seedFixture(storage, projectId);
    console.log(`Фікстура «Зерно» → ${storage.absPath(projectPaths(projectId).root)}`);
  } else if (!(await storage.exists(projectPaths(projectId).site))) {
    console.error(`Немає ${projectPaths(projectId).site} у ${storage.root}`);
    return 1;
  }

  const started = Date.now();
  const res = await brandkitStage(context(storage, projectId, "brandkit", {}));
  console.log(
    `✓ brandkit v${res.outputs.version} за ${Date.now() - started} мс → ${res.artifacts.join(", ")}`,
  );
  let version = res.outputs.version;

  if (values.patch) {
    const t0 = Date.now();
    const patched = await brandkitPatchStage(
      context(storage, projectId, "brandkit-patch", {
        instruction: values.patch,
        logoAssetId: null,
        facts: [],
      }),
    );
    version = patched.outputs.version;
    console.log(`✓ brandkit-patch v${version} за ${Date.now() - t0} мс: ${patched.outputs.summary}`);
  }

  const kit = await readBrandkit(storage, projectId, version);
  const manifest = (await storage.readJson(projectPaths(projectId).assets)) as AssetManifest;
  console.log(
    `\n${formatBrandSummaryText(summarizeBrandKit(kit, manifest.assets, { publicUrl: (k) => storage.publicUrl(k) }))}`,
  );
  if (kit.fixes.length) console.log(`\nПрограмні виправлення:\n- ${kit.fixes.join("\n- ")}`);

  const costs = await readCosts(storage, projectId);
  console.log(
    `\nВитрати: ${costs.length} записів, $${sumUsd(costs).toFixed(4)} → ${storage.absPath(projectPaths(projectId).costs)}`,
  );
  return 0;
}

process.exitCode = await main();
