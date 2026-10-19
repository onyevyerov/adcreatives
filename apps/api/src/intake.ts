import {
  IntakeFile,
  PROJECTS_DIR,
  ProjectState,
  type PublicUser,
  projectPaths,
  type Storage,
} from "@adc/shared";
import { z } from "zod";

export { IntakeFile } from "@adc/shared";

export const intakeKey = (projectId: string) => projectPaths(projectId).intake;

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

const OwnerOnly = z.object({ ownerId: z.string().optional() });

/**
 * Власник проєкту: `ownerId` з `project.json`, якщо його там немає — з `intake.json`.
 * Жодного файлу (або `ownerId` немає в обох) → null. Читає лише поле `ownerId`, тож
 * неповний чи старий файл не «губить» власника.
 */
export async function projectOwner(storage: Storage, projectId: string): Promise<string | null> {
  if (!isProjectId(projectId)) return null;
  for (const key of [projectPaths(projectId).project, intakeKey(projectId)]) {
    const owner = await readOptionalJson(storage, key, (v) => OwnerOnly.parse(v));
    if (owner?.ownerId) return owner.ownerId;
  }
  return null;
}

/** Хто бачить проєкт: admin — усе; користувач — лише проєкти зі своїм `ownerId` (безхазяйні — ні). */
export function canSee(
  user: Pick<PublicUser, "id" | "isAdmin">,
  ownerId: string | null | undefined,
): boolean {
  return user.isAdmin || (ownerId !== undefined && ownerId !== null && ownerId === user.id);
}
