import {
  type AccountStore,
  type CostEvent,
  type LedgerEntry,
  type ProjectStatus,
  readCosts,
  type Storage,
  type User,
} from "@adc/shared";
import { listProjectIds, readIntake, readProject } from "../intake.ts";

/**
 * B1 · Знімок даних для вкладки «Використання»: один повний прохід по `projects/*`, спільних витратах і
 * акаунтах. Двигун (`engine.ts`) рахує все чистими функціями над знімком; знімок не залежить від
 * параметрів запиту й мемоізується на `SNAPSHOT_TTL_MS`.
 */

/** Скільки живе знімок у пам'яті (дані можуть відставати на стільки ж). */
export const SNAPSHOT_TTL_MS = 15_000;

/** Мета проєкту з `project.json`, інакше з `intake.json` (тоді `status: "intake"`). */
export interface ProjectMeta {
  /** Як записано у файлі; чи існує такий користувач — вирішує двигун. */
  ownerId: string | null;
  status: ProjectStatus;
  /** `input.url` для `kind: "site"`; manual — null. */
  url: string | null;
  /** Хост `url`; manual або нерозбірний URL — null. */
  host: string | null;
  createdAt: string;
  firstDeliveredAt: string | null;
}

export interface SnapshotProject {
  id: string;
  /** null — ні `project.json`, ні `intake.json` не прочитано; гроші все одно рахуються. */
  meta: ProjectMeta | null;
  events: CostEvent[];
}

export interface UsageSnapshot {
  projects: SnapshotProject[];
  /** `costs-shared.jsonl`. */
  shared: CostEvent[];
  users: User[];
  /** userId → увесь леджер (порядок не важливий). */
  ledgers: Map<string, LedgerEntry[]>;
}

export interface SnapshotDeps {
  storage: Storage;
  accounts: AccountStore;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function metaOf(
  input: { kind: "site" | "manual"; url: string | null },
  rest: Omit<ProjectMeta, "url" | "host">,
): ProjectMeta {
  const url = input.kind === "site" ? input.url : null;
  return { ...rest, url, host: hostOf(url) };
}

async function readMeta(storage: Storage, id: string): Promise<ProjectMeta | null> {
  const project = await readProject(storage, id);
  if (project)
    return metaOf(project.input, {
      ownerId: project.ownerId ?? null,
      status: project.status,
      createdAt: project.createdAt,
      firstDeliveredAt: project.firstDeliveredAt,
    });
  const intake = await readIntake(storage, id);
  if (intake)
    return metaOf(intake.input, {
      ownerId: intake.ownerId ?? null,
      status: "intake",
      createdAt: intake.createdAt,
      firstDeliveredAt: null,
    });
  return null;
}

/** Один прохід по сховищу: проєкти (мета + `costs.jsonl`), `costs-shared.jsonl`, користувачі й леджери. */
export async function collectSnapshot(deps: SnapshotDeps): Promise<UsageSnapshot> {
  const { storage, accounts } = deps;
  const [projects, shared, users] = await Promise.all([
    listProjectIds(storage).then((ids) =>
      Promise.all(
        ids.map(async (id): Promise<SnapshotProject> => {
          const [meta, events] = await Promise.all([readMeta(storage, id), readCosts(storage, id)]);
          return { id, meta, events };
        }),
      ),
    ),
    readCosts(storage, null),
    accounts.listUsers(),
  ]);
  const ledgers = new Map(
    await Promise.all(users.map(async (u) => [u.id, await accounts.readLedger(u.id)] as const)),
  );
  return { projects, shared, users, ledgers };
}

/**
 * Мемоізований `collectSnapshot`: один знімок на всі запити протягом `ttlMs` від `now()` початку збору.
 * Паралельні виклики під час збору чекають той самий проміс; невдалий збір не кешується.
 */
export function createSnapshotCache(
  deps: SnapshotDeps & { now?: () => Date },
  ttlMs = SNAPSHOT_TTL_MS,
): () => Promise<UsageSnapshot> {
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; promise: Promise<UsageSnapshot>; settled: boolean } | null = null;
  return () => {
    const t = now().getTime();
    if (cached && (!cached.settled || t - cached.at < ttlMs)) return cached.promise;
    const entry = { at: t, settled: false, promise: collectSnapshot(deps) };
    cached = entry;
    entry.promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (cached === entry) cached = null;
      },
    );
    return entry.promise;
  };
}
