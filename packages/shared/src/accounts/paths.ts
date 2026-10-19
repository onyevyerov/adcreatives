import { sha256 } from "../storage/hash.ts";
import { Email } from "./schemas.ts";

/**
 * Ключі акаунтів у сховищі (відносно DATA_DIR):
 *
 * - `users/<id>/user.json` — User
 * - `users/<id>/ledger.jsonl` — LedgerEntry по рядку (append ≤ 4 КБ, як costs.jsonl)
 * - `users/<id>/projects.jsonl` — `{projectId, createdAt}`, індекс для `GET /api/projects`
 * - `users/<id>/topups/<topupId>.json` — TopUp
 * - `users-by-email/<sha256(email)>.json` — `{userId}` (окрема тека, щоб `listDirs("users")` бачив лише користувачів)
 * - `outbox/<ts>-<id>.json` — OutboxMail
 */

const join = (...parts: string[]): string => parts.join("/");

export const USERS_DIR = "users";
export const EMAIL_INDEX_DIR = "users-by-email";

export const accountPaths = {
  user: (id: string) => join(USERS_DIR, id, "user.json"),
  ledger: (id: string) => join(USERS_DIR, id, "ledger.jsonl"),
  projects: (id: string) => join(USERS_DIR, id, "projects.jsonl"),
  topupsDir: (id: string) => join(USERS_DIR, id, "topups"),
  topup: (id: string, topupId: string) => join(USERS_DIR, id, "topups", `${topupId}.json`),
  emailIndex: (sha: string) => join(EMAIL_INDEX_DIR, `${sha}.json`),
  outboxDir: "outbox",
};

export const userLockKey = (id: string) => `lock:user:${id}`;
export const emailLockKey = (sha: string) => `lock:email:${sha}`;

/** sha256 нормалізованого e-mail (trim + lowercase); кидає ZodError на невалідну адресу. */
export const emailHash = (email: string): string => sha256(Email.parse(email));
