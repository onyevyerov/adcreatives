import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

/** Блокування проєкту: усе читання-зміна-запис `project.json` — під ним. */
export interface ProjectLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
}

/** In-memory блокування (тести, eval в одному процесі): черга промісів на ключ. */
export function createMemoryLock(): ProjectLock {
  const tails = new Map<string, Promise<unknown>>();
  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const tail = prev.then(() => gate);
      tails.set(key, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

export interface RedisLockOptions {
  /** TTL ключа блокування (страховка від падіння процесу), мс. Продовжується, поки fn працює. */
  ttlMs?: number;
  /** Скільки чекати на звільнення, мс. */
  waitMs?: number;
  /** Пауза між спробами, мс. */
  retryMs?: number;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const EXTEND_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/**
 * Redis-блокування `lock:project:<id>`: SET NX PX з випадковим токеном, продовження TTL
 * під час роботи, звільнення Lua-скриптом лише власником.
 */
export function createRedisLock(redis: Redis, opts: RedisLockOptions = {}): ProjectLock {
  const ttl = opts.ttlMs ?? 60_000;
  const wait = opts.waitMs ?? 120_000;
  const retry = opts.retryMs ?? 50;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const token = randomUUID();
      const deadline = Date.now() + wait;
      for (;;) {
        const ok = await redis.set(key, token, "PX", ttl, "NX");
        if (ok === "OK") break;
        if (Date.now() > deadline) throw new LockTimeoutError(`не вдалося взяти блокування ${key}`);
        await sleep(retry);
      }
      const timer = setInterval(
        () => {
          redis.eval(EXTEND_SCRIPT, 1, key, token, String(ttl)).catch(() => {});
        },
        Math.max(1000, Math.floor(ttl / 3)),
      );
      timer.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => {});
      }
    },
  };
}
