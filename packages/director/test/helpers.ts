import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeGradientPng } from "@adc/render/testing";
import {
  type AssetManifest,
  type BrowserLog,
  createCostRecorder,
  createLlm,
  createMemoryEmitter,
  createMockAnthropic,
  createNoopTracer,
  createPromptLoader,
  LocalStorage,
  loadPrices,
  type MockReply,
  noopLogger,
  type ProjectState,
  projectPaths,
  QA_LOG_PREFIX,
  type RenderEngine,
  type RenderStillOptions,
  type StageContext,
  type StageName,
  type StageParamsMap,
  type Storyboard,
} from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { readExampleScenes } from "../src/context.ts";

export const PROJECT_ID = "p1";

/** Еталонні сцени motion-kit: назва → код. */
export function exampleSources(): Record<string, string> & {
  "hook-photo": string;
  "offer-price": string;
  "cta-logo": string;
  typographic: string;
  proof: string;
} {
  return readExampleScenes() as ReturnType<typeof exampleSources>;
}

export function tmpStorage(): LocalStorage {
  return new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-director-")));
}

export interface SeedOptions {
  rev?: number;
  storyboard?: Storyboard | null;
  project?: Partial<ProjectState>;
}

/** Проєкт «Зерно»: project.json, бренд-кіт v1, assets.json з файлами, розкадровка ревізії. */
export async function seedProject(storage: LocalStorage, opts: SeedOptions = {}): Promise<void> {
  const paths = projectPaths(PROJECT_ID);
  const rev = opts.rev ?? 1;
  await storage.writeJson(
    paths.project,
    fixtureProject({
      formats: ["vertical", "square"],
      brandkitVersion: 1,
      language: "uk",
      rev,
      revisions: Array.from({ length: rev }, (_, i) => ({
        n: i + 1,
        createdAt: "2026-10-06T10:00:00.000Z",
        basedOn: i === 0 ? null : i,
        reason: i === 0 ? ("initial" as const) : ("edit" as const),
        at: null,
        instruction: null,
      })),
      ...opts.project,
    }),
  );
  await storage.writeJson(paths.brandkit(1), fixtureBrandKitFile);
  const manifest: AssetManifest = structuredClone(fixtureAssets);
  for (const a of manifest.assets) {
    await storage.write(
      a.path,
      makeGradientPng(Math.min(a.width, 320), Math.min(a.height, 200), "#6B3E26", "#E85D2A"),
    );
  }
  await storage.writeJson(paths.assets, manifest);
  if (opts.storyboard !== null) {
    await storage.writeJson(paths.rev(rev).storyboard, opts.storyboard ?? fixtureStoryboard);
  }
}

export type Reply = MockReply | ((params: unknown) => MockReply);

export function makeCtx<S extends StageName>(
  storage: LocalStorage,
  stage: S,
  params: StageParamsMap[S],
  replies: Reply[] = [],
  opts: { rev?: number; attempt?: number } = {},
): StageContext<S> & {
  anthropic: ReturnType<typeof createMockAnthropic>;
  emitted: ReturnType<typeof createMemoryEmitter>;
} {
  const rev = opts.rev ?? 1;
  const anthropic = createMockAnthropic(replies as Parameters<typeof createMockAnthropic>[0]);
  const prompts = createPromptLoader();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev,
    stage,
    phase: "first_delivery",
    source: "test",
    attempt: opts.attempt ?? 1,
  });
  const trace = createNoopTracer();
  const emitted = createMemoryEmitter();
  return {
    anthropic,
    emitted,
    projectId: PROJECT_ID,
    rev,
    stage,
    attempt: opts.attempt ?? 1,
    jobId: `job-${stage}`,
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace,
    cost,
    emit: emitted,
    llm: createLlm({ client: anthropic, prompts, cost, trace, sleep: async () => {} }),
    prompts,
    logger: noopLogger,
  };
}

/** Текст user-повідомлення виклику мок-клієнта. */
export function userText(params: unknown): string {
  const p = params as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  return p.messages[0]?.content.find((c) => c.type === "text")?.text ?? "";
}

export function systemText(params: unknown): string {
  const p = params as { system: Array<{ text: string }> };
  return p.system.map((s) => s.text).join("\n");
}

export function fileBlocks(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([id, code]) => `<file name="${id}.tsx">\n${code}\n</file>`)
    .join("\n\n");
}

export const qaLogLine = (kind: string, detail: string) =>
  `${QA_LOG_PREFIX}${JSON.stringify({ kind, component: "FitText", detail, value: 30, frame: 10 })}`;

export interface MockEngineOptions {
  /** sceneId → помилка рендера (з логами, як RenderError). */
  fail?: Record<string, string>;
  /** sceneId → рядки логу браузера. */
  logs?: Record<string, string[]>;
  bundleError?: (attempt: number) => string | null;
}

/** Мок RenderEngine: пише справжні PNG у `out`, повертає логи за сценою. */
export function mockEngine(opts: MockEngineOptions = {}): RenderEngine & {
  stills: RenderStillOptions[];
  bundles: string[];
  closed: number;
} {
  const stills: RenderStillOptions[] = [];
  const bundles: string[] = [];
  let attempt = 0;
  const engine = {
    stills,
    bundles,
    closed: 0,
    async bundleJob({ jobDir }: { jobDir: string }) {
      attempt++;
      bundles.push(jobDir);
      const err = opts.bundleError?.(attempt) ?? null;
      if (err) throw new Error(err);
      return { serveUrl: "mock://bundle" };
    },
    async renderStill(o: RenderStillOptions) {
      stills.push(o);
      const sceneId = o.composition === "ScenePreview" ? o.inputProps.sceneId : "main";
      const logs: BrowserLog[] = (opts.logs?.[sceneId] ?? []).map((text) => ({ type: "log", text }));
      const failure = opts.fail?.[sceneId];
      if (failure) {
        const err = new Error(failure) as Error & { logs: BrowserLog[] };
        err.logs = [...logs, { type: "error", text: failure }];
        throw err;
      }
      await mkdir(path.dirname(o.out), { recursive: true });
      await writeFile(o.out, makeGradientPng(54, 96, "#112233", "#445566"));
      return { logs };
    },
    async renderMedia() {
      return { durationMs: 1 };
    },
    async close() {
      engine.closed++;
    },
  };
  return engine;
}
