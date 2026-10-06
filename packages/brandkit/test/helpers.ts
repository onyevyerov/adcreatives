import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Asset,
  type AssetManifest,
  createCostRecorder,
  createLlm,
  createMemoryEmitter,
  createMockAnthropic,
  createNoopTracer,
  createPromptLoader,
  findRepoRoot,
  LocalStorage,
  loadPrices,
  type MockAnthropic,
  type MockReply,
  noopLogger,
  projectPaths,
  type SiteData,
  type StageContext,
  type StageName,
  type StageParamsMap,
} from "@adc/shared";
import { fixtureAssets, fixtureSiteData } from "@adc/shared/fixtures";
import sharp from "sharp";

export const PROJECT = "p1";

export function tempStorage(): LocalStorage {
  return new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-brandkit-")));
}

export async function solidPng(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

export const LOGO_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120">' +
    '<rect width="320" height="120" fill="#6B3E26"/><circle cx="60" cy="60" r="40" fill="#FFF8F0"/></svg>',
);

export function photoAsset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    kind: "photo",
    source: "site",
    path: projectPaths(PROJECT).asset(`${id}.png`),
    originUrl: `https://zerno.example.com/img/${id}.jpg`,
    pageUrl: "https://zerno.example.com/uk/",
    mime: "image/png",
    bytes: 1000,
    width: 800,
    height: 600,
    phash: null,
    dominantColors: ["#AA7744"],
    alt: `Фото ${id}`,
    context: null,
    isLogoCandidate: false,
    priority: 1,
    ...overrides,
  };
}

/** Записує site.json, assets.json і файли зображень фікстури (кав'ярня «Зерно»). */
export async function seedProject(
  storage: LocalStorage,
  opts: { site?: SiteData; assets?: Asset[] } = {},
): Promise<{ site: SiteData; assets: Asset[] }> {
  const site = opts.site ?? structuredClone(fixtureSiteData);
  const assets = opts.assets ?? structuredClone(fixtureAssets.assets);
  const paths = projectPaths(PROJECT);
  await storage.writeJson(paths.site, site);
  const manifest: AssetManifest = { assets, updatedAt: fixtureAssets.updatedAt };
  await storage.writeJson(paths.assets, manifest);
  for (const shot of site.screenshots) {
    await storage.write(shot.path, await solidPng(shot.width, shot.height, "#FFF8F0"));
  }
  for (const a of assets) {
    if (a.mime.includes("svg")) await storage.write(a.path, LOGO_SVG);
    else await storage.write(a.path, await solidPng(a.width, a.height, a.dominantColors[0] ?? "#888888"));
  }
  return { site, assets };
}

export function makeCtx<S extends "brandkit" | "brandkit-patch">(
  stage: S,
  storage: LocalStorage,
  params: StageParamsMap[S],
  replies: Array<MockReply | ((p: unknown) => MockReply)>,
): StageContext<S> & { client: MockAnthropic; emitted: ReturnType<typeof createMemoryEmitter> } {
  const client = createMockAnthropic(replies as never);
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT,
    rev: 1,
    stage,
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const prompts = createPromptLoader({ dir: path.join(findRepoRoot(), "prompts") });
  const trace = createNoopTracer();
  const llm = createLlm({ client, prompts, cost, trace, sleep: async () => {} });
  const emitted = createMemoryEmitter();
  return {
    projectId: PROJECT,
    rev: 1,
    stage: stage as S & StageName,
    attempt: 1,
    jobId: `${PROJECT}:${stage}:1:1`,
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace,
    cost,
    emit: emitted,
    llm,
    prompts,
    logger: noopLogger,
    client,
    emitted,
  };
}

/** Текст user-повідомлення з першого виклику моку. */
export function userText(client: MockAnthropic, call = 0): string {
  const content = client.calls[call]?.params.messages[0]?.content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

export function imageCount(client: MockAnthropic, call = 0): number {
  const content = client.calls[call]?.params.messages[0]?.content;
  return Array.isArray(content) ? content.filter((b) => b.type === "image").length : 0;
}
