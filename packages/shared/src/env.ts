import { existsSync } from "node:fs";
import path from "node:path";

/** Корінь репозиторію: тека з pnpm-workspace.yaml вище за `from` (або env REPO_ROOT). */
export function findRepoRoot(from: string = process.cwd()): string {
  if (process.env.REPO_ROOT) return path.resolve(process.env.REPO_ROOT);
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`не знайдено корінь репозиторію від ${from}`);
    dir = parent;
  }
}

/** Ціль вартості відео (лише позначка в статистиці). */
export function costTargetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.COST_TARGET_USD);
  return Number.isFinite(v) && v > 0 ? v : 3.5;
}

/** Чи дозволені живі виклики зовнішніх API. */
export function isLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE === "1";
}

/** Підвантажує кореневий `.env` (якщо є) у process.env; наявні змінні не перезаписує. */
export function loadRootEnv(root: string = findRepoRoot()): void {
  const file = path.join(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** DATA_DIR: відносний шлях рахується від кореня репозиторію (worktree), дефолт `.data`. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(findRepoRoot(), env.DATA_DIR || ".data");
}
