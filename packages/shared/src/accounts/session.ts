import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { sha256 } from "../storage/hash.ts";

/** TTL сесії за замовчуванням — 30 діб (ковзний). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionStore {
  /** token = randomBytes(32).toString("base64url"). */
  create(userId: string): Promise<string>;
  /** Ковзний TTL (PEXPIRE при зверненні). */
  resolve(token: string): Promise<string | null>;
  destroy(token: string): Promise<void>;
  /** Через set `sessions:user:<id>`. */
  destroyAll(userId: string): Promise<void>;
}

const newToken = () => randomBytes(32).toString("base64url");
const sessionKey = (sha: string) => `session:${sha}`;
const userSessionsKey = (userId: string) => `sessions:user:${userId}`;

/** Ключ `session:<sha256(token)>` → userId; у Redis лише хеші токенів. */
export function createSessionStore(redis: Redis, opts: { ttlMs?: number } = {}): SessionStore {
  const ttl = opts.ttlMs ?? SESSION_TTL_MS;
  return {
    async create(userId) {
      const token = newToken();
      const sha = sha256(token);
      await redis.set(sessionKey(sha), userId, "PX", ttl);
      await redis.sadd(userSessionsKey(userId), sha);
      await redis.pexpire(userSessionsKey(userId), ttl);
      return token;
    },
    async resolve(token) {
      if (!token) return null;
      const key = sessionKey(sha256(token));
      const userId = await redis.get(key);
      if (userId === null) return null;
      await redis.pexpire(key, ttl);
      await redis.pexpire(userSessionsKey(userId), ttl);
      return userId;
    },
    async destroy(token) {
      if (!token) return;
      const sha = sha256(token);
      const userId = await redis.getdel(sessionKey(sha));
      if (userId !== null) await redis.srem(userSessionsKey(userId), sha);
    },
    async destroyAll(userId) {
      const shas = await redis.smembers(userSessionsKey(userId));
      if (shas.length > 0) await redis.del(...shas.map(sessionKey));
      await redis.del(userSessionsKey(userId));
    },
  };
}

export type TokenKind = "activate" | "reset";

export interface TokenStore {
  issue(kind: TokenKind, userId: string, ttlMs: number): Promise<string>;
  /** GETDEL — одноразовий. */
  consume(kind: TokenKind, token: string): Promise<string | null>;
}

const tokenKey = (kind: TokenKind, token: string) => `token:${kind}:${sha256(token)}`;

/** Одноразові токени активації/скидання: ключ `token:<kind>:<sha256(token)>` → userId з TTL. */
export function createTokenStore(redis: Redis): TokenStore {
  return {
    async issue(kind, userId, ttlMs) {
      const token = newToken();
      await redis.set(tokenKey(kind, token), userId, "PX", ttlMs);
      return token;
    },
    async consume(kind, token) {
      if (!token) return null;
      return redis.getdel(tokenKey(kind, token));
    },
  };
}
