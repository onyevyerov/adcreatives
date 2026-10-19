import { createEmitter, eventsKey } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { intakeKey } from "../src/intake.ts";
import { readSse, seedUser, setup } from "./helpers.ts";

const PROJECT = "sseProject123";

async function seed() {
  const env = await setup();
  await env.storage.writeJson(intakeKey(PROJECT), { projectId: PROJECT, ownerId: env.user?.id });
  const emitter = createEmitter(env.redis, PROJECT);
  const ids = [
    await emitter.message("Сканую сайт"),
    await emitter.progress("crawl", "Сканую сайт… 7/25 сторінок", 7, 25),
    await emitter.emit({ type: "state", status: "crawling", prev: "intake", rev: 1 }),
  ];
  return { env, emitter, ids };
}

describe("GET /api/projects/:id/events (SSE)", () => {
  it("без Last-Event-ID віддає всю історію; id події = ID запису стріму", async () => {
    const { env, ids } = await seed();
    const res = await env.request(`/api/projects/${PROJECT}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res, (e) => e.length >= 3);
    expect(events.map((e) => e.id)).toEqual(ids);
    expect(events.map((e) => e.event)).toEqual(["message", "progress", "state"]);
    expect(JSON.parse(events[1]?.data ?? "{}")).toMatchObject({ type: "progress", done: 7, total: 25 });
  });

  it("з Last-Event-ID довантажує лише пропущене", async () => {
    const { env, ids } = await seed();
    const res = await env.request(`/api/projects/${PROJECT}/events`, {
      headers: { "Last-Event-ID": ids[0] as string },
    });
    const events = await readSse(res, (e) => e.length >= 2);
    expect(events.map((e) => e.id)).toEqual(ids.slice(1));
  });

  it("?lastEventId= (ручне перепідключення сторінки) працює так само", async () => {
    const { env, ids } = await seed();
    const res = await env.request(`/api/projects/${PROJECT}/events?lastEventId=${ids[1]}`);
    const events = await readSse(res, (e) => e.length >= 1);
    expect(events.map((e) => e.id)).toEqual([ids[2]]);
  });

  it("після історії стрімить нові події (XREAD), без дублів", async () => {
    const { env, emitter, ids } = await seed();
    const res = await env.request(`/api/projects/${PROJECT}/events`, {
      headers: { "Last-Event-ID": ids[2] as string },
    });
    let newId = "";
    setTimeout(() => {
      void emitter.emit({ type: "cost", totalUsd: 0.42, stage: "crawl", stageUsd: 0.1 }).then((id) => {
        newId = id;
      });
    }, 150);
    const events = await readSse(res, (e) => e.length >= 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("cost");
    expect(events[0]?.id).toBe(newId);
    expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({ totalUsd: 0.42 });
  });

  it("порожній стрім: нові події приходять після підключення; битий запис пропускається", async () => {
    const env = await setup();
    await env.storage.writeJson(intakeKey(PROJECT), { projectId: PROJECT, ownerId: env.user?.id });
    const res = await env.request(`/api/projects/${PROJECT}/events`);
    setTimeout(() => {
      void (async () => {
        await env.redis.xadd(eventsKey(PROJECT), "*", "data", "{broken");
        await createEmitter(env.redis, PROJECT).message("Привіт");
      })();
    }, 150);
    const events = await readSse(res, (e) => e.length >= 1);
    expect(events.map((e) => e.event)).toEqual(["message"]);
  });

  it("некоректний Last-Event-ID ігнорується → уся історія", async () => {
    const { env, ids } = await seed();
    const res = await env.request(`/api/projects/${PROJECT}/events`, {
      headers: { "Last-Event-ID": "garbage" },
    });
    const events = await readSse(res, (e) => e.length >= 3);
    expect(events.map((e) => e.id)).toEqual(ids);
  });

  it("неіснуючий проєкт → 404", async () => {
    const env = await setup();
    expect((await env.request("/api/projects/missing/events")).status).toBe(404);
  });

  it("чужий проєкт → та сама 404, анонім → 401; стрім не відкривається", async () => {
    const { env } = await seed();
    const other = await seedUser(env, { email: "other@example.com" });
    const foreign = await other.request(`/api/projects/${PROJECT}/events`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await (await other.request("/api/projects/missing/events")).json());
    expect((await env.app.request(`/api/projects/${PROJECT}/events`)).status).toBe(401);
  });
});
