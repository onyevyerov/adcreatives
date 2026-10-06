import { AutoIssue, CheckReport, QaIssue, revPaths, type Storage, sha256 } from "@adc/shared";
import { z } from "zod";
import { directorPaths } from "./io.ts";

/**
 * Журнал версій сцен ревізії: `rev/<n>/director/scenes.json`.
 *
 * Кожен codegen/fix сцени дає нову версію `v<k>`: код зберігається в `versions/<sceneId>/v<k>.tsx`
 * (навіть якщо AST-guard його відхилив — щоб `fix` бачив, що саме виправляти). Поточна версія
 * з `guardOk` лежить ще й у `video/scenes/<sceneId>.tsx` (її бачить бандл).
 *
 * `check` дописує до версії свій результат і копію стілів (`versions/<id>/v<k>/<format>-<a|b>.png`),
 * `qa` — кількість серйозних зауважень. Так `qa` може повернути попередню версію сцени, якщо фікс
 * зробив гірше («для кожної сцени лишається версія з меншою кількістю серйозних зауважень»):
 * код, стіли, записи check.json і зауваження qa.json відновлюються з версії.
 */

export const SceneCheckData = z.object({
  compileErrors: CheckReport.shape.compileErrors,
  runtimeErrors: CheckReport.shape.runtimeErrors,
  autoIssues: z.array(AutoIssue),
  stills: CheckReport.shape.stills,
  checkedAt: z.string(),
});
export type SceneCheckData = z.infer<typeof SceneCheckData>;

export const SceneVersion = z.object({
  v: z.number().int().min(1),
  origin: z.enum(["codegen", "fix", "carry"]),
  createdAt: z.string(),
  /** sha256 коду; порожній рядок — модель не повернула файл. */
  codeHash: z.string(),
  missing: z.boolean(),
  guardOk: z.boolean(),
  violations: z.array(z.string()),
  /** Хеш входів codegen (для пропуску в наступній ревізії); null для fix. */
  inputsHash: z.string().nullable(),
  check: SceneCheckData.nullable(),
  qa: z.object({ serious: z.number().int(), issues: z.array(QaIssue) }).nullable(),
});
export type SceneVersion = z.infer<typeof SceneVersion>;

export const SceneEntry = z.object({
  current: z.number().int().min(1),
  versions: z.array(SceneVersion),
});
export type SceneEntry = z.infer<typeof SceneEntry>;

export const SceneLedger = z.object({ scenes: z.record(z.string(), SceneEntry) });
export type SceneLedger = z.infer<typeof SceneLedger>;

export async function readLedger(storage: Storage, projectId: string, rev: number): Promise<SceneLedger> {
  const key = directorPaths(projectId, rev).ledger;
  if (!(await storage.exists(key))) return { scenes: {} };
  return storage.readJson(key, (v) => SceneLedger.parse(v));
}

export async function writeLedger(
  storage: Storage,
  projectId: string,
  rev: number,
  ledger: SceneLedger,
): Promise<string> {
  const key = directorPaths(projectId, rev).ledger;
  await storage.writeJson(key, SceneLedger.parse(ledger));
  return key;
}

export function currentVersion(ledger: SceneLedger, sceneId: string): SceneVersion | null {
  const e = ledger.scenes[sceneId];
  return e?.versions.find((v) => v.v === e.current) ?? null;
}

/** Сцени, чия поточна версія не пройшла AST-guard (або порожня) — не йдуть у реєстр сцен. */
export function rejectedScenes(ledger: SceneLedger): string[] {
  return Object.keys(ledger.scenes).filter((id) => currentVersion(ledger, id)?.guardOk === false);
}

export interface NewVersion {
  origin: SceneVersion["origin"];
  code: string | null;
  guardOk: boolean;
  violations: string[];
  inputsHash?: string | null;
  check?: SceneCheckData | null;
  qa?: SceneVersion["qa"];
  now: Date;
}

/**
 * Додає версію сцени: пише код у `versions/`, а якщо guard пройдено — і в `video/scenes/<id>.tsx`.
 * Повертає номер версії і ключі записаних файлів.
 */
export async function addVersion(
  storage: Storage,
  projectId: string,
  rev: number,
  ledger: SceneLedger,
  sceneId: string,
  nv: NewVersion,
): Promise<{ v: number; written: string[] }> {
  const entry = ledger.scenes[sceneId] ?? { current: 1, versions: [] };
  ledger.scenes[sceneId] = entry;
  const v = Math.max(0, ...entry.versions.map((x) => x.v)) + 1;
  const written: string[] = [];
  const dp = directorPaths(projectId, rev);
  if (nv.code !== null) {
    await storage.write(dp.version(sceneId, v), nv.code);
    written.push(dp.version(sceneId, v));
    if (nv.guardOk) {
      const key = revPaths(projectId, rev).scene(sceneId);
      await storage.write(key, nv.code);
      written.push(key);
    }
  }
  entry.versions.push({
    v,
    origin: nv.origin,
    createdAt: nv.now.toISOString(),
    codeHash: nv.code === null ? "" : sha256(nv.code),
    missing: nv.code === null,
    guardOk: nv.code !== null && nv.guardOk,
    violations: nv.violations,
    inputsHash: nv.inputsHash ?? null,
    check: nv.check ?? null,
    qa: nv.qa ?? null,
  });
  entry.current = v;
  return { v, written };
}

/**
 * Переносить у ревізію `rev` поточний код сцени з ревізії-основи `base` (без генерації) як нову
 * версію `carry`. Повертає записані ключі (порожньо — в основі немає придатного коду).
 */
export async function carryScene(
  storage: Storage,
  projectId: string,
  rev: number,
  base: number,
  ledger: SceneLedger,
  baseLedger: SceneLedger,
  sceneId: string,
  now: Date,
  inputsHashValue: string | null,
): Promise<string[]> {
  const baseVer = currentVersion(baseLedger, sceneId);
  if (baseVer && !baseVer.guardOk) return [];
  const code = await readCurrentCode(storage, projectId, base, baseLedger, sceneId);
  if (code === null) return [];
  const { written } = await addVersion(storage, projectId, rev, ledger, sceneId, {
    origin: "carry",
    code,
    guardOk: true,
    violations: [],
    inputsHash: inputsHashValue ?? baseVer?.inputsHash ?? null,
    now,
  });
  return written;
}

/** Код поточної версії сцени (з `versions/`, а для сцен без журналу — з `video/scenes/`). */
export async function readCurrentCode(
  storage: Storage,
  projectId: string,
  rev: number,
  ledger: SceneLedger,
  sceneId: string,
): Promise<string | null> {
  const cur = currentVersion(ledger, sceneId);
  if (cur) {
    if (cur.missing) return null;
    const key = directorPaths(projectId, rev).version(sceneId, cur.v);
    if (await storage.exists(key)) return storage.readText(key);
  }
  const key = revPaths(projectId, rev).scene(sceneId);
  return (await storage.exists(key)) ? storage.readText(key) : null;
}
