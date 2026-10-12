import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BrandKitFile,
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
  type StageContext,
  type Storyboard,
} from "@adc/shared";
import { fixtureBrandKit, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import type { ChunkLayout } from "../src/chunks.ts";
import type { ElevenLabsLike, ElevenLabsRequestOptions } from "../src/client.ts";
import { ElevenLabsGate } from "../src/gate.ts";
import type { AudioPlanDraft } from "../src/plan.ts";

export const PROJECT_ID = "p1";

export function tmpStorage(): LocalStorage {
  return new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-audio-")));
}

/** Стрім, як його повертає SDK. */
export function audioStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type Reply = unknown | Error | ((req: unknown) => unknown);

export interface MockCall {
  method: "composeDetailed" | "compose" | "convert";
  request: Record<string, unknown>;
  options: ElevenLabsRequestOptions | undefined;
}

/** Мок `@elevenlabs/elevenlabs-js`: черга відповідей на кожен метод; Error у черзі — кидається. */
export function mockElevenLabs(
  queues: { composeDetailed?: Reply[]; compose?: Reply[]; convert?: Reply[] } = {},
): ElevenLabsLike & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const q = {
    composeDetailed: [...(queues.composeDetailed ?? [])],
    compose: [...(queues.compose ?? [])],
    convert: [...(queues.convert ?? [])],
  };
  const take = async (method: MockCall["method"], request: unknown, options?: ElevenLabsRequestOptions) => {
    calls.push({ method, request: request as Record<string, unknown>, options });
    const queue = q[method];
    // Без черги: детермінований «аудіо»-стрім.
    if (queue.length === 0) {
      if (method === "composeDetailed")
        return { json: {}, audio: Buffer.from("MUSIC-DETAILED"), filename: "a.mp3" };
      if (method === "compose") return audioStream("MUSIC-COMPOSE");
      return audioStream(`SFX:${(request as { text: string }).text}`);
    }
    const item = queue.shift();
    const value = typeof item === "function" ? (item as (r: unknown) => unknown)(request) : item;
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    calls,
    music: {
      composeDetailed: (req, opts) => take("composeDetailed", req, opts),
      compose: (req, opts) => take("compose", req, opts),
    },
    textToSoundEffects: {
      convert: (req, opts) => take("convert", req, opts),
    },
  };
}

export function elError(statusCode: number, body: unknown): ElevenLabsError {
  return new ElevenLabsError({ message: "Status code error", statusCode, body });
}

/** Помилка у формі, яку перекидає обгортка SDK для composeDetailed (тип втрачено). */
export function wrappedDetailedError(statusCode: number, body: unknown): Error {
  return new Error(`Failed to parse detailed composition response: ${elError(statusCode, body).message}`);
}

export const concurrencyBody = {
  detail: { status: "too_many_concurrent_requests", message: "Too many concurrent requests" },
};
export const busyBody = { detail: { status: "system_busy", message: "System is busy" } };

export function instantGate(maxConcurrent = 2): ElevenLabsGate & { sleeps: number[] } {
  const sleeps: number[] = [];
  const gate = new ElevenLabsGate({
    maxConcurrent,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  }) as ElevenLabsGate & { sleeps: number[] };
  gate.sleeps = sleeps;
  return gate;
}

/** Чернетка AudioPlan від «LLM» під заданий каркас чанків. */
export function draftFor(layout: ChunkLayout, overrides: Partial<AudioPlanDraft> = {}): AudioPlanDraft {
  return {
    compositionPlan: {
      positiveGlobalStyles: ["lo-fi hip hop", "warm", "85 BPM", "rhodes", "instrumental"],
      negativeGlobalStyles: ["vocals", "lyrics", "heavy distortion"],
      chunks: layout.chunks.map((c) => ({
        label: c.label,
        section: c.label,
        sceneIds: c.sceneIds,
        durationMs: c.durationMs,
        positiveStyles: [`${c.label} groove`, "soft drums"],
        negativeStyles: [],
        contextAdherence: "high" as const,
      })),
    },
    key: "A minor",
    promptFallback: "Warm lo-fi hip hop at 85 BPM with rhodes and soft drums, instrumental",
    sfx: [{ cue: "whoosh", text: "whoosh", durationSeconds: 0.6, custom: false }],
    ...overrides,
  };
}

export interface Setup {
  storage: LocalStorage;
  storyboard: Storyboard;
}

export async function seedProject(
  storage: LocalStorage,
  opts: { storyboard?: Storyboard; rev?: number; project?: Partial<ProjectState> } = {},
): Promise<void> {
  const paths = projectPaths(PROJECT_ID);
  const file: BrandKitFile = {
    ...fixtureBrandKit,
    contacts: { ...fixtureBrandKit.contacts, website: "https://zerno.example.com/" },
    version: 1,
    createdAt: "2026-10-06T10:00:00.000Z",
    origin: "llm",
    fixes: [],
  };
  await storage.writeJson(paths.brandkit(1), file);
  await storage.writeJson(paths.project, fixtureProject({ brandkitVersion: 1, ...opts.project }));
  await storage.writeJson(paths.rev(opts.rev ?? 1).storyboard, opts.storyboard ?? fixtureStoryboard);
}

export function makeCtx(
  storage: LocalStorage,
  replies: MockReply[],
  opts: { rev?: number; phase?: "first_delivery" | "revision" } = {},
): StageContext<"audio"> & { anthropic: ReturnType<typeof createMockAnthropic> } {
  const rev = opts.rev ?? 1;
  const phase = opts.phase ?? "first_delivery";
  const anthropic = createMockAnthropic(replies);
  const prompts = createPromptLoader();
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: PROJECT_ID,
    rev,
    stage: "audio",
    phase,
    source: "test",
    attempt: 1,
  });
  const trace = createNoopTracer();
  return {
    anthropic,
    projectId: PROJECT_ID,
    rev,
    stage: "audio",
    attempt: 1,
    jobId: "job-1",
    phase,
    source: "test",
    params: {},
    storage,
    trace,
    cost,
    emit: createMemoryEmitter(),
    llm: createLlm({ client: anthropic, prompts, cost, trace, sleep: async () => {} }),
    prompts,
    logger: noopLogger,
  };
}
