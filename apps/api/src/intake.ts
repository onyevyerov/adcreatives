import { IsoDate, PROJECTS_DIR, ProjectState, projectPaths, RunSource, type Storage } from "@adc/shared";
import { z } from "zod";

/**
 * `projects/<id>/intake.json` — вхідні дані нового проєкту, які пише API перед командою `start`.
 *
 * Команда `start` у `PipelineCommand` не має полів, а `project.json` пише лише оркестратор,
 * тому URL, текст і фото клієнта передаються файлом: оркестратор на `start` читає цей файл,
 * створює `project.json` (`input` = `intake.input`, `origin` = `intake.origin`) і ставить
 * `crawl` з `{url, manualText}` та, якщо `photos` не порожній, `ingest` з `{files: photos}`.
 * Файл пишеться один раз і далі не змінюється.
 *
 * TODO(shared): перенести схему в `packages/shared/src/schemas/project.ts`, а ключ —
 * у `projectPaths(id).intake` (див. звіт B6).
 */
export const IntakeFile = z.object({
  projectId: z.string(),
  createdAt: IsoDate,
  origin: RunSource,
  /** Та сама форма, що й `ProjectState.input`. */
  input: ProjectState.shape.input,
  /** Ключі сховища завантажених фото: `projects/<id>/uploads/<file>`. */
  photos: z.array(z.string()),
  /** commandId команди `start`, поставленої разом із цим файлом. */
  startCommandId: z.string(),
});
export type IntakeFile = z.infer<typeof IntakeFile>;

export const intakeKey = (projectId: string) => `${projectPaths(projectId).root}/intake.json`;

/** ID проєкту в URL: nanoid (21 символ) або ID з eval/тестів — лише безпечні символи. */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isProjectId(id: string): boolean {
  return PROJECT_ID_RE.test(id);
}

export async function readOptionalJson<T>(
  storage: Storage,
  key: string,
  parse: (v: unknown) => T,
): Promise<T | null> {
  try {
    if (!(await storage.exists(key))) return null;
    return await storage.readJson(key, parse);
  } catch {
    return null;
  }
}

export async function readProject(storage: Storage, projectId: string): Promise<ProjectState | null> {
  return readOptionalJson(storage, projectPaths(projectId).project, (v) => ProjectState.parse(v));
}

export async function readIntake(storage: Storage, projectId: string): Promise<IntakeFile | null> {
  return readOptionalJson(storage, intakeKey(projectId), (v) => IntakeFile.parse(v));
}

/** Проєкт існує, якщо є `project.json` (оркестратор уже обробив start) або `intake.json`. */
export async function projectExists(storage: Storage, projectId: string): Promise<boolean> {
  if (!isProjectId(projectId)) return false;
  const paths = projectPaths(projectId);
  return (await storage.exists(paths.project)) || (await storage.exists(intakeKey(projectId)));
}

export async function listProjectIds(storage: Storage): Promise<string[]> {
  return (await storage.listDirs(PROJECTS_DIR)).filter(isProjectId);
}
