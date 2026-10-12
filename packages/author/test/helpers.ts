import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCodegenContext } from "@adc/director";
import { makeGradientPng } from "@adc/render/testing";
import {
  type AssetManifest,
  type BrowserLog,
  createCostRecorder,
  createLlm,
  createMemoryEmitter,
  createMockAgent,
  createMockAnthropic,
  createNoopTracer,
  createPromptLoader,
  LocalStorage,
  loadPrices,
  type MockAgentCall,
  type MockAgentStep,
  noopLogger,
  type ProjectState,
  projectPaths,
  type RenderEngine,
  type RenderStillOptions,
  type StageContext,
  type StageParamsMap,
  type Storyboard,
  type Tuning,
  Tuning as TuningSchema,
} from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";

export const PROJECT_ID = "p1";

/** Еталонні сцени motion-kit (компілюються і проходять guard на фікстурі «Зерно»). */
export const examples = loadCodegenContext().examples as Record<string, string> & {
  "hook-photo": string;
  "offer-price": string;
  "cta-logo": string;
};

/** Сцена, яку відхиляє guard (`Date`). */
export const BAD_SCENE = examples["offer-price"].replace(
  "export default function",
  "const year = new Date().getFullYear();\nexport default function",
);

/** Розкадровка з двох сцен фікстури: s1 (фото) і s2 (ціна з подіями). */
export const twoScenes: Storyboard = {
  ...fixtureStoryboard,
  scenes: fixtureStoryboard.scenes.slice(0, 2),
  musicBrief: {
    ...fixtureStoryboard.musicBrief,
    structure: [{ label: "main", sceneIds: ["s1", "s2"], energy: 0.5, mix: "full" }],
  },
};

export function tmpStorage(): LocalStorage {
  return new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-author-")));
}

export async function seedProject(
  storage: LocalStorage,
  opts: { rev?: number; storyboard?: Storyboard; project?: Partial<ProjectState> } = {},
): Promise<void> {
  const paths = projectPaths(PROJECT_ID);
  const rev = opts.rev ?? 1;
  await storage.writeJson(
    paths.project,
    fixtureProject({
      formats: ["vertical"],
      brandkitVersion: 1,
      language: "uk",
      rev,
      revisions: Array.from({ length: rev }, (_, i) => ({
        n: i + 1,
        createdAt: "2026-10-12T10:00:00.000Z",
        basedOn: i === 0 ? null : i,
        reason: i === 0 ? ("initial" as const) : ("edit" as const),
        at: i === 0 ? null : ("storyboard" as const),
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
  for (let r = 1; r <= rev; r++) {
    await storage.writeJson(paths.rev(r).storyboard, opts.storyboard ?? twoScenes);
  }
}

export const testTuning = (over: Partial<Tuning> = {}): Tuning => ({ ...TuningSchema.parse({}), ...over });

export function makeCtx(
  storage: LocalStorage,
  params: StageParamsMap["author"],
  script: Array<MockAgentStep | ((calls: readonly MockAgentCall[]) => MockAgentStep)>,
  opts: { rev?: number } = {},
): StageContext<"author"> & {
  agent: ReturnType<typeof createMockAgent>;
  emitted: ReturnType<typeof createMemoryEmitter>;
} {
  const rev = opts.rev ?? 1;
  const prompts = createPromptLoader();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev,
    stage: "author",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  const trace = createNoopTracer();
  const emitted = createMemoryEmitter();
  const agent = createMockAgent(script, { prompts });
  const llm = createLlm({ client: createMockAnthropic([]), prompts, cost, trace });
  return {
    agent,
    emitted,
    projectId: PROJECT_ID,
    rev,
    stage: "author",
    attempt: 1,
    jobId: "job-author",
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace,
    cost,
    emit: emitted,
    llm: { ...llm, agent: agent.agent },
    prompts,
    logger: noopLogger,
  };
}

/** Мок RenderEngine: справжні PNG (різні для різних кадрів), логи за сценою. */
export function mockEngine(opts: { logs?: Record<string, string[]> } = {}): RenderEngine & {
  stills: RenderStillOptions[];
  bundles: string[];
  closed: number;
} {
  const stills: RenderStillOptions[] = [];
  const bundles: string[] = [];
  const hex = (n: number) => (Math.abs(Math.round(n)) % 256).toString(16).padStart(2, "0");
  const engine = {
    stills,
    bundles,
    closed: 0,
    async bundleJob({ jobDir }: { jobDir: string }) {
      bundles.push(jobDir);
      return { serveUrl: "mock://bundle" };
    },
    async renderStill(o: RenderStillOptions) {
      stills.push(o);
      const sceneId = o.composition === "ScenePreview" ? o.inputProps.sceneId : "main";
      const logs: BrowserLog[] = (opts.logs?.[sceneId] ?? []).map((text) => ({ type: "log", text }));
      await mkdir(path.dirname(o.out), { recursive: true });
      await writeFile(o.out, makeGradientPng(54, 96, `#${hex(o.frame * 3)}4040`, `#20${hex(o.frame)}66`));
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
