import {
  type Asset,
  AssetManifest,
  BrandKitFile,
  type CostStage,
  type Format,
  LlmError,
  type Logger,
  normalizeFormats,
  PipelineCounters,
  ProjectState,
  projectPaths,
  revPaths,
  type StageContext,
  StageError,
  type StillVariant,
  type Storage,
  Storyboard,
} from "@adc/shared";

/**
 * Читання артефактів проєкту і службові шляхи режисера.
 *
 * Власні артефакти режисера (не з контракту Кроку 0) лежать у `rev/<n>/director/`:
 * - `scenes.json` — журнал версій сцен (див. ledger.ts);
 * - `versions/<sceneId>/v<k>.tsx` і `versions/<sceneId>/v<k>/<format>-<a|b>.png` — код і стіли кожної версії;
 * - `storyboard.meta.json`, `codegen.json`, `check.meta.json`, `qa.meta.json` — хеші входів і звіти стадій;
 * - `revision.json` — RevisionPlan стадії `revise` з інструкціями для codegen;
 * - `raw/*.txt` — сирі відповіді моделі (для налагодження).
 */

const join = (...parts: Array<string | number>) => parts.map(String).join("/");

export function directorPaths(projectId: string, rev: number) {
  const root = join(revPaths(projectId, rev).root, "director");
  return {
    root,
    ledger: join(root, "scenes.json"),
    version: (sceneId: string, v: number) => join(root, "versions", sceneId, `v${v}.tsx`),
    versionStill: (sceneId: string, v: number, format: Format, variant: StillVariant) =>
      join(root, "versions", sceneId, `v${v}`, `${format}-${variant}.png`),
    storyboardMeta: join(root, "storyboard.meta.json"),
    codegen: join(root, "codegen.json"),
    checkMeta: join(root, "check.meta.json"),
    qaMeta: join(root, "qa.meta.json"),
    revision: join(root, "revision.json"),
    raw: (name: string) => join(root, "raw", `${name}.txt`),
  };
}
export type DirectorPaths = ReturnType<typeof directorPaths>;

export async function readOptional<T>(
  storage: Storage,
  key: string,
  parse: (v: unknown) => T,
  logger?: Logger,
): Promise<T | null> {
  if (!(await storage.exists(key))) return null;
  try {
    return await storage.readJson(key, parse);
  } catch (err) {
    logger?.warn("не вдалося прочитати артефакт", { key, err: String(err) });
    return null;
  }
}

export async function readProject(storage: Storage, projectId: string): Promise<ProjectState | null> {
  return readOptional(storage, projectPaths(projectId).project, (v) => ProjectState.parse(v));
}

/** Ревізія-основа (для пропуску за хешем входів і перенесення сцен); null — немає. */
export function baseRevOf(project: ProjectState | null, rev: number): number | null {
  const info = project?.revisions.find((r) => r.n === rev);
  if (info) return info.basedOn;
  return rev > 1 ? rev - 1 : null;
}

export function formatsOf(project: ProjectState | null): Format[] {
  const f = normalizeFormats(project?.formats ?? []);
  return f.length > 0 ? f : ["vertical"];
}

/** Поточна версія бренд-кіта: `project.brandkitVersion`, інакше найбільша `brandkit/v<k>.json`. */
export async function readCurrentBrandKit(
  storage: Storage,
  projectId: string,
  project: ProjectState | null,
): Promise<BrandKitFile> {
  const paths = projectPaths(projectId);
  let version = project?.brandkitVersion ?? null;
  if (version === null) {
    const versions = (await storage.list(paths.brandkitDir))
      .map((k) => /\/v(\d+)\.json$/.exec(k)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);
    version = versions.length > 0 ? Math.max(...versions) : null;
  }
  const file =
    version === null
      ? null
      : await readOptional(storage, paths.brandkit(version), (v) => BrandKitFile.parse(v));
  if (!file) {
    throw new StageError(
      `немає бренд-кіта проєкту ${projectId}`,
      "brandkit_missing",
      "Немає бренд-кіта — спершу його потрібно зібрати.",
      false,
    );
  }
  return file;
}

export async function readStoryboard(storage: Storage, projectId: string, rev: number): Promise<Storyboard> {
  const key = revPaths(projectId, rev).storyboard;
  const sb = await readOptional(storage, key, (v) => Storyboard.parse(v));
  if (!sb) {
    throw new StageError(
      `немає ${key}`,
      "storyboard_missing",
      "Немає сценарію для цієї версії ролика.",
      false,
    );
  }
  return sb;
}

export async function readAssets(storage: Storage, projectId: string): Promise<Asset[]> {
  const m = await readOptional(storage, projectPaths(projectId).assets, (v) => AssetManifest.parse(v));
  return m?.assets ?? [];
}

/** Сцени на TemplateScene (рішення оркестратора, `rev/<n>/pipeline.json`). */
export async function readTemplateScenes(
  storage: Storage,
  projectId: string,
  rev: number,
): Promise<string[]> {
  const c = await readOptional(storage, revPaths(projectId, rev).pipeline, (v) => PipelineCounters.parse(v));
  return c?.templateScenes ?? [];
}

/** LlmError → StageError з поясненням для чату. */
export function llmStageError(err: unknown, what: string): never {
  if (err instanceof LlmError) {
    const userMessage =
      err.code === "refusal"
        ? `Модель відмовилась виконати крок «${what}». Спробуйте переформулювати або повторіть.`
        : `Не вдалося виконати крок «${what}» — спробуйте ще раз.`;
    throw new StageError(err.message, `llm_${err.code}`, userMessage, err.code !== "refusal", { cause: err });
  }
  throw err;
}

/** Прогрес у чат; збій емітера не валить стадію. */
export async function progress(
  ctx: Pick<StageContext, "emit" | "logger">,
  stage: CostStage,
  label: string,
  done: number | null = null,
  total: number | null = null,
): Promise<void> {
  try {
    await ctx.emit.progress(stage, label, done, total);
  } catch (err) {
    ctx.logger.warn("не вдалося надіслати прогрес", { err: String(err) });
  }
}
