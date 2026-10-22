import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import { appendEvent, createEmitter, eventsKey } from "../src/events/emit.ts";
import { compareStreamIds, lastEventId, readEvents } from "../src/events/stream.ts";
import { ChatEvent, StoryboardCheckpointPayload } from "../src/schemas/events.ts";

// ioredis-mock ділить дані між інстансами — кожен тест чистить базу.
const newRedis = async () => {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  return redis;
};

describe("events stream", () => {
  it("emit → read full history → resume after Last-Event-ID", async () => {
    const redis = await newRedis();
    const emitter = createEmitter(redis, "p1", () => new Date("2026-10-06T10:00:00.000Z"));
    const id1 = await emitter.message("Привіт", { buttons: ["approve"] });
    const id2 = await emitter.progress("crawl", "Сканую сайт… 7/25 сторінок", 7, 25);
    const id3 = await emitter.emit({ type: "state", status: "crawling", prev: "intake", rev: 1 });

    const all = await readEvents(redis, "p1");
    expect(all.map((e) => e.id)).toEqual([id1, id2, id3]);
    expect(all[0]?.event).toMatchObject({ type: "message", text: "Привіт", at: "2026-10-06T10:00:00.000Z" });
    expect(all[1]?.event).toMatchObject({ type: "progress", done: 7, total: 25 });

    const after = await readEvents(redis, "p1", { afterId: id1 });
    expect(after.map((e) => e.id)).toEqual([id2, id3]);
    expect(await readEvents(redis, "p1", { afterId: id3 })).toEqual([]);
    expect(await lastEventId(redis, "p1")).toBe(id3);
    expect(await lastEventId(redis, "empty")).toBe("0-0");
  });

  it("validates events and skips foreign entries", async () => {
    const redis = await newRedis();
    await expect(appendEvent(redis, "p1", { type: "nope" } as never)).rejects.toThrow();
    await redis.xadd(eventsKey("p1"), "*", "other", "x");
    await redis.xadd(eventsKey("p1"), "*", "data", "{broken");
    expect(await readEvents(redis, "p1")).toEqual([]);
  });

  it("compares stream ids numerically", () => {
    expect(compareStreamIds("10-0", "9-5")).toBeGreaterThan(0);
    expect(compareStreamIds("5-2", "5-10")).toBeLessThan(0);
    expect(compareStreamIds("5-2", "5-2")).toBe(0);
  });
});

describe("відео-превʼю ЧП3 (схеми)", () => {
  const at = "2026-10-22T10:00:00.000Z";

  it("PreviewEvent: ready з url і failed з null — через ChatEvent", () => {
    const ready = {
      type: "preview",
      at,
      rev: 2,
      format: "vertical",
      state: "ready",
      url: "/files/p1/rev/2/renders/vertical.mp4",
    };
    const failed = { type: "preview", at, rev: 2, format: "vertical", state: "failed", url: null };
    expect(ChatEvent.parse(ready)).toEqual(ready);
    expect(ChatEvent.parse(failed)).toEqual(failed);
    expect(ChatEvent.safeParse({ ...ready, state: "pending" }).success).toBe(false);
  });

  it("StoryboardCheckpointPayload: стара подія без timeline/preview і нова з ними — валідні", () => {
    const old = {
      checkpoint: "storyboard",
      primaryFormat: "vertical",
      stills: [],
      sheets: [],
      warnings: [],
      templateScenes: [],
      music: null,
      changedScenes: null,
    };
    expect(StoryboardCheckpointPayload.safeParse(old).success).toBe(true);
    const next = {
      ...old,
      timeline: [
        { sceneId: "s1", fromMs: 0, durationMs: 4000 },
        { sceneId: "s2", fromMs: 3500, durationMs: 5000 },
      ],
      preview: { format: "vertical" },
    };
    expect(StoryboardCheckpointPayload.parse(next)).toEqual(next);
    expect(StoryboardCheckpointPayload.safeParse({ ...old, timeline: [], preview: null }).success).toBe(true);
    expect(
      StoryboardCheckpointPayload.safeParse({
        ...old,
        timeline: [{ sceneId: "s1", fromMs: 0, durationMs: 0 }],
      }).success,
    ).toBe(false);
  });
});
