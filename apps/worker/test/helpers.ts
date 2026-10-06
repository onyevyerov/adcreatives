import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMemoryEmitter,
  createMockAnthropic,
  createPromptLoader,
  type Emitter,
  LocalStorage,
  loadPrices,
  MemoryQueue,
  makeJobId,
  noopLogger,
  type ProjectState,
  projectPaths,
  type StageJob,
  type StageName,
  type StageParamsMap,
} from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import type { StageJobDeps } from "../src/process.ts";
import { createStageRegistry, type StageRegistry } from "../src/stages.ts";

export const NOW = new Date("2026-10-06T10:00:00.000Z");

export async function tempStorage(): Promise<LocalStorage> {
  return new LocalStorage(await mkdtemp(path.join(os.tmpdir(), "adc-worker-")));
}

export async function writeProject(
  storage: LocalStorage,
  overrides: Partial<ProjectState> = {},
): Promise<ProjectState> {
  const project = fixtureProject(overrides);
  await storage.writeJson(projectPaths(project.id).project, project);
  return project;
}

export function stageJob<S extends StageName>(
  stage: S,
  params: StageParamsMap[S],
  opts: { projectId?: string; rev?: number; attempt?: number; suffix?: string } = {},
): StageJob<S> {
  const projectId = opts.projectId ?? "p1";
  const rev = opts.rev ?? 1;
  const attempt = opts.attempt ?? 1;
  return {
    jobId: makeJobId(projectId, stage, rev, attempt, opts.suffix),
    projectId,
    rev,
    stage,
    attempt,
    params,
  };
}

export interface TestDeps extends StageJobDeps {
  queue: MemoryQueue;
  emitters: Map<string, Emitter & { events: unknown[] }>;
}

export function makeDeps(
  storage: LocalStorage,
  overrides: Partial<StageRegistry> = {},
  extra: Partial<StageJobDeps> = {},
): TestDeps {
  const emitters = new Map<string, Emitter & { events: unknown[] }>();
  return {
    registry: createStageRegistry({ overrides }),
    queue: new MemoryQueue(),
    storage,
    prices: loadPrices(),
    prompts: createPromptLoader(),
    anthropic: () => createMockAnthropic([]),
    emitterFor: (projectId) => {
      let e = emitters.get(projectId);
      if (!e) {
        e = createMemoryEmitter(() => NOW);
        emitters.set(projectId, e);
      }
      return e;
    },
    logger: noopLogger,
    emitters,
    ...extra,
  } as TestDeps;
}
