import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ProjectLock } from "../lock.ts";
import type { Storage } from "../storage/Storage.ts";
import { NotFoundInStorageError } from "../storage/Storage.ts";
import { hashPassword } from "./password.ts";
import { accountPaths, emailHash, emailLockKey, USERS_DIR, userLockKey } from "./paths.ts";
import { Email, LedgerEntry, type LedgerKind, TopUp, User, UserId } from "./schemas.ts";

/** Списання більше за баланс. `required` — скільки треба, `available` — скільки є. */
export class InsufficientCreditsError extends Error {
  override name = "InsufficientCreditsError";
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super(`не вистачає кредитів: потрібно ${required}, є ${available}`);
  }
}

export class EmailTakenError extends Error {
  override name = "EmailTakenError";
  constructor() {
    super("e-mail уже зареєстровано");
  }
}

export interface LedgerInput {
  id: string;
  kind: LedgerKind;
  credits: number;
  ref?: LedgerEntry["ref"];
  note?: string;
}

export interface AccountStore {
  /** Під `lock:email`; зайнятий e-mail → `EmailTakenError`. */
  createUser(input: { email: string; name: string; password: string }): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  /** Під `lock:user`. */
  updateUser(id: string, patch: Partial<Pick<User, "name" | "passwordHash" | "activatedAt">>): Promise<User>;
  /** Сума леджера; биті рядки пропускаються, як у `readCosts`. */
  balance(userId: string): Promise<number>;
  /** Новіші першими; `before` — id запису, після якого (в бік старіших) почати. */
  readLedger(userId: string, opts?: { limit?: number; before?: string }): Promise<LedgerEntry[]>;
  /**
   * Під lock:user. Дубль id → наявний запис, applied=false (ідемпотентність).
   * credits < 0 при balance + credits < 0 → InsufficientCreditsError(required = -credits, available = balance).
   * Інакше append {…, at, balanceAfter}.
   */
  apply(userId: string, entry: LedgerInput): Promise<{ entry: LedgerEntry; applied: boolean }>;
  addProject(userId: string, projectId: string, createdAt: string): Promise<void>;
  /** Новіші першими. */
  listProjectIds(userId: string): Promise<string[]>;
  /** Статус `pending`. */
  createTopUp(t: Omit<TopUp, "status" | "createdAt" | "paidAt">): Promise<TopUp>;
  getTopUp(userId: string, id: string): Promise<TopUp | null>;
  /** Новіші першими. */
  listTopUps(userId: string): Promise<TopUp[]>;
  /** Під lock:user: pending → paid|failed рівно один раз; paid → apply({id: `topup:${id}`, kind: "topup"}); повтор — повертає наявний стан. */
  settleTopUp(userId: string, id: string, outcome: "paid" | "failed"): Promise<TopUp>;
}

/** Максимальний розмір рядка леджера: append до 4 КБ атомарний на POSIX (як costs.jsonl). */
export const MAX_LEDGER_LINE_BYTES = 4096;

/** `users-by-email/<sha>.json`. */
const EmailIndexFile = z.object({ userId: UserId });
/** Рядок `users/<id>/projects.jsonl`. */
const ProjectIndexLine = z.object({ projectId: z.string().min(1), createdAt: z.string() });
/** Сегмент ключа сховища (id топапу): без `/`, `..` і службових символів. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,120}$/;

const defaultIdGen = () => `u_${randomBytes(12).toString("base64url")}`;

/** Рядки JSONL, що пройшли схему; биті пропускаються. */
async function readJsonl<T>(storage: Storage, key: string, parse: (v: unknown) => T | null): Promise<T[]> {
  if (!(await storage.exists(key))) return [];
  const out: T[] = [];
  for (const line of (await storage.readText(key)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = parse(JSON.parse(line));
      if (v !== null) out.push(v);
    } catch {
      // пропускаємо битий рядок
    }
  }
  return out;
}

export function createAccountStore(deps: {
  storage: Storage;
  lock: ProjectLock;
  now?: () => Date;
  idGen?: () => string;
}): AccountStore {
  const { storage, lock } = deps;
  const now = deps.now ?? (() => new Date());
  const idGen = deps.idGen ?? defaultIdGen;

  const readEntries = (userId: string) =>
    readJsonl(storage, accountPaths.ledger(userId), (v) => {
      const r = LedgerEntry.safeParse(v);
      return r.success ? r.data : null;
    });
  const sum = (entries: LedgerEntry[]) => entries.reduce((acc, e) => acc + e.credits, 0);

  async function getUser(id: string): Promise<User | null> {
    if (!UserId.safeParse(id).success) return null;
    const key = accountPaths.user(id);
    if (!(await storage.exists(key))) return null;
    return storage.readJson(key, User.parse);
  }

  async function getTopUp(userId: string, id: string): Promise<TopUp | null> {
    if (!UserId.safeParse(userId).success || !SAFE_SEGMENT.test(id)) return null;
    const key = accountPaths.topup(userId, id);
    if (!(await storage.exists(key))) return null;
    const topup = await storage.readJson(key, TopUp.parse);
    return topup.userId === userId ? topup : null;
  }

  /** Тіло `apply` без блокування — для викликів, що вже тримають `lock:user`. */
  async function applyUnlocked(
    userId: string,
    input: LedgerInput,
  ): Promise<{ entry: LedgerEntry; applied: boolean }> {
    const entries = await readEntries(userId);
    const existing = entries.find((e) => e.id === input.id);
    if (existing) return { entry: existing, applied: false };
    const balance = sum(entries);
    if (input.credits < 0 && balance + input.credits < 0)
      throw new InsufficientCreditsError(-input.credits, balance);
    const entry = LedgerEntry.parse({
      id: input.id,
      userId,
      at: now().toISOString(),
      kind: input.kind,
      credits: input.credits,
      balanceAfter: balance + input.credits,
      ref: input.ref ?? {},
      note: input.note ?? "",
    });
    let line = JSON.stringify(entry);
    if (Buffer.byteLength(line) > MAX_LEDGER_LINE_BYTES) line = JSON.stringify({ ...entry, note: "" });
    await storage.append(accountPaths.ledger(userId), line);
    return { entry, applied: true };
  }

  async function requireUser(id: string): Promise<User> {
    const user = await getUser(id);
    if (!user) throw new NotFoundInStorageError(accountPaths.user(id));
    return user;
  }

  return {
    async createUser(input) {
      const email = Email.parse(input.email);
      const sha = emailHash(email);
      return lock.withLock(emailLockKey(sha), async () => {
        if (await storage.exists(accountPaths.emailIndex(sha))) throw new EmailTakenError();
        const user = User.parse({
          id: idGen(),
          email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          createdAt: now().toISOString(),
          activatedAt: null,
        });
        await storage.writeJson(accountPaths.user(user.id), user);
        // Індекс — останнім: без нього e-mail вважається вільним, а сирота user.json нічого не ламає.
        await storage.writeJson(accountPaths.emailIndex(sha), { userId: user.id });
        return user;
      });
    },

    async findByEmail(email) {
      const parsed = Email.safeParse(email);
      if (!parsed.success) return null;
      const key = accountPaths.emailIndex(emailHash(parsed.data));
      if (!(await storage.exists(key))) return null;
      const { userId } = await storage.readJson(key, EmailIndexFile.parse);
      return getUser(userId);
    },

    getUser,

    async listUsers() {
      const users = await Promise.all((await storage.listDirs(USERS_DIR)).map((id) => getUser(id)));
      return users.filter((u): u is User => u !== null);
    },

    async updateUser(id, patch) {
      return lock.withLock(userLockKey(id), async () => {
        const user = await requireUser(id);
        const next = User.parse({ ...user, ...patch, id: user.id, email: user.email });
        await storage.writeJson(accountPaths.user(id), next);
        return next;
      });
    },

    async balance(userId) {
      return sum(await readEntries(userId));
    },

    async readLedger(userId, opts = {}) {
      let entries = (await readEntries(userId)).reverse();
      if (opts.before !== undefined) {
        const idx = entries.findIndex((e) => e.id === opts.before);
        entries = idx < 0 ? [] : entries.slice(idx + 1);
      }
      return opts.limit !== undefined ? entries.slice(0, Math.max(0, opts.limit)) : entries;
    },

    async apply(userId, entry) {
      if (!Number.isInteger(entry.credits)) throw new TypeError("credits має бути цілим");
      return lock.withLock(userLockKey(userId), () => applyUnlocked(userId, entry));
    },

    async addProject(userId, projectId, createdAt) {
      await storage.append(accountPaths.projects(userId), JSON.stringify({ projectId, createdAt }));
    },

    async listProjectIds(userId) {
      const lines = await readJsonl(storage, accountPaths.projects(userId), (v) => {
        const r = ProjectIndexLine.safeParse(v);
        return r.success ? r.data.projectId : null;
      });
      return [...new Set(lines.reverse())];
    },

    async createTopUp(t) {
      if (!SAFE_SEGMENT.test(t.id)) throw new TypeError(`недопустимий id поповнення: ${t.id}`);
      const topup = TopUp.parse({ ...t, status: "pending", createdAt: now().toISOString(), paidAt: null });
      await storage.writeJson(accountPaths.topup(topup.userId, topup.id), topup);
      return topup;
    },

    getTopUp,

    async listTopUps(userId) {
      if (!UserId.safeParse(userId).success) return [];
      const keys = (await storage.list(accountPaths.topupsDir(userId))).filter((k) => k.endsWith(".json"));
      const all = await Promise.all(
        keys.map(async (k) => {
          const r = TopUp.safeParse(await storage.readJson(k).catch(() => null));
          return r.success && r.data.userId === userId ? r.data : null;
        }),
      );
      return all
        .filter((t): t is TopUp => t !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },

    async settleTopUp(userId, id, outcome) {
      return lock.withLock(userLockKey(userId), async () => {
        const topup = await getTopUp(userId, id);
        if (!topup) throw new NotFoundInStorageError(accountPaths.topup(userId, id));
        if (topup.status !== "pending") return topup;
        const settled: TopUp = {
          ...topup,
          status: outcome,
          paidAt: outcome === "paid" ? now().toISOString() : null,
        };
        // Спершу леджер (ідемпотентний за ключем), потім статус: збій між ними лікується повтором.
        if (outcome === "paid")
          await applyUnlocked(userId, {
            id: `topup:${id}`,
            kind: "topup",
            credits: topup.credits,
            ref: { topupId: id },
            note: "Поповнення",
          });
        await storage.writeJson(accountPaths.topup(userId, id), settled);
        return settled;
      });
    },
  };
}
