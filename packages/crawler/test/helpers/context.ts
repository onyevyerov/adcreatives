import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMemoryEmitter,
  createTracer,
  LocalStorage,
  noopLogger,
  type StageContext,
  type StageName,
  type StageParamsMap,
} from "@adc/shared";

export const tmpStorage = (): LocalStorage =>
  new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-crawler-")));

/** Контекст стадії для тестів: тимчасове сховище, події в пам'яті, справжній трейс. */
export function makeContext<S extends StageName>(
  stage: S,
  params: StageParamsMap[S],
  opts: { storage?: LocalStorage; projectId?: string } = {},
) {
  const storage = opts.storage ?? tmpStorage();
  const projectId = opts.projectId ?? "p1";
  const emit = createMemoryEmitter();
  const unused = () => {
    throw new Error("не використовується краулером");
  };
  const ctx = {
    projectId,
    rev: 1,
    stage,
    attempt: 1,
    jobId: `${projectId}.${stage}.r1.a1`,
    phase: "first_delivery",
    source: "test",
    params,
    storage,
    trace: createTracer(storage, projectId),
    cost: { record: unused } as unknown as StageContext<S>["cost"],
    emit,
    llm: {} as StageContext<S>["llm"],
    prompts: {} as StageContext<S>["prompts"],
    logger: noopLogger,
  } satisfies StageContext<S>;
  return { ctx, storage, emit };
}
