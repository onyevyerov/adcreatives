import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { projectLockKey } from "../src/index.ts";
import { createMemoryLock, createRedisLock, type ProjectLock } from "../src/lock.ts";

async function assertSerialized(lock: ProjectLock) {
  const log: string[] = [];
  const task = (name: string) =>
    lock.withLock(projectLockKey("p1"), async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 15));
      log.push(`${name}:end`);
      return name;
    });
  const results = await Promise.all([task("a"), task("b"), task("c")]);
  expect(results).toEqual(["a", "b", "c"]);
  for (let i = 0; i < log.length; i += 2) {
    expect(log[i]?.endsWith(":start")).toBe(true);
    expect(log[i + 1]).toBe(log[i]?.replace(":start", ":end"));
  }
}

describe("locks", () => {
  it("memory lock serializes work per key and releases on error", async () => {
    const lock = createMemoryLock();
    await assertSerialized(lock);
    await expect(lock.withLock("k", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lock.withLock("k", async () => 1)).resolves.toBe(1);
  });

  it("redis lock (SET NX PX + owner release) serializes work", async () => {
    const redis = new RedisMock();
    const lock = createRedisLock(redis as never, { ttlMs: 5_000, retryMs: 5 });
    await assertSerialized(lock);
    expect(await redis.get(projectLockKey("p1"))).toBeNull();
  });
});
